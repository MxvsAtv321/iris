"""Bake-off: same photos, same prompts, several models; speed and accuracy side by side.

  python bakeoff.py ping                   # one call per model on a synthetic whiteboard: keys, model IDs, latency
  python bakeoff.py snap snack_label.jpg   # save a frame from the glasses camera to bakeoff/photos/
  python bakeoff.py                        # every model below on every row of bakeoff/labels.csv
  python bakeoff.py xai:grok-4.20-non-reasoning openrouter:meta/muse-spark-1.3
  python bakeoff.py jev                    # the current gate against Jev as System 1 (jev.py), on the same photos
  python bakeoff.py jev --set DIR          # ...on another labelled set: DIR/labels.csv and DIR/photos/

labels.csv: answer_must_contain is checked against the answer for rows with a question, and against
the nudge (display + spoken line) for rows without one, e.g. "56" for the whiteboard mistake.
Writes bakeoff/results.csv (every call) and bakeoff/results.json (summary; the dashboard shows the
gate precision of WATCH_MODEL from it).
"""
import asyncio
import csv
import io
import json
import os
import statistics
import sys
import time
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

import gate
import jev
import llm
import prompts

HERE = Path(__file__).resolve().parent / "bakeoff"
RUNS = 3
CANDIDATES = [
    "xai:grok-4.20-non-reasoning",
    "xai:grok-4.20-reasoning",
    "xai:grok-4.7@low",
    "openrouter:meta/muse-spark-1.3",
    "openrouter:google/gemini-3.5-flash-lite",   # the old default, as a baseline
]
MODELS = list(dict.fromkeys([llm.WATCH, llm.PRIMARY, *CANDIDATES]))


def iou(a, b):
    iw = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter)


def p50(xs):
    xs = [x for x in xs if x]
    return int(statistics.median(xs)) if xs else None


async def timed(model, msgs):
    """-> (text, first_chunk_ms, total_ms, error)"""
    t0, first, out = time.monotonic(), None, ""
    try:
        async with asyncio.timeout(30):
            async for c in llm.stream(model, msgs):
                first = first or int((time.monotonic() - t0) * 1000)
                out += c
        err = ""
    except Exception as e:  # noqa: BLE001
        err = f"{type(e).__name__}: {e}"[:200]
    return out, first, int((time.monotonic() - t0) * 1000), err


async def runs(model, msgs):
    results = [await timed(model, msgs) for _ in range(RUNS)]
    ok = [r for r in results if not r[3]] or results
    return ok[-1][0], p50([r[1] for r in ok]), p50([r[2] for r in ok]), ok[-1][3]


def judge(text, err):
    """Watch reply -> (parsed, level, display + spoken line)."""
    w = llm.parse_json(text) or {}
    level = gate.Gate().decide(w)[0] if w else "silent"
    return w, level, f"{w.get('text') or ''} {w.get('say') or ''}".strip() or err


async def bench(model, rows):
    out = []
    agree = predicted = tp = nudges = nudge_ok = asked = correct = errors = 0
    watch_ms, ask_first, ask_ms, board_iou = [], [], [], None
    for r in rows:
        jpeg = (HERE / "photos" / r["photo"]).read_bytes()
        must = r.get("answer_must_contain", "").strip().lower()
        text, first, total, err = await runs(model, llm.messages(prompts.WATCH, prompts.build_watch({}), jpeg))
        errors += bool(err)
        w, level, line = judge(text, err)
        box = gate.to_focus_box(w.get("box_2d"))
        got_iou = None
        if r.get("expected_box") and box:
            got_iou = round(iou([float(v) for v in r["expected_box"].split()], box), 2)
            board_iou = got_iou if "whiteboard" in r["photo"] else board_iou
        predicted += level != "silent"
        tp += level != "silent" and r["expected_level"] != "silent"
        agree += level == r["expected_level"]
        ok = level == r["expected_level"]
        if must and not r.get("question"):
            nudges += 1
            ok = ok and must in line.lower()
            nudge_ok += ok
        watch_ms.append(total)
        out.append(dict(model=model, photo=r["photo"], kind="watch", first_ms=first, total_ms=total,
                        result=level, expected=r["expected_level"], ok=ok, iou=got_iou,
                        output=(text or err).replace("\n", " ")[:300]))
        if r.get("question"):
            mode, q = prompts.pick_mode(r["question"])
            text, first, total, err = await runs(model, llm.messages(prompts.ASK[mode], prompts.build_ask(q, {}), jpeg))
            errors += bool(err)
            display, speak = prompts.split_answer(text)
            ok = (must in (display + " " + speak).lower()) if must else None
            if must:
                asked += 1
                correct += bool(ok)
            ask_first.append(first)
            ask_ms.append(total)
            out.append(dict(model=model, photo=r["photo"], kind=f"ask:{mode}", first_ms=first, total_ms=total,
                            result=display, expected=must, ok=ok, iou=None,
                            output=(f"{display} | {speak}" if display else err)[:300]))
    summary = dict(
        level_agreement=round(agree / len(rows), 2),
        gate_precision=round(tp / predicted, 2) if predicted else None,
        nudges_correct=f"{nudge_ok}/{nudges}" if nudges else None,
        watch_ms_p50=p50(watch_ms),
        whiteboard_iou=board_iou,
        answer_accuracy=round(correct / asked, 2) if asked else None,
        ask_first_ms_p50=p50(ask_first),
        ask_total_ms_p50=p50(ask_ms),
        errors=errors,
    )
    print(model, summary, flush=True)
    return out, summary


