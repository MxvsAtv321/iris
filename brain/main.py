"""Iris brain: watch loop, /api/ask, /api/ws, sessions, voice.  Run: uvicorn main:app --port 8000"""
import asyncio
import inspect
import io
import json
import logging
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from itertools import count
from pathlib import Path

from fastapi import FastAPI, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse
from PIL import Image
from pydantic import BaseModel

import gate
import llm  # loads .env
import prompts
import voice

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("iris")

CAMERA = os.getenv("CAMERA_URL") or "http://172.20.10.4"
HUD = os.getenv("HUD_URL") or "http://172.20.10.6"
PORT = int(os.getenv("PORT") or 8000)
TICK_S, BACKOFF_S = 2, 5       # capture cadence; slower after 3 errors in a row
LOOP_GAP_S = 6                 # at most one loop model call per 6 s (<=10 RPM, rest kept for questions)
CHANGE_THRESHOLD = 12          # mean abs grey-level diff (0-255) on a 32x24 thumbnail; calibrate on site
ASK_TIMEOUT_S = 5
WATCH_TIMEOUT_S = 12           # per model; the loop can wait, a reasoning watch model may need it
FALLBACK = "Didn't catch that, try again"
HERE = Path(__file__).resolve().parent
STATE = HERE / "state.json"
BAKEOFF = HERE / "bakeoff" / "results.json"

http = llm.http
clients = set()
gates = defaultdict(gate.Gate)
latencies = deque(maxlen=50)   # (total_ms, first_word_ms)
spoken = deque(maxlen=20)      # (ts, text) sent to TTS, for the echo filter
frame = {"jpeg": b"", "ts": 0.0}
watch = {"ref": None, "box": None, "last_call": -1e9}
frame_ids, ask_ids = count(1), count(1)
background = set()


# ---------- state ----------

def load_state():
    try:
        s = json.loads(STATE.read_text())
    except (OSError, ValueError):
        s = {}
    s.setdefault("active", None)
    s.setdefault("last_session", None)
    s.setdefault("sessions", {})
    llm.usage.update(s.get("usage") or {})
    s["usage"] = llm.usage
    return s


def save_state():
    try:
        tmp = STATE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=1))
        os.replace(tmp, STATE)
    except OSError as e:
        log.warning("state not saved: %s", e)


state = load_state()


def session(sid):
    return state["sessions"].setdefault(sid, {"descriptions": [], "said": [], "earlier": []})


def note(lst, line, keep=20):
    lst.append(datetime.now().strftime("%H:%M ") + line)
    del lst[:-keep]


# ---------- plumbing ----------

def bg(coro):
    t = asyncio.create_task(coro)
    background.add(t)
    t.add_done_callback(background.discard)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


async def emit(kind, sid, **fields):
    msg = {"type": kind, "session_id": sid, "at": now_iso(), **fields}
    for ws in list(clients):
        try:
            await asyncio.wait_for(ws.send_json(msg), 1)
        except Exception:  # noqa: BLE001 - a dead socket must not stall the brain
            clients.discard(ws)


camera_lock = asyncio.Lock()   # the ESP32 serves one request at a time


async def capture():
    async with camera_lock:
        r = await http.get(CAMERA + "/capture", timeout=1.5)
    r.raise_for_status()
    frame["jpeg"], frame["ts"] = r.content, time.time()
    return r.content


async def fresh_frame():
    try:
        return await capture()
    except Exception as e:  # noqa: BLE001
        if time.time() - frame["ts"] < 2:
            log.warning("capture failed (%s); using loop frame", e)
            return frame["jpeg"]
        raise


async def show(text):
    try:
        await http.get(HUD + "/show", params={"text": text[:40]}, timeout=1)
    except Exception as e:  # noqa: BLE001
        log.warning("display: %s", e)


try:
    from memory import router as memory_router
    from memory import save_moment
except Exception as e:  # noqa: BLE001 - memory is Darren's; the brain runs without it
    save_moment = memory_router = None
    log.warning("memory module not available (%s); moments won't be saved or searched", e)


