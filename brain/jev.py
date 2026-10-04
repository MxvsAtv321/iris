"""System 1: a fast second opinion on whether a moment is worth an interruption.

Jev is TypeSafe AI's decision model. It does not write text: it is given some state and typed
questions, and returns a probability for each. Iris reaches it through the Vercel AI Gateway's
evaluation endpoint (POST /v1/evaluate), which is not a chat-completions API, so it has its own
small client here rather than going through llm.py.

With JEV_GATE=1 the vision model still describes the frame and proposes a line. Jev is then asked one
boolean question about it, "would the wearer want to be interrupted with this line right now?", and
its probability replaces the vision model's own urgency before the gate's four rules run. For
questions, Jev picks the mode (ask, identify, read, recall) ahead of the rules in prompts.pick_mode.

Off by default. When it is on and Jev is slow, refuses, fails or is unsure, the vision model's
urgency and the rule-picked mode are used, exactly as if it were off. After three failures in a
row it is left alone for a minute, so an outage costs a few frames a moment each, not every frame.

  JEV_GATE=1                  turn it on
  AI_GATEWAY_API_KEY=...      the Vercel AI Gateway key (Jev needs paid credits on the team)
  JEV_MODEL=typesafe-ai/jev   any evaluation model on the gateway
  JEV_BUDGET_S=1.5            how long a frame waits for Jev
  JEV_MODE_BUDGET_S=0.4       how long a question waits for Jev

Run `python jev.py` for the self-check (no network), `python jev.py ping` for one real call.
"""
import logging
import os
import time

import llm

log = logging.getLogger("iris.jev")
ON = (os.getenv("JEV_GATE") or "0") == "1"
URL = (os.getenv("AI_GATEWAY_URL") or "https://ai-gateway.vercel.sh/v1").rstrip("/") + "/evaluate"
MODEL = os.getenv("JEV_MODEL") or "typesafe-ai/jev"
BUDGET_S = float(os.getenv("JEV_BUDGET_S") or 1.5)
MODE_BUDGET_S = float(os.getenv("JEV_MODE_BUDGET_S") or 0.4)
MODE_SURE = 0.6            # below this Jev's pick of a mode is a guess, and the rules decide
PAUSE_AFTER, PAUSE_S = 3, 60
failures = {"row": 0, "until": 0.0}

INTERRUPT = {
    "type": "boolean",
    "instructions": "Would the wearer of these glasses want to be interrupted with this line right now?",
    "criteria": {
        "true": "The line points out a mistake in visible writing, a safety hazard, or something about to be missed, "
                "and the wearer has not already been told.",
        "false": "Ordinary life, nothing worth saying, something merely interesting, or something the wearer was already told.",
    },
}
MODE = {
    "type": "choice",
    "instructions": "How should an assistant in smart glasses answer this question from the wearer?",
    "criteria": {
        "recall": "It is about the past: where or when they saw, left or put something.",
        "read": "They want the text in view read out.",
        "identify": "They want to know what the thing in view is.",
        "ask": "Any other question about what they are looking at, or about the world.",
    },
}


def urgency(p):
    """The gate speaks at urgency 8 and shows at 5, so 0.8 and 0.5 are where Jev speaks and shows."""
    return int(p * 10 + 0.5)


def moment(w, said):
    """The state Jev is given: the scene, the line Iris has ready, and what the wearer was already told."""
    return {
        "scene": str(w.get("description") or ""),
        "line_for_the_display": str(w.get("text") or ""),
        "line_to_speak": str(w.get("say") or ""),
        "why_iris_thinks_it_matters": str(w.get("reason") or ""),
        "already_told_the_wearer": [str(line) for line in list(said)[-3:]],
    }


async def evaluate(state, questions, budget):
    """One call to the gateway's evaluation endpoint. -> the answers, keyed like the questions. Raises on any failure."""
    key = os.getenv("AI_GATEWAY_API_KEY")
    if not key:
        raise RuntimeError("AI_GATEWAY_API_KEY not set")
    now = time.monotonic()
    if now < failures["until"]:
        raise RuntimeError("paused after repeated failures")
    try:
        r = await llm.http.post(URL, json={"model": MODEL, "state": state, "questions": questions},
                                headers={"Authorization": f"Bearer {key}"}, timeout=budget)
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:160]}")
        body = r.json()
        answers = body["answers"]
    except Exception:
        failures["row"] += 1
        if failures["row"] >= PAUSE_AFTER:
            failures.update(row=0, until=now + PAUSE_S)
            log.warning("jev failed %d times in a row; not asking it for %d s", PAUSE_AFTER, PAUSE_S)
        raise
    failures["row"] = 0
    llm._roll()
    llm.usage["calls"] += 1
    try:
        llm.usage["usd"] += float(body.get("providerMetadata", {}).get("gateway", {}).get("cost") or 0)
    except (TypeError, ValueError, AttributeError):
        pass
    return answers


async def interrupt(w, said=(), budget=None):
    """-> {"probability", "model", "ms"} for a judged frame, or None when Jev gave no usable answer."""
    t0 = time.monotonic()
    try:
        answers = await evaluate(moment(w, said), {"interrupt": INTERRUPT}, budget or BUDGET_S)
        p = float(answers["interrupt"]["probability"])
        if not 0 <= p <= 1:
            raise ValueError(f"probability {p}")
    except Exception as e:  # noqa: BLE001 - the vision model's own urgency stands
        log.warning("jev interrupt: %s: %s", type(e).__name__, e)
        return None
    return {"probability": round(p, 3), "model": MODEL, "ms": round((time.monotonic() - t0) * 1000)}


