"""Iris brain: watch loop, /api/ask, /api/ws, sessions, voice.  Run: uvicorn main:app --port 8000"""
import asyncio
import inspect
import io
import json
import logging
import os
import time
from collections import OrderedDict, defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from itertools import count
from pathlib import Path

from fastapi import FastAPI, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse
from PIL import Image
from pydantic import BaseModel

import gate
import jev
import live
import llm  # loads .env
import prompts
import voice

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("iris")

CAMERA = os.getenv("CAMERA_URL") or "http://172.20.10.4"
HUD = os.getenv("HUD_URL") or "http://172.20.10.6"
# The camera forgets these on restart, so they are sent at startup and at every session start. Empty means leave it alone.
CAMERA_SETTINGS = {var: (os.getenv(env) or "").strip() for var, env in
                   (("framesize", "CAMERA_FRAMESIZE"), ("vflip", "CAMERA_VFLIP"), ("hmirror", "CAMERA_HMIRROR"))}
TICK_S, BACKOFF_S = 2, 5       # capture cadence; slower after 3 errors in a row
LOOP_GAP_S = 6                 # at most one loop model call per 6 s (<=10 RPM, rest kept for questions)
CHANGE_THRESHOLD = 12          # mean abs grey-level diff (0-255) on a 32x24 thumbnail; calibrate on site
ASK_TIMEOUT_S = 5
# Latency switches. Each can be turned off in .env if it misbehaves on the day: 0 restores the old behaviour.
FRAME_REUSE_S = float(os.getenv("FRAME_REUSE_S") or 1.0)   # a question uses the newest frame if it is younger than this
WAKE_READY_S = float(os.getenv("WAKE_READY_S") or 8)       # after the wake word, keep a fresh frame ready for this long
EARLY_SPEECH = (os.getenv("EARLY_SPEECH") or "1") != "0"   # start the voice on the first sentence, before the answer ends
KEEP_WARM_S = float(os.getenv("KEEP_WARM_S") or 25)        # ping every provider this often so no question pays a handshake
WATCH_TIMEOUT_S = 12           # per model; the loop can wait, a reasoning watch model may need it
FALLBACK = "Didn't catch that, try again"
NO_PHOTO = "\n(The camera didn't respond, so there is no photo. If the question needs one, say you can't see right now.)"
HERE = Path(__file__).resolve().parent
STATE = HERE / "state.json"
BAKEOFF = HERE / "bakeoff" / "results.json"

http = llm.http
clients = set()
gates = defaultdict(gate.Gate)
latencies = deque(maxlen=50)   # (total_ms, first_word_ms)
spoken = deque(maxlen=20)      # (ts, text) sent to TTS, for the echo filter
frame = {"jpeg": b"", "ts": 0.0}
frames = OrderedDict()         # frame_id -> JPEG the loop looked at, for the dashboard; the newest FRAMES_KEPT
FRAMES_KEPT = 450              # about 15 minutes at one frame per tick
BOOT = f"{int(time.time()):x}"  # in every frame URL: ids start again when the brain restarts, and browsers cache frames
# What the dashboard loads when it opens: the running session's decisions and answers, and its counts.
mind = {"sid": None, "events": deque(maxlen=1800), "tally": {"silent": 0, "display": 0, "speak": 0}}
watch = {"ref": None, "box": None, "last_call": -1e9}
frame_ids, ask_ids, speech_ids = count(1), count(1), count(1)
asks = OrderedDict()           # ask_id -> {"sid", "lat", "sent"}: timings still arriving after the answer went out
ASKS_KEPT = 50
speech = OrderedDict()         # speech_id -> voice.Speech: audio the brain is already fetching for the phone
SPEECH_KEPT = 20
first_audio = deque(maxlen=50)  # ms from question sent to the phone's first audio, as the phone reports it
ready = {"until": 0.0}         # the wake word's fresh-frame window; a newer wake replaces it
background = set()
asking = 0                     # questions in flight; the loop skips model calls meanwhile


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