def frac(s):
    n, d = (s or "0/1").split("/")
    return int(n) / int(d)


def recommend(summary):
    ok = {m: s for m, s in summary.items() if s["errors"] == 0} or summary
    watch = max(ok, key=lambda m: (frac(ok[m]["nudges_correct"]), ok[m]["level_agreement"], -(ok[m]["watch_ms_p50"] or 1e9)))
    ask = max(ok, key=lambda m: (ok[m]["answer_accuracy"] or 0, -(ok[m]["ask_first_ms_p50"] or 1e9)))
    return watch, ask


async def main(models):
    rows = list(csv.DictReader(open(HERE / "labels.csv", newline="")))
    rows = [r for r in rows if (HERE / "photos" / r["photo"]).exists() or print("missing photo:", r["photo"])]
    if not rows:
        sys.exit("no photos yet: take them with `python bakeoff.py snap <name>.jpg`")
    results = await asyncio.gather(*(bench(m, rows) for m in models))
    out = [row for rows_, _ in results for row in rows_]
    summary = {m: s for m, (_, s) in zip(models, results)}

    with open(HERE / "results.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(out[0]))
        writer.writeheader()
        writer.writerows(out)
    chosen = llm.WATCH if llm.WATCH in summary else models[0]
    watch, ask = recommend(summary)
    (HERE / "results.json").write_text(json.dumps(dict(
        chosen=chosen, gate_precision=summary[chosen]["gate_precision"],
        basis=f"measured on {len(rows)} test photos", at=time.strftime("%Y-%m-%d %H:%M"),
        recommended={"WATCH_MODEL": watch, "PRIMARY_MODEL": ask}, models=summary), indent=1))
    print(f"\nrecommended: WATCH_MODEL={watch}  PRIMARY_MODEL={ask}")
    print(f"spent about ${llm.usd_today():.3f} on {llm.calls_today()} calls; wrote {HERE / 'results.json'}")


# Questions with the mode each should get, for comparing the rules in prompts.pick_mode with Jev.
MODE_QUESTIONS = [
    ("how much protein is in this?", "ask"), ("is this vegan", "ask"), ("how much does this cost", "ask"),
    ("what is this?", "identify"), ("what am I looking at", "identify"), ("what kind of plant is this", "identify"),
    ("read this", "read"), ("what does that say?", "read"), ("can you read that sign for me", "read"),
    ("where did I leave my keys", "recall"), ("where's my phone", "recall"), ("when did I see the whiteboard", "recall"),
    ("have you seen my water bottle", "recall"), ("what's written on the board", "read"),
]


async def jev_bench(where):
    """The gate as it is (the vision model's urgency) against the gate with Jev's probability, photo by photo.
    Both use the same vision reply, so the only difference is who decides how much the moment matters."""
    rows = list(csv.DictReader(open(where / "labels.csv", newline="")))
    rows = [r for r in rows if (where / "photos" / r["photo"]).exists() or print("missing photo:", r["photo"])]
    if not rows:
        sys.exit(f"no photos in {where / 'photos'}: take them with `python bakeoff.py snap <name>.jpg`")
    out, added = [], []
    for r in rows:
        jpeg = (where / "photos" / r["photo"]).read_bytes()
        text, _first, watch_ms, err = await timed(llm.WATCH, llm.messages(prompts.WATCH, prompts.build_watch({}), jpeg))
        w = llm.parse_json(text) or {}
        now = gate.Gate().decide(w)[0] if w else "silent"
        opinion = await jev.interrupt(w, budget=8) if (w.get("text") or w.get("say")) else None
        with_jev = gate.Gate().decide({**w, "urgency": jev.urgency(opinion["probability"])})[0] if opinion else now
        if opinion:
            added.append(opinion["ms"])
        out.append(dict(photo=r["photo"], expected=r["expected_level"], watch_urgency=w.get("urgency"), gate_now=now,
                        jev_probability=opinion and opinion["probability"], gate_with_jev=with_jev,
                        watch_ms=watch_ms, jev_ms=opinion and opinion["ms"],
                        line=f"{w.get('text') or ''} | {w.get('say') or ''}"[:120], error=err))
        print(f"  {r['photo']:26} expected {r['expected_level']:7} now {now:7} (urgency {w.get('urgency')!s:>4})  "
              f"with Jev {with_jev:7} (p {opinion['probability'] if opinion else '-'!s:>5}, {opinion['ms'] if opinion else '-'} ms)", flush=True)

    def score(key):
        return dict(
            accuracy=round(sum(o[key] == o["expected"] for o in out) / len(out), 2),
            false_nudges=sum(o["expected"] == "silent" and o[key] != "silent" for o in out),
            missed=sum(o["expected"] != "silent" and o[key] == "silent" for o in out),
        )

    modes = []
    for q, expected in MODE_QUESTIONS:
        t0 = time.monotonic()
        picked = await jev.mode(q, budget=8)
        modes.append(dict(question=q, expected=expected, rules=prompts.pick_mode(q)[0], jev=picked,
                          jev_ms=round((time.monotonic() - t0) * 1000)))
    summary = dict(
        at=time.strftime("%Y-%m-%d %H:%M"), photos=len(out), watch_model=llm.WATCH, jev_model=jev.MODEL,
        gate_now=score("gate_now"), gate_with_jev=score("gate_with_jev"),
        jev_answered=f"{len(added)}/{sum(1 for o in out if o['line'].strip(' |'))}", jev_added_ms_p50=p50(added),
        mode_accuracy=dict(rules=round(sum(m["rules"] == m["expected"] for m in modes) / len(modes), 2),
                           jev=round(sum(m["jev"] == m["expected"] for m in modes) / len(modes), 2),
                           jev_ms_p50=p50([m["jev_ms"] for m in modes]), questions=len(modes)),
    )
    (where / "jev_results.json").write_text(json.dumps(dict(summary=summary, photos=out, modes=modes), indent=1))
    print(json.dumps(summary, indent=1))
    print(f"spent about ${llm.usd_today():.3f}; wrote {where / 'jev_results.json'}")


def board_jpeg():
    """A clean synthetic whiteboard with one planted mistake (7 x 8 = 54)."""
    img = Image.new("RGB", (800, 600), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default(size=64)
    except TypeError:   # Pillow < 10.1
        font = ImageFont.load_default()
    for i, line in enumerate(["Times tables", "6 x 7 = 42", "7 x 8 = 54", "9 x 9 = 81"]):
        d.text((80, 60 + i * 120), line, fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


async def ping(models):
    msgs = llm.messages(prompts.WATCH, prompts.build_watch({}), board_jpeg())

    async def one(m):
        text, first, total, err = await timed(m, msgs)
        w, level, line = judge(text, err)
        caught = level != "silent" and "56" in line
        return f"{m:45} first {first or '-':>5}ms  total {total:>5}ms  {level:7}  caught={caught!s:5}  {line[:70]}"

    for line in await asyncio.gather(*(one(m) for m in models)):
        print(line)
    print(f"spent about ${llm.usd_today():.4f}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["snap"]:
        name = args[1] if len(args) > 1 else time.strftime("snap_%H%M%S.jpg")
        r = httpx.get((os.getenv("CAMERA_URL") or "http://172.20.10.4") + "/capture", timeout=3)
        r.raise_for_status()
        (HERE / "photos").mkdir(parents=True, exist_ok=True)
        (HERE / "photos" / name).write_bytes(r.content)
        print("saved", HERE / "photos" / name)
    elif args[:1] == ["jev"]:
        asyncio.run(jev_bench(Path(args[args.index("--set") + 1]).expanduser() if "--set" in args else HERE))
    elif args[:1] == ["ping"]:
        asyncio.run(ping(args[1:] or MODELS))
    else:
        asyncio.run(main(args or MODELS))