async def remember(sid, jpeg, description):
    if not save_moment:
        return
    try:
        args = (sid, datetime.now(timezone.utc), jpeg, description)
        call = save_moment(*args) if inspect.iscoroutinefunction(save_moment) else asyncio.to_thread(save_moment, *args)
        moment_id = await asyncio.wait_for(call, 3)
        if moment_id is not None:   # None: duplicate frame or failed save
            await emit("memory_saved", sid, moment_id=moment_id, description=description)
    except Exception as e:  # noqa: BLE001
        log.warning("memory save failed: %s", e)


def thumb(jpeg):
    return list(Image.open(io.BytesIO(jpeg)).convert("L").resize((32, 24)).getdata())


def change(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


# ---------- the watch loop ----------

async def decision(sid, fid, level, reason, box, text="", speak=""):
    log.info("%s %s %r: %s", fid, level, text, reason)
    await emit("decision", sid, level=level, text=text, speak=speak, reason=reason, frame_id=fid, focus_box=box)


async def tick(sid, fid):
    jpeg = await capture()
    small = thumb(jpeg)
    if watch["ref"] is not None and change(small, watch["ref"]) < CHANGE_THRESHOLD:
        return await decision(sid, fid, "silent", "no change", watch["box"])
    wait = LOOP_GAP_S - (time.monotonic() - watch["last_call"])
    if wait > 0:
        return await decision(sid, fid, "silent", f"scene changed; next model call in {wait:.0f}s", watch["box"])
    watch["last_call"], watch["ref"] = time.monotonic(), small

    s = session(sid)
    text, model = await llm.chat(llm.messages(prompts.WATCH, prompts.build_watch(s), jpeg),
                                 model=llm.WATCH, timeout=WATCH_TIMEOUT_S)
    w = llm.parse_json(text)
    if not isinstance(w, dict):
        return await decision(sid, fid, "silent", "bad model output", None)
    box = watch["box"] = gate.to_focus_box(w.get("box_2d"))
    level, reason = gates[sid].decide(w)
    if model != llm.WATCH:
        reason += f" [via {model}]"
    if w.get("description"):
        note(s["descriptions"], str(w["description"]))
        bg(remember(sid, jpeg, str(w["description"])))
    line, say = str(w.get("text") or "")[:40], str(w.get("say") or "")
    if level != "silent":
        bg(show(line or say))
        note(s["said"], say or line)
    save_state()
    await decision(sid, fid, level, reason, box, text=line if level != "silent" else "",
                   speak=say if level == "speak" else "")


async def watch_loop():
    errors = 0
    while True:
        sid = state["active"]
        if not sid:
            await asyncio.sleep(1)
            continue
        t0, fid = time.monotonic(), f"f_{next(frame_ids):04d}"
        try:
            await tick(sid, fid)
            errors = 0
        except Exception as e:  # noqa: BLE001 - the loop never dies
            errors += 1
            await decision(sid, fid, "silent", f"error: {type(e).__name__}: {e}"[:160], None)
        await asyncio.sleep(max(0.0, (BACKOFF_S if errors >= 3 else TICK_S) - (time.monotonic() - t0)))


# ---------- metrics ----------

def pct(xs, p):
    xs = sorted(x for x in xs if x is not None)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else None


def metrics():
    try:
        bake = json.loads(BAKEOFF.read_text())
    except (OSError, ValueError):
        bake = {}
    return dict(
        answer_latency_ms_p50=pct([t for t, _ in latencies], 0.5),
        answer_latency_ms_p95=pct([t for t, _ in latencies], 0.95),
        first_word_ms_p50=pct([f for _, f in latencies], 0.5),
        gate_precision=bake.get("gate_precision"),
        gate_precision_basis=bake.get("basis"),  # "measured on N test photos" - label it that way
        model_calls_today=llm.calls_today(),
        model_usd_today=llm.usd_today(),
        ask_model=llm.PRIMARY,
        watch_model=llm.WATCH,
    )


async def metrics_loop():
    while True:
        await asyncio.sleep(30)
        if state["active"]:
            await emit("metrics", state["active"], **metrics())


@asynccontextmanager
async def lifespan(app):
    tasks = [asyncio.create_task(watch_loop()), asyncio.create_task(metrics_loop())]
    yield
    for t in tasks:
        t.cancel()
    save_state()


app = FastAPI(lifespan=lifespan)
if memory_router is not None:
    app.include_router(memory_router)


# ---------- routes ----------

class SessionIn(BaseModel):
    session_id: str


@app.post("/api/session")
async def start_session(body: SessionIn):
    sid, prev = body.session_id, state["last_session"]
    s = session(sid)
    if prev and prev != sid:
        s["earlier"] = state["sessions"].get(prev, {}).get("descriptions", [])[-10:]
    state["active"] = state["last_session"] = sid
    gates.pop(sid, None)              # fresh cooldowns: every judge gets the nudge
    watch["ref"], watch["box"] = None, None
    save_state()
    return {"session_id": sid, "earlier": len(s["earlier"])}


@app.delete("/api/session")
async def stop_session():
    state["active"] = None
    save_state()
    return {"session_id": None}


class AskIn(BaseModel):
    session_id: str
    text: str


@app.post("/api/ask")
async def ask(q: AskIn):
    t0 = time.monotonic()
    ms = lambda: int((time.monotonic() - t0) * 1000)  # noqa: E731
    sid, ask_id = q.session_id, f"a_{next(ask_ids):04d}"
    mode, question = prompts.pick_mode(q.text)
    s, g = session(sid), gates[sid]
    g.hold()
    out, first_ms, shown, timings, jpeg = "", None, False, {}, b""
    try:
        async with asyncio.timeout(ASK_TIMEOUT_S):
            jpeg = await fresh_frame()
            timings["capture"] = ms()
            memo = ""
            if mode == "recall":
                try:
                    r = await http.post(f"http://127.0.0.1:{PORT}/api/memory/search",
                                        json={"session_id": sid, "query": question}, timeout=2)
                    r.raise_for_status()
                    hit = r.json()
                    if hit.get("found"):
                        memo = f"{hit.get('captured_at', '')}: {hit.get('description', '')}"
                except Exception as e:  # noqa: BLE001
                    log.warning("memory search failed (%s); answering from recent context", e)
            msgs = llm.messages(prompts.ASK[mode], prompts.build_ask(question, s, memo), jpeg)
            async for chunk in llm.hedged_stream(msgs):
                if first_ms is None:
                    first_ms = timings["first_word"] = ms()
                out += chunk
                await emit("answer_delta", sid, ask_id=ask_id, text=chunk)
                if not shown and "\n" in out.strip():
                    shown = True
                    bg(show(prompts.split_answer(out)[0]))   # line 1 on the glasses before line 2 is done
    except Exception as e:  # noqa: BLE001 - never a 500
        log.warning("ask %s failed after %dms: %s: %s", ask_id, ms(), type(e).__name__, e)

    display, speak = prompts.split_answer(out)
    if not display:
        display, speak = FALLBACK, ""
    if not shown:
        bg(show(display))
    latency_ms = ms()
    level = "speak" if speak else "display"
    latencies.append((latency_ms, first_ms))
    g.hold(speak or display)
    note(s["said"], speak or display)
    if jpeg and display != FALLBACK:
        bg(remember(sid, jpeg, f"Asked '{question}', Iris answered: {speak or display}"))
    save_state()
    log.info("ask %s mode=%s %s total=%dms", ask_id, mode, timings, latency_ms)
    await emit("answer", sid, ask_id=ask_id, question=question, display=display, speak=speak,
               latency_ms=latency_ms, first_word_ms=first_ms)
    await emit("metrics", sid, **metrics())
    return {"display": display, "speak": speak, "level": level, "latency_ms": latency_ms}


@app.websocket("/api/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    clients.add(sock)
    try:
        while True:
            await sock.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(sock)


@app.get("/api/tts")
async def tts(text: str):
    r = await voice.open_tts(http, text)
    if r is None:
        return Response(status_code=204)   # phone just shows the text
    spoken.append((time.time(), text))
    return StreamingResponse(voice.relay(r), media_type="audio/mpeg")


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile, session_id: str = Form("")):
    """Draft for the phone (Ali): one clip in, text out. Empty text means: don't ask."""
    try:
        text = await voice.transcribe(http, await audio.read(), audio.filename, audio.content_type)
    except Exception as e:  # noqa: BLE001
        return {"text": "", "dropped_as_echo": False, "error": f"{type(e).__name__}: {e}"[:160]}
    if gate.is_echo(text, [t for ts, t in spoken if time.time() - ts < 15]):
        log.info("transcribe: dropped %r as Iris's own voice", text)
        return {"text": "", "dropped_as_echo": True}
    return {"text": text, "dropped_as_echo": False}