def keep(msg):
    """Decisions and answers stay in memory, so a dashboard that opens or reloads mid-session sees all of it."""
    if mind["sid"] != msg["session_id"]:
        mind.update(sid=msg["session_id"], tally={"silent": 0, "display": 0, "speak": 0})
        mind["events"].clear()
    mind["events"].append(msg)
    if msg["type"] == "decision":
        mind["tally"][msg["level"]] += 1


async def emit(kind, sid, **fields):
    msg = {"type": kind, "session_id": sid, "at": now_iso(), **fields}
    if kind in ("decision", "answer"):
        keep(msg)
    for ws in list(clients):
        try:
            await asyncio.wait_for(ws.send_json(msg), 1)
        except Exception:  # noqa: BLE001 - a dead socket must not stall the brain
            clients.discard(ws)


camera_lock = asyncio.Lock()   # the ESP32 serves one request at a time


async def capture(reuse_s=0.0):
    """One frame from the camera. With reuse_s, a frame someone else took that recently is returned instead:
    the camera serves one request at a time, so a second capture right behind the first is wasted time."""
    async with camera_lock:
        if reuse_s and frame["jpeg"] and time.time() - frame["ts"] < reuse_s:
            return frame["jpeg"]
        r = await http.get(CAMERA + "/capture", timeout=1.5)
    r.raise_for_status()
    frame["jpeg"], frame["ts"] = r.content, time.time()
    return r.content


async def setup_camera():
    """Send frame size and orientation to the camera. Never raises: an unreachable camera is a warning."""
    wanted = {var: val for var, val in CAMERA_SETTINGS.items() if val}
    if not wanted:
        return
    async with camera_lock:
        try:
            for var, val in wanted.items():
                r = await http.get(CAMERA + "/control", params={"var": var, "val": val}, timeout=1)
                r.raise_for_status()
            await http.get(CAMERA + "/capture", timeout=1.5)   # the first frame after a change can be an old one
        except Exception as e:  # noqa: BLE001 - one warning, and no second spent on each remaining setting
            log.warning("camera settings %s not applied: %s: %s", wanted, type(e).__name__, e)
            return
    log.info("camera settings applied: %s", wanted)


async def grab(info=None):
    """The frame for a question, or b"" when the camera is down: the question still gets an answer.
    A frame the loop or the wake word took under FRAME_REUSE_S ago is used as it is, with no new capture.
    `info` is filled with where the frame came from: source (recent, fresh or none), age_ms and wait_ms."""
    t0 = time.monotonic()
    info = {} if info is None else info

    def got(source, jpeg):
        info.update(source=source, age_ms=round((time.time() - frame["ts"]) * 1000) if jpeg else None,
                    wait_ms=round((time.monotonic() - t0) * 1000))
        return jpeg

    if frame["jpeg"] and time.time() - frame["ts"] < FRAME_REUSE_S:
        return got("recent", frame["jpeg"])
    try:
        before = frame["ts"]
        jpeg = await capture(reuse_s=FRAME_REUSE_S)
        return got("fresh" if frame["ts"] != before else "recent", jpeg)
    except Exception as e:  # noqa: BLE001
        if time.time() - frame["ts"] < 2:
            log.warning("capture failed (%s); using the last frame", e)
            return got("recent", frame["jpeg"])
        log.warning("capture failed: %s", e)
        return got("none", b"")


async def get_ready():
    """The wearer has started talking. Until the question arrives, keep the newest frame under a second old
    and the model connections open, so the question starts with both in hand."""
    if not WAKE_READY_S:
        return
    until = ready["until"] = time.monotonic() + WAKE_READY_S
    bg(keep_warm_once())
    while time.monotonic() < until and ready["until"] == until and not asking:
        try:
            await capture(reuse_s=0.4)
        except Exception as e:  # noqa: BLE001 - the question copes without a frame
            log.info("wake capture: %s", e)
        await asyncio.sleep(0.4)


