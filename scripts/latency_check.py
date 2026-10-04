"""
Times a spoken question end to end, playing the phone's part against a running brain.

For each question it does what the phone page does: says the wake word (POST /api/wake), "speaks"
for a moment, sends the question (POST /api/ask), follows the WebSocket, downloads the voice the
way the phone does (the whole clip, then play), and reports the first audio back (POST /api/timing).

    brain/.venv/bin/python scripts/latency_check.py --brain http://127.0.0.1:8000 --session lat-test

Times are ms from the moment the question is sent. `first audio` is when the phone could start
playing: the first clip fully downloaded. Run it twice to compare settings, e.g. with the brain
started with FRAME_REUSE_S=0 WAKE_READY_S=0 EARLY_SPEECH=0 KEEP_WARM_S=0 for the old behaviour.
"""
import argparse
import asyncio
import json
import statistics
import time

import httpx
import websockets

QUESTIONS = [
    "Iris, what is this?",
    "Iris, how much protein is in this?",
    "Iris, is this vegan?",
    "Iris, read this",
    "Iris, do I need an umbrella today?",
    "Iris, where did I see the protein bar?",
]


async def one(http, ws, brain, session, question, speak_s):
    """-> a row of timings for one question."""
    t_wake = time.monotonic()
    await http.post(f"{brain}/api/wake", json={"session_id": session}, timeout=3)
    await asyncio.sleep(max(0.0, speak_s - (time.monotonic() - t_wake)))     # the wearer is still talking
    while True:                                                             # drop events from before the question
        try:
            await asyncio.wait_for(ws.recv(), 0.01)
        except asyncio.TimeoutError:
            break
    t0 = time.monotonic()
    ms = lambda: round((time.monotonic() - t0) * 1000)  # noqa: E731
    row = {"question": question}
    body = {"session_id": session, "text": question, "wake_ms": round((t0 - t_wake) * 1000), "listen_ms": round((t0 - t_wake) * 1000)}
    reply = asyncio.create_task(http.post(f"{brain}/api/ask", json=body, timeout=12))
    reply.add_done_callback(lambda _: row.setdefault("http_total", ms()))
    audio = None
    answer = None
    deadline = t0 + 12

    async def clip(url, params=None):
        r = await http.get(brain + url, params=params, timeout=10)
        row["audio_bytes"] = len(r.content)
        return ms() if r.status_code == 200 and r.content else None

    while time.monotonic() < deadline and (answer is None or audio is None or not audio.done()):
        try:
            e = json.loads(await asyncio.wait_for(ws.recv(), 0.25))
        except asyncio.TimeoutError:
            if answer is not None and audio is None:
                break
            continue
        if e.get("session_id") != session:
            continue
        if e["type"] == "answer_delta":
            row.setdefault("first_word_seen", ms())
        elif e["type"] == "speech" and audio is None:
            row["speech_event"] = ms()
            row["spoken_first"] = e["text"]
            audio = asyncio.create_task(clip(e["audio_url"]))
        elif e["type"] == "answer":
            answer = e
            row["answer_event"] = ms()
            if audio is None and e.get("speak"):                             # a brain without speech events
                audio = asyncio.create_task(clip("/api/tts", {"text": e["speak"]}))
            elif audio is None:
                break
    r = await reply
    if audio is not None:
        row["first_audio"] = await audio
    if answer:
        row["display_line"], row["speak"] = answer["display"], answer["speak"]
        trace = answer.get("trace") or {}
        row["frame"] = trace.get("frame")
        row["brain"] = dict(trace.get("latency_ms") or {})
        if row.get("first_audio") is not None and answer.get("ask_id"):
            await http.post(f"{brain}/api/timing", json={"session_id": session, "ask_id": answer["ask_id"],
                                                         "first_audio_ms": row["first_audio"]}, timeout=3)
        end = time.monotonic() + 1.5                                          # late timings (display, speech)
        while time.monotonic() < end:
            try:
                e = json.loads(await asyncio.wait_for(ws.recv(), 0.3))
            except asyncio.TimeoutError:
                continue
            if e.get("type") == "answer_timing" and e.get("ask_id") == answer.get("ask_id"):
                row["brain"] = e["latency_ms"]
    else:
        row["error"] = f"no answer event (HTTP {r.status_code})"
    return row


def med(rows, get):
    xs = [x for x in (get(r) for r in rows) if isinstance(x, (int, float))]
    return round(statistics.median(xs)) if xs else None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain", default="http://127.0.0.1:8000")
    ap.add_argument("--session", default=f"lat-{time.strftime('%H%M')}")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--speak-s", type=float, default=2.0, help="how long the wearer takes to say the question")
    ap.add_argument("--gap-s", type=float, default=3.0, help="pause between questions")
    ap.add_argument("--idle-s", type=float, default=0, help="also ask one question after this long with nothing happening")
    ap.add_argument("--settle-s", type=float, default=8.0, help="let the watch loop look at the scene before the first question")
    ap.add_argument("--out", help="write every row here as JSON")
    args = ap.parse_args()
    brain = args.brain.rstrip("/")
    async with httpx.AsyncClient() as http, websockets.connect(brain.replace("http", "ws", 1) + "/api/ws") as ws:
        r = await http.post(f"{brain}/api/session", json={"session_id": args.session}, timeout=8)
        r.raise_for_status()
        await asyncio.sleep(args.settle_s)
        rows = []
        for n in range(args.rounds):
            for q in QUESTIONS:
                row = await one(http, ws, brain, args.session, q, args.speak_s)
                row["round"] = n + 1
                rows.append(row)
                b = row.get("brain", {})
                print(f"  {q[6:32]:26} frame {str((row.get('frame') or {}).get('source')):6} context {b.get('context')!s:>5} "
                      f"first word {b.get('first_word')!s:>5} glasses {b.get('display')!s:>5} voice ready {b.get('speech')!s:>5} "
                      f"first audio {row.get('first_audio')!s:>5} done {row.get('http_total')!s:>5}", flush=True)
                await asyncio.sleep(args.gap_s)
        idle = None
        if args.idle_s:
            print(f"  waiting {args.idle_s:.0f} s with nothing happening...", flush=True)
            await http.delete(f"{brain}/api/session", timeout=3)              # no loop calls keeping connections busy
            await asyncio.sleep(args.idle_s)
            idle = await one(http, ws, brain, args.session, QUESTIONS[1], args.speak_s)
            idle["after_idle_s"] = args.idle_s
        await http.delete(f"{brain}/api/session", timeout=3)
    summary = {
        "questions": len(rows),
        "frame_reused": sum(1 for r in rows if (r.get("frame") or {}).get("source") == "recent"),
        "context_ms": med(rows, lambda r: r.get("brain", {}).get("context")),
        "first_word_ms": med(rows, lambda r: r.get("brain", {}).get("first_word")),
        "on_glasses_ms": med(rows, lambda r: r.get("brain", {}).get("display")),
        "voice_ready_ms": med(rows, lambda r: r.get("brain", {}).get("speech")),
        "first_audio_ms": med(rows, lambda r: r.get("first_audio")),
        "done_ms": med(rows, lambda r: r.get("http_total")),
        "after_idle": idle and {"first_word_ms": idle.get("brain", {}).get("first_word"), "first_audio_ms": idle.get("first_audio"),
                                "done_ms": idle.get("http_total")},
    }
    print(json.dumps(summary, indent=1))
    if args.out:
        with open(args.out, "w") as f:
            json.dump({"summary": summary, "rows": rows, "idle": idle}, f, indent=1)


if __name__ == "__main__":
    asyncio.run(main())
