"""System 1: a fast second opinion on whether a moment is worth an interruption.

The vision model describes the frame and proposes a line. With JEV_GATE=1, Jev then answers one
question about it, "should Iris interrupt?", with a probability, and that probability replaces the
vision model's own urgency before the gate's four rules run. For questions, Jev picks the mode
(ask, identify, read, recall) ahead of the rules in prompts.pick_mode.

Off by default. When it is on and Jev is slow, fails or says something unreadable, the vision
model's urgency and the rule-picked mode are used, exactly as if it were off.

  JEV_GATE=1                              turn it on
  JEV_MODEL=openrouter:typesafe/jev-1.13  any provider:model in llm.PROVIDERS
  JEV_BUDGET_S=1.5                        how long a frame waits for Jev
  JEV_MODE_BUDGET_S=0.4                   how long a question waits for Jev

Run `python jev.py` for the self-check (no network).
"""
import asyncio
import logging
import os
import re
import time

import llm

log = logging.getLogger("iris.jev")
ON = (os.getenv("JEV_GATE") or "0") == "1"
MODEL = os.getenv("JEV_MODEL") or "openrouter:typesafe/jev-1.13"
BUDGET_S = float(os.getenv("JEV_BUDGET_S") or 1.5)
MODE_BUDGET_S = float(os.getenv("JEV_MODE_BUDGET_S") or 0.4)
MODES = ("ask", "identify", "read", "recall")

INTERRUPT = """You are the instinct of Iris, glasses that think ahead. Iris has looked at what the wearer sees and has a line ready.
Decide how likely it is that the wearer would want to be interrupted with that line right now. Most moments are not worth it.

Reply with ONE JSON object and nothing else: {"interrupt": a probability from 0 to 1}

0.85 to 1: a mistake in visible writing, a safety hazard, or something about to be missed.
0.5 to 0.8: useful but not urgent.
0 to 0.3: ordinary life, or nothing worth saying.
A line the wearer was already told is under 0.1. Be calibrated: of the moments you call 0.7, seven in ten should deserve the interruption."""

MODE = """Pick how an assistant in someone's glasses should answer their question. Reply with exactly one word.
recall: about the past, where or when they saw or left something.
read: they want the text in view read out.
identify: they want to know what the thing in view is.
ask: anything else."""


def probability(text):
    """Jev's reply -> a probability from 0 to 1, or None if it can't be read. Takes {"interrupt": 0.83}, 0.83 or 83%."""
    t = (text or "").strip()
    w = llm.parse_json(t)
    if isinstance(w, dict):
        t = str(w.get("interrupt", w.get("probability", "")))
    m = re.search(r"-?\d+(?:\.\d+)?\s*%?", t)
    if not m:
        return None
    raw = m.group(0).strip()
    p = float(raw.rstrip("% ")) / (100 if raw.endswith("%") else 1)
    return p if 0 <= p <= 1 else None


def urgency(p):
    """The gate speaks at urgency 8 and shows at 5, so 0.8 and 0.5 are where Jev speaks and shows."""
    return int(p * 10 + 0.5)


def moment(w, said):
    """What Jev is shown: the scene, the line Iris has ready, and what the wearer was already told."""
    parts = [f"Scene: {w.get('description') or ''}",
             f"Line ready for the display: {w.get('text') or '(none)'}",
             f"Line ready to speak: {w.get('say') or '(none)'}",
             f"Why Iris thinks it matters: {w.get('reason') or ''}"]
    if said:
        parts.append("Already told the wearer:\n" + "\n".join(said[-3:]))
    return "\n".join(parts)


async def reply(system, text, budget, max_tokens):
    async with asyncio.timeout(budget):
        return "".join([c async for c in llm.stream(MODEL, llm.messages(system, text), max_tokens)])


async def interrupt(w, said=(), budget=None):
    """-> {"probability", "model", "ms"} for a judged frame, or None when Jev didn't give a usable answer."""
    t0 = time.monotonic()
    try:
        p = probability(await reply(INTERRUPT, moment(w, list(said)), budget or BUDGET_S, 60))
    except Exception as e:  # noqa: BLE001 - the vision model's own urgency stands
        log.warning("jev interrupt: %s: %s", type(e).__name__, e)
        return None
    if p is None:
        log.warning("jev interrupt: unreadable reply")
        return None
    return {"probability": round(p, 3), "model": MODEL, "ms": round((time.monotonic() - t0) * 1000)}


async def mode(question, budget=None):
    """-> one of MODES, or None when Jev didn't answer in time: the rules' mode stands."""
    try:
        words = (await reply(MODE, question, budget or MODE_BUDGET_S, 10)).strip().lower().split()
    except Exception as e:  # noqa: BLE001
        log.info("jev mode: %s: %s", type(e).__name__, e)
        return None
    word = words[0].strip(".,:\"'") if words else ""
    return word if word in MODES else None


if __name__ == "__main__":
    assert probability('{"interrupt": 0.83}') == 0.83 and probability("0.4") == 0.4 and probability("83%") == 0.83
    assert probability('```json\n{"interrupt": 1}\n```') == 1.0 and probability('{"probability": 0.2}') == 0.2
    assert probability("") is None and probability("maybe") is None and probability("7") is None and probability('{"interrupt": 1.4}') is None
    assert [urgency(p) for p in (0.0, 0.49, 0.5, 0.79, 0.8, 1.0)] == [0, 5, 5, 8, 8, 10]
    assert "Already told" not in moment({"description": "a desk"}, []) and "Already told" in moment({}, ["19:02 Line 2: 7x8 is 56"])

    async def check():
        real = llm.stream

        def says(text, delay=0.0):
            async def stream(model, msgs, max_tokens=0):
                await asyncio.sleep(delay)
                yield text
            return stream

        llm.stream = says('{"interrupt": 0.91}')
        got = await interrupt({"description": "a whiteboard", "say": "Line 2 is wrong"})
        assert got["probability"] == 0.91 and got["model"] == MODEL and got["ms"] >= 0
        llm.stream = says("not sure")
        assert await interrupt({}) is None                      # unreadable: the vision model's urgency stands
        llm.stream = says('{"interrupt": 0.9}', delay=0.2)
        assert await interrupt({}, budget=0.05) is None         # too slow: same
        llm.stream = says("Recall.")
        assert await mode("where did I leave my keys") == "recall"
        llm.stream = says("weather")
        assert await mode("is it raining") is None              # not a mode: the rules decide
        llm.stream = says("read", delay=0.2)
        assert await mode("read this", budget=0.05) is None
        llm.stream = real

    asyncio.run(check())
    print("jev ok")