hud_lock = asyncio.Lock()      # display calls go out one at a time, in the order they were made
hud_calls = count(1)
hud_latest = 0


async def hud(path, params, replaceable=False):
    """One call to the display: 1 s timeout, never raises. -> True if the display answered.
    replaceable: skip it if a newer display call was made while this one waited (a late
    "thinking" must not land on top of the answer)."""
    global hud_latest
    n = hud_latest = next(hud_calls)
    async with hud_lock:
        if replaceable and hud_latest != n:
            return False
        try:
            r = await http.get(HUD + path, params=params, timeout=1)
            return r.status_code == 200
        except Exception as e:  # noqa: BLE001
            log.warning("display %s: %s", path, e)
            return False


async def show(text, eye=""):
    """Put one line on the glasses. Returns False when the display doesn't answer.
    eye="answer": the eye blinks, the text shows, then the eye rests open and closes.
    eye="nudge": the eye flicks open and blinks, the text shows, then the display goes dark.
    Without eye the text stays until it is replaced."""
    line = (text or "")[:40]
    params = {"text": line}
    if eye:
        params.update(eye=eye, hold=min(7000, 3000 + 70 * len(line)))   # longer lines stay up longer
    return await hud("/show", params)


async def eye(anim):
    """Play an eye animation: listening, thinking, speaking, idle, blink or close. The eye opens first if it is shut."""
    return await hud("/eye", {"anim": anim}, replaceable=True)


try:
    from memory import router as memory_router
    from memory import save_moment
    from memory.adapter import shared_async_client as memory_client
    from memory.search_router import safe_flat
except Exception as e:  # noqa: BLE001 - memory is Darren's; the brain runs without it
    save_moment = memory_router = memory_client = safe_flat = None
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

async def decision(sid, fid, level, reason, box, text="", speak="", trace=None):
    log.info("%s %s %r: %s", fid, level, text, reason)
    await emit("decision", sid, level=level, text=text, speak=speak, reason=reason, frame_id=fid, focus_box=box,
               trace={**BLANK_TRACE, **(trace or {}), "verdict": level})


# Every decision's trace has all of these keys; a frame the model never judged keeps the blanks.
BLANK_TRACE = dict(frame_url=None, looked=False, skipped=None, change=None, saw="", why="", topic="", model=None,
                   candidate={"text": "", "say": ""}, urgency=None, display_at=gate.DISPLAY_AT, speak_at=gate.SPEAK_AT,
                   proposed="silent", rules=[], blocked_by=None, latency_ms={}, jev=None)


