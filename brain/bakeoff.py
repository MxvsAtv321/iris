"""Bake-off: same photos, same prompts, several models; speed and accuracy side by side.

  python bakeoff.py snap snack_label.jpg   # save a frame from the glasses camera to bakeoff/photos/
  python bakeoff.py                        # every model below on every row of bakeoff/labels.csv
  python bakeoff.py gemini:gemini-3.5-flash-lite openrouter:meta/muse-spark-1.3

The first model listed is the one you plan to run; its gate precision goes on the dashboard.
Writes bakeoff/results.csv (every call) and bakeoff/results.json (summary).
"""
import asyncio
import csv
import json
import os
import statistics
import sys
import time
from pathlib import Path

import httpx

import gate
import llm
import prompts

HERE = Path(__file__).resolve().parent / "bakeoff"
STATE = Path(__file__).resolve().parent / "state.json"
RUNS = 3
MODELS = list(dict.fromkeys([llm.PRIMARY, "openrouter:meta/muse-spark-1.3", "openrouter:google/gemini-3.5-flash-lite"]))


def iou(a, b):
    iw = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter)


async def timed(model, msgs):
    """-> (text, first_chunk_ms, total_ms, error)"""
    t0, first, out = time.monotonic(), None, ""
    try:
        async with asyncio.timeout(20):
            async for c in llm.stream(model, msgs):
                first = first or int((time.monotonic() - t0) * 1000)
                out += c
        err = ""
    except Exception as e:  # noqa: BLE001
        err = f"{type(e).__name__}: {e}"[:200]
    if model.startswith("gemini:"):
        await asyncio.sleep(4)   # free tier: 15 requests per minute
    return out, first, int((time.monotonic() - t0) * 1000), err


async def runs(model, msgs):
    results = [await timed(model, msgs) for _ in range(RUNS)]
    ok = [r for r in results if not r[3]] or results
    med = lambda i: int(statistics.median([r[i] for r in ok if r[i] is not None] or [0]))  # noqa: E731
    return ok[-1][0], med(1), med(2), ok[-1][3]


async def main(models):
    rows = list(csv.DictReader(open(HERE / "labels.csv", newline="")))
    rows = [r for r in rows if (HERE / "photos" / r["photo"]).exists() or print("missing photo:", r["photo"])]
    if not rows:
        sys.exit("no photos yet: take them with `python bakeoff.py snap <name>.jpg`")
    out, summary = [], {}
    for model in models:
        tp = predicted = agree = asked = correct = 0
        firsts, totals, board_iou = [], [], None
        for r in rows:
            jpeg = (HERE / "photos" / r["photo"]).read_bytes()
            text, first, total, err = await runs(model, llm.messages(prompts.WATCH, prompts.build_watch({}), jpeg))
            w = llm.parse_json(text) or {}
            level, reason = gate.Gate().decide(w) if w else ("silent", err or "bad model output")
            box = gate.to_focus_box(w.get("box_2d"))
            got_iou = None
            if r.get("expected_box") and box:
                got_iou = round(iou([float(v) for v in r["expected_box"].split()], box), 2)
                board_iou = got_iou if "whiteboard" in r["photo"] else board_iou
            predicted += level != "silent"
            tp += level != "silent" and r["expected_level"] != "silent"
            agree += level == r["expected_level"]
            firsts.append(first)
            totals.append(total)
            out.append(dict(model=model, photo=r["photo"], kind="watch", first_ms=first, total_ms=total,
                            result=level, expected=r["expected_level"], ok=level == r["expected_level"],
                            iou=got_iou, output=(text or err).replace("\n", " ")[:300]))
            if r.get("question"):
                q = prompts.pick_mode(r["question"])
                text, first, total, err = await runs(model, llm.messages(prompts.ASK[q[0]], prompts.build_ask(q[1], {}), jpeg))
                display, speak = prompts.split_answer(text)
                must = r.get("answer_must_contain", "").strip().lower()
                ok = (must in (display + " " + speak).lower()) if must else None
                if must:
                    asked += 1
                    correct += bool(ok)
                firsts.append(first)
                totals.append(total)
                out.append(dict(model=model, photo=r["photo"], kind=f"ask:{q[0]}", first_ms=first, total_ms=total,
                                result=display, expected=must, ok=ok, iou=None,
                                output=(f"{display} | {speak}" if display else err)[:300]))
        summary[model] = dict(
            answer_accuracy=round(correct / asked, 2) if asked else None,
            level_agreement=round(agree / len(rows), 2),
            gate_precision=round(tp / predicted, 2) if predicted else None,
            first_chunk_ms_p50=int(statistics.median(f for f in firsts if f) or 0) if any(firsts) else None,
            total_ms_p50=int(statistics.median(totals)),
            whiteboard_iou=board_iou,
        )
        print(model, summary[model])

    with open(HERE / "results.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(out[0]))
        writer.writeheader()
        writer.writerows(out)
    chosen = models[0]
    (HERE / "results.json").write_text(json.dumps(dict(
        chosen=chosen, gate_precision=summary[chosen]["gate_precision"],
        basis=f"measured on {len(rows)} test photos", at=time.strftime("%Y-%m-%d %H:%M"), models=summary), indent=1))
    print("wrote", HERE / "results.json")


def with_usage(fn):
    """Count the free Gemini calls in the same state.json the server uses. Don't run while the server is up."""
    try:
        state = json.loads(STATE.read_text())
    except (OSError, ValueError):
        state = {}
    llm.usage.update(state.get("usage") or {})
    try:
        fn()
    finally:
        state["usage"] = llm.usage
        STATE.write_text(json.dumps(state, indent=1))
        print("gemini calls today:", llm.gemini_calls_today())


if __name__ == "__main__":
    if sys.argv[1:2] == ["snap"]:
        name = sys.argv[2] if len(sys.argv) > 2 else time.strftime("snap_%H%M%S.jpg")
        r = httpx.get((os.getenv("CAMERA_URL") or "http://172.20.10.4") + "/capture", timeout=3)
        r.raise_for_status()
        (HERE / "photos").mkdir(parents=True, exist_ok=True)
        (HERE / "photos" / name).write_bytes(r.content)
        print("saved", HERE / "photos" / name)
    else:
        with_usage(lambda: asyncio.run(main(sys.argv[1:] or MODELS)))
