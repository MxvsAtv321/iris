"""What the Act agent does with a message: understand the intent, then act.

The actions are the ones Iris can actually take. Check live conditions (weather, tonight's sky,
the next SpaceX launch, the ISS), search memory for something the glasses saw, or put one line
on the display. A "what should I do about this" question looks through the glasses first.

  python act.py     # self-check, no network
"""
import asyncio
import logging
import os
import re

import live
import prompts

log = logging.getLogger("iris.act")

BRAIN = os.getenv("BRAIN_URL") or "http://127.0.0.1:8000"
FALLBACK = "Didn't catch that, try again"

RECALL = re.compile(
    r"\b(where did i|when did i|did i (leave|see|put)|where('s| is) my|what was (that|the)|"
    r"where i left|left my)\b", re.I)
SHOW = re.compile(r"\b(show|display|put|flash)\b.+\b(glasses|display|hud)\b", re.I)
OUTSIDE = re.compile(r"\b(go out|outside|step out|head out|jacket|coat|umbrella)\b", re.I)
VIEW = re.compile(r"\b(this|that|these|those|looking at|in front of me|what should i do)\b", re.I)
WET = re.compile(r"\b(drizzle|snow|thunderstorm|freezing rain|heavy rain)\b|(?<!of )\brain\b", re.I)
INTENTS = ("recall", "show", "conditions", "next")


def classify(text):
    """The intent a message is asking for. Rules first, so a model outage still acts."""
    q = text or ""
    if RECALL.search(q):
        return "recall"
    if SHOW.search(q):
        return "show"
    if live.topics(q) or OUTSIDE.search(q):
        return "conditions"
    return "next"


def show_line(question, seen):
    m = re.search(r"\b(?:show|display|put|flash)\b\s+(.+)", question or "", re.I)
    if not m:
        raw = seen[-1] if seen else "Iris"
    else:
        raw = re.sub(r"\s+on\s+(my\s+|the\s+)?(glasses|display|hud)\s*$", "", m.group(1), flags=re.I)
    return raw.strip(" .\"'")[:40] or "Iris"


def _pct(pattern, text):
    m = re.search(pattern, text or "")
    return int(m.group(1)) if m else 0


def from_conditions(question, note, seen):
    """A next step from a live-data note. -> (display, why)."""
    n, scene = note or "", " ".join(seen or [])
    ask = f"{question or ''} {scene}"
    wet = WET.search(n) or _pct(r"(\d+)% chance of rain", n) >= 50 or _pct(r"(\d+)% in the next 3 hours", n) >= 50
    if wet:
        if re.search(r"\b(jacket|coat)\b", ask, re.I):
            return "Wear a jacket", "It's wet out. Wear a jacket if you go."
        if re.search(r"\bumbrella\b", ask, re.I):
            return "Take an umbrella", "It's wet out. Take an umbrella."
        return "Stay in", "It's wet out. Stay in, or take an umbrella if you have to go."
    temp = re.search(r"(\d+)F", n)
    if temp and int(temp.group(1)) < 50 and re.search(r"\b(jacket|coat|outside|go out)\b", ask, re.I):
        return "Bring a jacket", f"It's {temp.group(1)}F. Bring a jacket."
    if re.search(r"\bISS\b", n) and re.search(r"\b(iss|space station)\b", question or "", re.I):
        km = re.search(r"about ([\d,]+) km", n)
        if km and int(km.group(1).replace(",", "")) < 1500:
            return "Look up: ISS", n.split("\n")[0]
        line = next((ln for ln in n.split("\n") if ln.startswith("ISS")), n.split("\n")[0])
        return line[:40], n
    if "good for stargazing" in n:
        return "Look up tonight", "The sky is worth stepping out for. " + n.split("\n")[0]
    if n:
        first = n.split("\n")[0]
        return first[:40], n
    return "No live data", "I couldn't reach the weather, sky, or launch feeds."