async def tick(sid, fid, trace):
    """One frame. `trace` is filled in as the frame moves through, so an error still reports how far it got."""
    t0 = time.monotonic()
    ms = lambda since: round((time.monotonic() - since) * 1000)  # noqa: E731
    lat = trace["latency_ms"] = {}

    def skip(why, reason):
        lat["total"] = ms(t0)
        trace["skipped"] = why
        return decision(sid, fid, "silent", reason, watch["box"], trace=trace)

    jpeg = await capture()
    lat["capture"] = ms(t0)
    frames[fid] = jpeg
    while len(frames) > FRAMES_KEPT:
        frames.popitem(last=False)
    trace["frame_url"] = f"/api/frame/{fid}?v={BOOT}"
    small = thumb(jpeg)
    if watch["ref"] is not None:
        diff = change(small, watch["ref"])
        trace["change"] = {"score": round(diff, 1), "threshold": CHANGE_THRESHOLD}
        if diff < CHANGE_THRESHOLD:
            return await skip("no_change", "no change")
    if asking:
        return await skip("question_in_progress", "question in progress")
    wait = LOOP_GAP_S - (time.monotonic() - watch["last_call"])
    if wait > 0:
        return await skip("model_spacing", f"scene changed; next model call in {wait:.0f}s")
    watch["last_call"], watch["ref"] = time.monotonic(), small

    s = session(sid)
    trace["looked"] = True
    t_model = time.monotonic()
    text, model = await llm.chat(llm.messages(prompts.WATCH, prompts.build_watch(s), jpeg),
                                 model=llm.WATCH, timeout=WATCH_TIMEOUT_S)
    lat["model"] = ms(t_model)
    trace["model"] = model
    w = llm.parse_json(text)
    if not isinstance(w, dict):
        lat["total"] = ms(t0)
        return await decision(sid, fid, "silent", "bad model output", None, trace=trace)
    box = watch["box"] = gate.to_focus_box(w.get("box_2d"))
    line, say = str(w.get("text") or "")[:40], str(w.get("say") or "")
    if jev.ON and (line or say):       # Iris has something it could say: System 1 decides how much it matters
        opinion = await jev.interrupt(w, s["said"])
        if opinion:                    # no usable answer in time: the vision model's own urgency stands
            trace["jev"] = {**opinion, "watch_urgency": w.get("urgency")}
            lat["jev"] = opinion["ms"]
            w = {**w, "urgency": jev.urgency(opinion["probability"])}
    t_gate = time.perf_counter()
    level, reason, judged = gates[sid].explain(w)
    lat["gate"] = round((time.perf_counter() - t_gate) * 1000, 3)
    trace.update(judged, saw=str(w.get("description") or ""), why=str(w.get("reason") or "")[:100],
                 topic=str(w.get("topic") or ""), candidate={"text": line, "say": say})
    if model != llm.WATCH:
        reason += f" [via {model}]"
    if w.get("description"):
        note(s["descriptions"], str(w["description"]))
        bg(remember(sid, jpeg, str(w["description"])))
    if level != "silent":
        bg(show(line or say, eye="nudge"))
        note(s["said"], say or line)
    save_state()
    lat["total"] = ms(t0)
    await decision(sid, fid, level, reason, box, text=line if level != "silent" else "",
                   speak=say if level == "speak" else "", trace=trace)