async def mode(question, budget=None):
    """-> ask, identify, read or recall, or None when Jev didn't answer in time or wasn't sure: the rules' mode stands."""
    try:
        answer = (await evaluate(str(question or ""), {"mode": MODE}, budget or MODE_BUDGET_S))["mode"]
        choice = answer["choice"]
        sure = float(answer.get("probabilities", {}).get(choice, 0))
    except Exception as e:  # noqa: BLE001
        log.info("jev mode: %s: %s", type(e).__name__, e)
        return None
    return choice if choice in MODE["criteria"] and sure >= MODE_SURE else None


if __name__ == "__main__":
    import asyncio
    import sys

    if sys.argv[1:2] == ["ping"]:
        async def ping():
            w = {"description": "A whiteboard of times tables. Line 2 reads 7 x 8 = 54.", "text": "Line 2: 7x8 is 56",
                 "say": "Line 2 says seven times eight is fifty-four. It's fifty-six.", "reason": "arithmetic error"}
            print(MODEL, "interrupt:", await interrupt(w, budget=10))
            t0 = time.monotonic()
            print(MODEL, "mode for 'where did I leave my keys':", await mode("where did I leave my keys", budget=10),
                  f"({round((time.monotonic() - t0) * 1000)} ms)")
        asyncio.run(ping())
        sys.exit()

    assert [urgency(p) for p in (0.0, 0.49, 0.5, 0.79, 0.8, 1.0)] == [0, 5, 5, 8, 8, 10]
    state = moment({"description": "a desk", "say": "hi"}, ["a", "b", "c", "d"])
    assert state["scene"] == "a desk" and state["already_told_the_wearer"] == ["b", "c", "d"] and state["line_for_the_display"] == ""

    class Reply:
        def __init__(self, status, body):
            self.status_code, self.body, self.text = status, body, str(body)

        def json(self):
            return self.body

    class Gateway:
        """Stands in for llm.http: answers every request the same way and keeps what it was sent."""
        def __init__(self, status=200, answers=None, delay=0.0, cost="0.00001155"):
            self.status, self.answers, self.delay, self.cost, self.sent = status, answers or {}, delay, cost, []

        async def post(self, url, json=None, headers=None, timeout=None):
            self.sent.append((url, json, headers))
            if self.delay > (timeout or 9):
                await asyncio.sleep(timeout)
                raise TimeoutError("timed out")
            body = {"model": MODEL, "answers": self.answers, "providerMetadata": {"gateway": {"cost": self.cost}}}
            return Reply(self.status, body if self.status == 200 else {"error": {"message": "no access"}})

    async def check():
        real, key = llm.http, os.environ.get("AI_GATEWAY_API_KEY")
        os.environ["AI_GATEWAY_API_KEY"] = "test-key"
        w = {"description": "a whiteboard", "say": "Line 2 is wrong", "text": "Line 2: 7x8 is 56"}

        llm.http = gw = Gateway(answers={"interrupt": {"type": "boolean", "probability": 0.914}})
        calls, spent = llm.calls_today(), llm.usage["usd"]
        got = await interrupt(w, ["19:02 hello"])
        assert got["probability"] == 0.914 and got["model"] == MODEL and got["ms"] >= 0
        url, body, headers = gw.sent[0]
        assert url.endswith("/v1/evaluate") and headers == {"Authorization": "Bearer test-key"}
        assert body["model"] == MODEL and body["questions"]["interrupt"]["type"] == "boolean"
        assert body["state"]["line_to_speak"] == "Line 2 is wrong" and body["state"]["already_told_the_wearer"] == ["19:02 hello"]
        assert llm.calls_today() == calls + 1 and abs(llm.usage["usd"] - spent - 0.00001155) < 1e-12   # counted like any model call

        llm.http = Gateway(answers={"mode": {"type": "choice", "choice": "recall", "probabilities": {"recall": 0.93, "ask": 0.07}}})
        assert await mode("where did I leave my keys") == "recall"
        llm.http = Gateway(answers={"mode": {"type": "choice", "choice": "read", "probabilities": {"read": 0.41, "ask": 0.39}}})
        assert await mode("what about this") is None                       # unsure: the rules decide
        llm.http = Gateway(answers={"mode": {"type": "choice", "choice": "weather", "probabilities": {"weather": 1}}})
        assert await mode("is it raining") is None                         # not one of the modes

        llm.http = Gateway(answers={"interrupt": {"type": "boolean", "probability": 7}})
        assert await interrupt(w) is None                                  # unreadable: the vision model's urgency stands
        llm.http = Gateway(answers={})
        assert await interrupt(w) is None
        llm.http = Gateway(answers={"interrupt": {"probability": 0.9}}, delay=5)
        assert await interrupt(w, budget=0.05) is None                     # too slow: same
        failures.update(row=0, until=0.0)

        llm.http = gw = Gateway(status=403)                                # no access (the free tier), or an outage
        for _ in range(PAUSE_AFTER):
            assert await interrupt(w) is None
        assert len(gw.sent) == PAUSE_AFTER and failures["until"] > time.monotonic()
        assert await interrupt(w) is None and await mode("read this") is None
        assert len(gw.sent) == PAUSE_AFTER                                 # paused: nothing more was sent
        failures.update(row=0, until=0.0)

        os.environ.pop("AI_GATEWAY_API_KEY")
        llm.http = gw = Gateway(answers={"interrupt": {"probability": 0.9}})
        assert await interrupt(w) is None and gw.sent == []               # no key: no call
        failures.update(row=0, until=0.0)
        llm.http = real
        if key:
            os.environ["AI_GATEWAY_API_KEY"] = key

    asyncio.run(check())
    print("jev ok")