def decide(intent, question, seen, note, memory):
    """The line for the glasses and the reason, from data already fetched. -> (display, why)."""
    if intent == "show":
        line = show_line(question, seen)
        return line, f"Showing {line!r} on the glasses."
    if intent == "recall":
        if memory:
            return "Found it", memory
        if seen:
            return "Last seen", f"Nothing saved for that. Most recently the glasses saw: {seen[-1]}"
        return "Not in memory", "I couldn't find that in what the glasses have seen."
    if intent == "conditions" or note:
        return from_conditions(question, note, seen)
    if seen:
        last = re.sub(r"^\d{2}:\d{2}\s*", "", seen[-1])
        return last[:40], f"The glasses last saw {last}."
    return "Nothing in view", "The glasses aren't reporting a scene yet. Start a session, or ask whether to go outside tonight."


def wants_view(text):
    return bool(VIEW.search(text or ""))


async def _json(http, method, url, timeout, **kw):
    try:
        r = await http.request(method, url, timeout=timeout, **kw)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()
    except Exception as e:  # noqa: BLE001 - the demo answers anyway
        log.warning("%s %s: %s", method, url, e)
        return None


async def refine(text):
    """One word from the model when the rules landed on 'next'. None if the model is down."""
    try:
        import llm
        raw, _ = await llm.chat(llm.messages(
            "Classify the intent of a message to an assistant in someone's glasses. "
            "Reply with exactly one word: recall, show, conditions, or next. "
            "recall = where or when they saw something. "
            "show = put a specific line on the glasses. "
            "conditions = weather, going outside, a jacket, tonight's sky, a launch, or the ISS. "
            "next = what to do about the thing they are looking at.",
            text or ""), timeout=3)
    except Exception as e:  # noqa: BLE001
        log.info("intent refine skipped: %s", e)
        return None
    word = (raw or "").strip().lower().split()
    return word[0] if word and word[0] in INTENTS else None


async def run(text, http, brain=BRAIN, refine_intent=True):
    """Act on one message. Never raises. -> the reply to send back."""
    intent = classify(text)
    if refine_intent and intent == "next":
        intent = await refine(text) or intent

    scene = await _json(http, "GET", f"{brain}/api/scene", 2) or {}
    seen = list(scene.get("recently_seen") or [])
    sid = scene.get("session_id")
    did = []

    memory = ""
    if intent == "recall":
        hit = await _json(http, "POST", f"{brain}/api/memory/search", 2.5,
                          json={"session_id": sid or "agent", "query": text or ""})
        if hit and hit.get("description"):
            when = hit.get("captured_at") or ""
            memory = f"{when}: {hit['description']}".strip(": ")
        did.append("searched memory")

    note, live_q = "", text or ""
    blob = f"{text or ''} {' '.join(seen)}"
    if intent == "conditions" or (intent == "next" and live.topics(blob)):
        if intent != "conditions" and not live.topics(text or ""):
            live_q = blob
        body = await _json(http, "GET", f"{brain}/api/live", 3.5, params={"q": live_q})
        if body is None:
            try:
                note, _sources = await live.note(live_q, http)
            except Exception as e:  # noqa: BLE001
                log.warning("live: %s", e)
        else:
            note = body.get("note") or ""
        did.append("checked live conditions" if note else "live conditions unavailable")

    asked = None
    if intent == "next" and sid and wants_view(text):
        asked = await _json(http, "POST", f"{brain}/api/ask", 8,
                            json={"session_id": sid, "text": text or ""})
        did.append("looked through the glasses")

    if asked and asked.get("display") and asked["display"] != FALLBACK:
        display, why = asked["display"], asked.get("speak") or asked["display"]
        shown = True   # /api/ask already put line 1 on the glasses
    else:
        display, why = decide(intent, text, seen, note, memory)
        shown = False
        if sid and display:
            res = await _json(http, "POST", f"{brain}/api/show", 2, json={"text": display})
            shown = bool(res and res.get("shown"))
            did.append("updated the glasses" if shown else "the display didn't answer")
        elif display:
            did.append("no glasses session, so nothing was shown")

    lines = [why.strip()]
    if display and shown:
        lines.append(f"On the glasses: {display}")
    if did:
        lines.append("Did: " + "; ".join(did) + ".")
    return "\n".join(line for line in lines if line)