async def watch_loop():
    errors = 0
    while True:
        sid = state["active"]
        if not sid:
            await asyncio.sleep(1)
            continue
        t0, fid, trace = time.monotonic(), f"f_{next(frame_ids):04d}", {}
        try:
            await tick(sid, fid, trace)
            errors = 0
        except Exception as e:  # noqa: BLE001 - the loop never dies
            errors += 1
            trace.setdefault("latency_ms", {})["total"] = round((time.monotonic() - t0) * 1000)
            await decision(sid, fid, "silent", f"error: {type(e).__name__}: {e}"[:160], None,
                           trace={**trace, "skipped": "error"})
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
    tally = mind["tally"] if mind["sid"] == state["active"] else {}
    return dict(
        answer_latency_ms_p50=pct([t for t, _ in latencies], 0.5),
        answer_latency_ms_p95=pct([t for t, _ in latencies], 0.95),
        first_word_ms_p50=pct([f for _, f in latencies], 0.5),
        first_audio_ms_p50=pct(first_audio, 0.5),   # question sent to voice playing, as the phone measures it
        gate_precision=bake.get("gate_precision"),
        gate_precision_basis=bake.get("basis"),  # "measured on N test photos" - label it that way
        # share of test photos where the gate chose the expected level; same basis as the precision
        gate_accuracy=((bake.get("models") or {}).get(bake.get("chosen")) or {}).get("level_agreement"),
        moments_seen=sum(tally.values()),
        moments_silent=tally.get("silent", 0),
        moments_shown=tally.get("display", 0),
        moments_spoken=tally.get("speak", 0),
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


async def keep_warm_once():
    """Touch every provider a question can need: the models, the voice and memory. Never raises."""
    jobs = [llm.warm(), voice.warm(http)]
    if memory_client:
        jobs.append(memory_client().warm())
    await asyncio.gather(*jobs, return_exceptions=True)


async def keep_warm_loop():
    """An idle connection is closed by one end or the other within a minute or two, and the next question
    then pays for a new handshake. A small request every KEEP_WARM_S keeps each one open."""
    while True:
        await keep_warm_once()
        await asyncio.sleep(KEEP_WARM_S)


@asynccontextmanager
async def lifespan(app):
    tasks = [asyncio.create_task(watch_loop()), asyncio.create_task(metrics_loop())]
    if KEEP_WARM_S:
        tasks.append(asyncio.create_task(keep_warm_loop()))
    else:
        bg(llm.warm())
    bg(live.prefetch(http))
    bg(setup_camera())
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
    await setup_camera()              # before the loop looks: a restarted camera is small and upside down
    sid, prev = body.session_id, state["last_session"]
    s = session(sid)
    if prev and prev != sid:
        s["earlier"] = state["sessions"].get(prev, {}).get("descriptions", [])[-10:]
    state["active"] = state["last_session"] = sid
    gates.pop(sid, None)              # fresh cooldowns: every judge gets the nudge
    watch["ref"], watch["box"] = None, None
    save_state()
    bg(live.prefetch(http))
    return {"session_id": sid, "earlier": len(s["earlier"])}


@app.delete("/api/session")
async def stop_session():
    state["active"] = None
    save_state()
    return {"session_id": None}


class WakeIn(BaseModel):
    session_id: str
    eye: bool = True               # false: the mic opened without the wake word, so get ready but leave the eye alone


@app.post("/api/wake")
async def wake(body: WakeIn):
    """The phone heard "Iris": the eye opens and listens, and the brain gets a frame and its connections ready
    for the question. Returns once the display has answered, or after 1 s."""
    t0 = time.monotonic()
    gates[body.session_id].hold()     # no nudge over the top of someone who has started talking
    bg(get_ready())
    opened = await eye("listening") if body.eye else False
    ms = int((time.monotonic() - t0) * 1000)
    log.info("wake %s: display %s in %dms", body.session_id, "answered" if opened else "did not answer", ms)
    return {"eye": opened, "display_ms": ms}


class AskIn(BaseModel):
    session_id: str
    text: str
    wake_ms: int | None = None     # from the phone: ms between hearing "Iris" and sending the question
    listen_ms: int | None = None   # from the phone: ms between the mic opening and sending the question


async def recall(sid, question):
    """Memory note for a recall question, or "" on a miss or failure."""
    if not memory_client:
        return ""
    try:
        hit = safe_flat(await asyncio.wait_for(memory_client().search(sid, question), 2))
        if hit.get("found"):
            return f"{hit.get('captured_at', '')}: {hit.get('description', '')}"
    except Exception as e:  # noqa: BLE001
        log.warning("memory search failed (%s); answering from recent context", e)
    return ""


async def remember_ask(sid, shot, question, said):
    jpeg = await shot
    if jpeg:
        await remember(sid, jpeg, f"Asked '{question}', Iris answered: {said}")


def mark(ask_id, key, value):
    """Record one step's time for a question. Steps that land after the answer went out (the display
    answering, the first audio) are sent on as an `answer_timing` event, so the dashboard still gets them."""
    a = asks.get(ask_id)
    if not a or key in a["lat"]:
        return
    a["lat"][key] = value
    if a["sent"]:
        bg(emit("answer_timing", a["sid"], ask_id=ask_id, latency_ms=dict(a["lat"])))


@app.post("/api/ask")
async def ask(q: AskIn):
    global asking
    t0 = time.monotonic()
    ms = lambda: int((time.monotonic() - t0) * 1000)  # noqa: E731
    sid, ask_id = q.session_id, f"a_{next(ask_ids):04d}"
    mode, question = prompts.pick_mode(q.text)
    s, g = session(sid), gates[sid]
    g.hold()
    bg(eye("thinking"))            # the eye thinks while the model works; it opens first if the wake word didn't
    out, first_ms, shown, sources, said, spoken_parts, shot_info = "", None, False, [], "", 0, {}
    # Every step's time in ms from the question arriving; `wake` and `listen` are the phone's own measurements.
    lat = {k: v for k, v in (("wake", q.wake_ms), ("listen", q.listen_ms)) if v is not None and 0 <= v < 120000}
    asks[ask_id] = {"sid": sid, "lat": lat, "sent": False}
    while len(asks) > ASKS_KEPT:
        asks.popitem(last=False)

    async def on_glasses(line):
        if await show(line, eye="answer"):
            mark(ask_id, "display", ms())

    async def say(text):
        """Start fetching this part of the answer's audio now, and tell the phone where to get it."""
        nonlocal spoken_parts
        speech_id = f"s_{next(speech_ids):04d}"
        item = speech[speech_id] = voice.Speech(text)
        while len(speech) > SPEECH_KEPT:
            speech.popitem(last=False)
        bg(item.fetch(http, on_first=(lambda: mark(ask_id, "speech", ms())) if spoken_parts == 0 else None))
        spoken.append((time.time(), text))
        await emit("speech", sid, ask_id=ask_id, seq=spoken_parts, text=text, audio_url=f"/api/tts/{speech_id}")
        spoken_parts += 1

    # Camera, memory and live data are fetched side by side; none of them raises.
    shot = asyncio.create_task(grab(shot_info))
    mode_by = "rules"
    if jev.ON:                         # System 1 picks the mode while the frame is fetched; the rules' pick stands if it is slow
        picked = await jev.mode(question)
        lat["mode"] = ms()
        if picked:
            mode, mode_by = picked, "jev"
    memo_task = asyncio.create_task(recall(sid, question)) if mode == "recall" else None
    live_task = asyncio.create_task(live.note(question, http)) if live.topics(question) else None
    if live_task and mode == "ask" and not prompts.DEICTIC.search(question):
        mode = "live"   # answered from live data alone: no photo to wait for or upload
    asking += 1         # counted only where the `finally` below is certain to take it back: a count
    try:                # left behind would keep the watch loop skipping every frame as "question in progress"
        async with asyncio.timeout(ASK_TIMEOUT_S):
            memo = await memo_task if memo_task else ""
            live_note, sources = await live_task if live_task else ("", [])
            jpeg = b""
            if mode != "live":
                jpeg = await shot
            lat["context"] = ms()
            text = prompts.build_ask(question + ("" if jpeg or mode == "live" else NO_PHOTO), s, memo, live_note)
            async for chunk in llm.hedged_stream(llm.messages(prompts.ASK[mode], text, jpeg)):
                if first_ms is None:
                    first_ms = lat["first_word"] = ms()
                out += chunk
                await emit("answer_delta", sid, ask_id=ask_id, text=chunk)
                if not shown and "\n" in out.strip():
                    shown = True
                    bg(on_glasses(prompts.split_answer(out)[0]))   # line 1 on the glasses before line 2 is done
                if EARLY_SPEECH and not said:
                    said = prompts.first_sentence(prompts.split_answer(out)[1])
                    if said:
                        await say(said)                            # the voice starts while the rest is written
    except Exception as e:  # noqa: BLE001 - never a 500
        log.warning("ask %s failed after %dms: %s: %s", ask_id, ms(), type(e).__name__, e)
    finally:
        asking -= 1

    display, speak = prompts.split_answer(out)
    if not display:
        display, speak = FALLBACK, ""
    if not shown:
        bg(on_glasses(display))
    if EARLY_SPEECH and speak:
        rest = speak[len(said):].strip() if speak.startswith(said) else ""
        if rest:
            await say(rest)
    latency_ms = lat["total"] = ms()
    level = "speak" if speak else "display"
    latencies.append((latency_ms, first_ms))
    g.hold(speak or display)
    note(s["said"], speak or display)
    if display != FALLBACK and mode != "recall":   # an answer about the past is not a new sighting of the thing
        bg(remember_ask(sid, shot, question, speak or display))
    save_state()
    used = mode != "live" and shot_info.get("source") in ("recent", "fresh")
    trace = {"mode": mode, "mode_by": mode_by, "latency_ms": lat,
             "frame": {"source": shot_info["source"], "age_ms": shot_info["age_ms"]} if used else None}
    log.info("ask %s mode=%s frame=%s %s sources=%s", ask_id, mode, trace["frame"], lat, sources)
    sent = dict(lat)
    await emit("answer", sid, ask_id=ask_id, question=question, display=display, speak=speak,
               latency_ms=latency_ms, first_word_ms=first_ms, context=sources, trace=trace)
    asks[ask_id]["sent"] = True
    if lat != sent:                # a step landed while the answer was going out
        await emit("answer_timing", sid, ask_id=ask_id, latency_ms=dict(lat))
    await emit("metrics", sid, **metrics())
    return {"display": display, "speak": speak, "level": level, "latency_ms": latency_ms}


class TimingIn(BaseModel):
    session_id: str
    ask_id: str
    first_audio_ms: int


@app.post("/api/timing")
async def timing(body: TimingIn):
    """The phone reports when the answer's voice started playing: ms on its own clock since it sent the question."""
    a = asks.get(body.ask_id)
    ok = bool(a and a["sid"] == body.session_id and 0 <= body.first_audio_ms < 60000 and "first_audio" not in a["lat"])
    if ok:
        first_audio.append(body.first_audio_ms)
        mark(body.ask_id, "first_audio", body.first_audio_ms)
    return {"ok": ok}


@app.get("/api/live")
async def live_context(q: str):
    """The live data a question would get: for the dashboard and for testing on site."""
    text, sources = await live.note(q, http)
    return {"topics": sorted(live.topics(q)), "note": text, "sources": sources}


@app.get("/api/scene")
async def scene():
    """What the glasses have just seen. The Act agent reads this before it does anything."""
    sid = state["active"]
    s = state["sessions"].get(sid, {}) if sid else {}
    return {
        "session_id": sid,
        "recently_seen": (s.get("descriptions") or [])[-5:],
        "already_said": (s.get("said") or [])[-3:],
    }


class ShowIn(BaseModel):
    text: str


@app.get("/api/frame")
async def latest_frame():
    """The newest camera frame the brain holds, from the loop or a question. 204 before the first one."""
    if not frame["jpeg"]:
        return Response(status_code=204)
    return Response(frame["jpeg"], media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/api/frame/{frame_id}")
async def one_frame(frame_id: str):
    """The frame behind one decision (its `trace.frame_url`). 404 once it has aged out."""
    jpeg = frames.get(frame_id)
    if not jpeg:
        return Response(status_code=404)
    return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/trace")
async def trace_so_far():
    """Everything the dashboard needs to open mid-session. Read-only: it never starts or touches a session.
    After a session stops, its events stay here until the next one says something."""
    sid = state["active"]
    return {"session_id": sid, "events": list(mind["events"]) if sid in (None, mind["sid"]) else [],
            "metrics": metrics()}


@app.post("/api/show")
async def show_text(body: ShowIn):
    """One line on the glasses, for the Act agent. Under 40 characters stays in the large font."""
    line = (body.text or "").strip()[:40]
    return {"text": line, "shown": await show(line) if line else False}


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


@app.get("/api/tts/{speech_id}")
async def tts_started(speech_id: str):
    """Audio the brain began fetching when it emitted a `speech` event. Plays from the start even if it is
    still arriving. 204 when there is no audio (unknown id, or the voice is unavailable): show the text."""
    item = speech.get(speech_id)
    if item is None or not await item.started():
        return Response(status_code=204)
    return StreamingResponse(item.read(), media_type="audio/mpeg")


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