if __name__ == "__main__":
    assert classify("where did I leave my phone") == "recall"
    assert classify("where I left my keys") == "recall"
    assert classify('put "12g protein" on my glasses') == "show"
    assert classify("should I go outside tonight") == "conditions"
    assert classify("do I need a jacket") == "conditions"
    assert classify("when is the next SpaceX launch") == "conditions"
    assert classify("where is the ISS") == "conditions"
    assert classify("what should I do about what I'm looking at") == "next"
    assert show_line('put "12g protein" on my glasses', []) == "12g protein"
    assert len(show_line("show " + "x" * 80 + " on my glasses", [])) == 40

    wet = "Weather in Ann Arbor now: 48F, feels like 44F, rain, wind 8 mph. Today: high 50F, low 42F, 80% chance of rain; 70% in the next 3 hours."
    assert from_conditions("should I go outside", wet, [])[0] == "Stay in"
    assert from_conditions("do I need a jacket", wet, [])[0] == "Wear a jacket"
    sky = "Tonight in Ann Arbor: sunset 7:12 PM, about 10% cloud cover after dark (clear, good for stargazing)."
    assert from_conditions("what can I see tonight", sky, [])[0] == "Look up tonight"
    far = "ISS right now: over 10S 20E, about 12,000 km from Ann Arbor, at 420 km altitude, in Earth's shadow."
    assert from_conditions("where is the ISS", far, [])[0].startswith("ISS right now")
    assert from_conditions("where is the ISS", far.replace("12,000", "800"), [])[0] == "Look up: ISS"
    cold = "Weather in Ann Arbor now: 41F, feels like 38F, clear, wind 5 mph."
    assert from_conditions("do I need a jacket", cold, [])[0] == "Bring a jacket"
    dry = "Today: 4% chance of rain; 0% in the next 3 hours."
    assert from_conditions("should I go outside", dry, [])[0] != "Stay in"
    assert from_conditions("how's the weather", "Weather in Ann Arbor now: 70F, clear.", [])[0].startswith("Weather")
    assert from_conditions("weather?", "", [])[0] == "No live data"

    assert decide("recall", "where is my phone", [], "", "19:02: a phone face down next to a laptop")[0] == "Found it"
    assert decide("recall", "where is my phone", ["19:01 a desk"], "", "")[0] == "Last seen"
    assert decide("next", "hello", [], "", "")[0] == "Nothing in view"
    assert wants_view("what should I do about this") and not wants_view("when is the launch")

    class Fake:
        def __init__(self, session="judge-01", shown=True):
            self.calls, self.session, self.shown = [], session, shown

        async def request(self, method, url, timeout=0, **kw):
            self.calls.append((method, url.split("/")[-1], kw.get("json") or kw.get("params")))
            payload = {}
            if url.endswith("/scene"):
                payload = {"session_id": self.session, "recently_seen": ["19:02 a protein bar"], "already_said": []}
            elif url.endswith("/live"):
                payload = {"note": "Weather in Ann Arbor now: 48F, rain, wind 8 mph.", "sources": ["Open-Meteo"]}
            elif url.endswith("/show"):
                payload = {"text": kw["json"]["text"], "shown": self.shown}
            elif url.endswith("/search"):
                payload = {"captured_at": "2026-10-03T19:02:00Z", "description": "a phone face down next to a laptop"}
            elif url.endswith("/ask"):
                payload = {"display": "12g protein", "speak": "About 12 grams of protein."}

            class R:
                status_code = 200
                def raise_for_status(self):
                    return None
                def json(_self):
                    return payload
            return R()

    async def check_run():
        http = Fake()
        reply = await run("should I go outside tonight", http, refine_intent=False)
        assert "Stay in" in reply and "On the glasses: Stay in" in reply, reply
        assert ("POST", "show", {"text": "Stay in"}) in http.calls
        http = Fake()
        reply = await run("where did I leave my phone", http, refine_intent=False)
        assert "phone face down" in reply and "On the glasses: Found it" in reply, reply
        http = Fake()
        reply = await run("what should I do about this", http, refine_intent=False)
        assert "12 grams" in reply and "On the glasses: 12g protein" in reply, reply
        assert not any(name == "show" for _, name, _ in http.calls)   # /api/ask already showed it
        http = Fake(session=None)
        reply = await run("should I go outside", http, refine_intent=False)
        assert "Stay in" in reply and "On the glasses" not in reply and "nothing was shown" in reply, reply

    asyncio.run(check_run())
    print("act ok")
