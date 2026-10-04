"""Thinking ahead: the wearer is heading out, and something they had is still where they put it down.

When the scene turns into a doorway, a corridor or the outdoors, Iris looks back through what it
has seen this session. If a thing people carry (phone, keys, wallet, bottle...) was last seen
resting on a table or a desk, and is not in view now, it nudges: "Phone's on table".

It reads the session's own notes first, and asks memory when those say nothing. The nudge then goes
through the gate like any other, so the cooldown and repeat rules keep it to once.

  THINK_AHEAD=1   turns it on. It is off by default until it has been tried on the glasses: whether it
                  fires depends on how the vision model words a doorway and a phone on a table.

Run `python ahead.py` for the self-check (no network).
"""
import os
import re

from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parent.parent / ".env")   # settings below come from .env, whoever imports this first

ON = (os.getenv("THINK_AHEAD") or "0") == "1"
URGENCY = 8     # something about to be missed: worth saying out loud, once
ITEMS = {       # what people carry and leave behind -> how a description names it
    "phone": r"\b(phone|smartphone|iphone|cell ?phone)\b",
    "keys": r"\b(keys|key ring|keyring|keychain|car key)\b",
    "wallet": r"\bwallet\b",
    "water bottle": r"\b(water bottle|bottle|flask|thermos)\b",
    "laptop": r"\b(laptop|macbook|notebook computer)\b",
    "headphones": r"\b(headphones|earbuds|airpods)\b",
    "umbrella": r"\bumbrella\b",
    "bag": r"\b(backpack|bag|purse|tote)\b",
    "badge": r"\b(badge|lanyard|id card)\b",
}
LEAVING = re.compile(
    r"\b(doorway|door frame|open door|corridor|hallway|stairwell|staircase|stairs|elevator|lift lobby|exit sign|"
    r"exit door|outdoors|outside|street|sidewalk|pavement|parking lot|walking (out|away|through))\b", re.I)
RESTING = re.compile(r"\b(table|desk|counter|countertop|shelf|bench|nightstand|workbench|windowsill|sofa|couch|chair)\b", re.I)
HELD = re.compile(r"\b(hold\w*|in (a|the|their|his|her|one) hand|carry\w*|pocket)\b", re.I)
QUESTION = re.compile(r"^(\d\d:\d\d )?Asked '", re.I)      # a saved question and answer, not a sighting
CLOCK = re.compile(r"^(\d\d:\d\d) ")


def leaving(description):
    return bool(LEAVING.search(description or ""))


def items_in(description):
    return {item for item, pattern in ITEMS.items() if re.search(pattern, description or "", re.I)}


def resting_place(description, item):
    """Where the item is resting in this description ('table'), or '' if it isn't at rest on a surface.
    The surface has to be named in the same sentence as the item, and the item must not be in a hand."""
    for sentence in re.split(r"(?<=[.!?])\s+", description or ""):
        if re.search(ITEMS[item], sentence, re.I) and not HELD.search(sentence):
            m = RESTING.search(sentence)
            if m:
                return m.group(1).lower()
    return ""


def left_behind(now, earlier):
    """now: the description of the frame in view. earlier: this session's descriptions, oldest first
    ("19:02 a phone on a wooden table."). -> what was left, or None.

    A thing counts as left behind when its most recent sighting has it resting on a surface and it
    is not in view now. A later sighting anywhere else (in a hand, in a bag) cancels it."""
    if not leaving(now):
        return None
    here = items_in(now)
    sightings = [d for d in earlier if not QUESTION.search(d)]
    for item in ITEMS:
        if item in here:
            continue
        last = next((d for d in reversed(sightings) if item in items_in(d)), None)
        place = resting_place(last, item) if last else ""
        if place and not leaving(last):
            clock = CLOCK.match(last)
            return {"item": item, "place": place, "seen": CLOCK.sub("", last).strip(), "at": clock.group(1) if clock else ""}
    return None


def left_at(item, description):
    """The same answer from one saved moment's description, for a thing the session's notes don't mention."""
    if QUESTION.search(description or "") or leaving(description):
        return None
    place = resting_place(description, item)
    return {"item": item, "place": place, "seen": (description or "").strip(), "at": ""} if place else None


def nudge(found):
    """The watch fields that say it: one line for the display, one sentence to speak."""
    item, place = found["item"], found["place"]
    plural = item.endswith("s") and item != "badge"
    text = f"{item.capitalize()} on {place}" if plural else f"{item.capitalize()}'s on {place}"   # short: the display is tiny
    say = f"Your {item} {'are' if plural else 'is'} still on the {place}."
    return {"urgency": URGENCY, "text": text, "say": say, "topic": f"left-behind-{item.replace(' ', '-')}",
            "reason": f"{item} last seen on the {place}; the wearer is leaving"}


if __name__ == "__main__":
    notes = ["19:01 A whiteboard with times tables.", "19:02 A phone and a set of keys on a wooden table next to a laptop.",
             "19:03 A person holding a set of keys in one hand."]
    door = "An open doorway leading into a corridor with grey carpet."
    found = left_behind(door, notes)
    assert found == {"item": "phone", "place": "table", "seen": "A phone and a set of keys on a wooden table next to a laptop.", "at": "19:02"}
    assert nudge(found) == {"urgency": 8, "text": "Phone's on table", "say": "Your phone is still on the table.",
                            "topic": "left-behind-phone", "reason": "phone last seen on the table; the wearer is leaving"}
    assert nudge({"item": "keys", "place": "desk"})["text"] == "Keys on desk"
    assert nudge({"item": "water bottle", "place": "counter"})["say"] == "Your water bottle is still on the counter."
    # Not leaving: no nudge, however long the phone has been on the table.
    assert left_behind("A whiteboard with times tables.", notes) is None
    # The phone is in view at the door: they have it.
    assert left_behind("A hand holding a phone in a doorway.", notes)["item"] == "laptop"
    assert left_behind("A hand holding a phone and a laptop in a doorway.", notes) is None      # the keys were picked up at 19:03
    # A later sighting in a hand cancels the table.
    assert left_behind(door, notes[:2] + ["19:03 A hand holding a phone and a laptop under one arm."])["item"] == "keys"
    assert left_behind(door, ["19:02 A phone on a wooden table.", "19:03 A hand holding a phone."]) is None
    # A phone someone is holding at a table was never put down.
    assert left_behind(door, ["19:02 A person at a table holding a phone in their hand."]) is None
    # The surface has to be in the same sentence as the thing.
    assert left_behind(door, ["19:02 A phone screen showing a map. A table is in the background."]) is None
    # A saved question about the phone is not a sighting of it.
    assert left_behind(door, ["19:02 A phone on a desk.", "19:03 Asked 'is this my phone?', Iris answered: Yes, on the table."])["place"] == "desk"
    assert left_behind(door, ["19:02 An empty desk."]) is None and left_behind(door, []) is None
    assert left_at("phone", "phone, charger. A phone charging on a desk.")["place"] == "desk"
    assert left_at("phone", "Asked 'where is my phone?', Iris answered: on the table.") is None
    assert left_at("phone", "A hand holding a phone above a table.") is None
    assert leaving("Looking down a staircase.") and leaving("A city street at night.") and not leaving("A door on the far wall of an office.")

    # The same thing through the real watch loop (main.tick), with the camera, the vision model, the display and
    # memory replaced by stand-ins, so nothing leaves this machine.
    import asyncio
    import io
    import json

    from PIL import Image

    import llm
    import main

    def frame(shade):
        buf = io.BytesIO()
        Image.new("RGB", (64, 48), (shade, shade, shade)).save(buf, "JPEG")
        return buf.getvalue()

    class Screen:                       # stands in for a dashboard on the WebSocket
        def __init__(self):
            self.events = []

        async def send_json(self, msg):
            self.events.append(msg)

    class Memory:
        def __init__(self, moments=None, fail=False):
            self.moments, self.fail, self.asked = moments or {}, fail, []

        async def search(self, sid, question, target=None, quiet=False):
            self.asked.append((target, quiet))
            if self.fail:
                raise RuntimeError("memory is down")
            return {"moment": self.moments.get(target), "target": target, "top": []}

    async def loop_check():
        screen, shades = Screen(), iter(range(10, 250, 20))
        main.ahead.ON = True
        main.clients.add(screen)
        main.save_state = lambda: None
        main.save_moment = None

        async def capture(reuse_s=0.0):
            return frame(next(shades))

        async def show(text, eye=""):
            return True

        main.capture, main.show = capture, show

        async def look(sid, watch_reply, memory=None):
            async def chat(msgs, model=None, timeout=0, late=None):
                return json.dumps(watch_reply), "stand-in"
            llm.chat = chat
            main.memory_client = (lambda: memory) if memory else None
            main.watch.update(ref=None, last_call=-1e9)
            await main.tick(sid, f"f_{len(screen.events):04d}", {})
            return screen.events[-1]

        table = {"description": "A phone and a protein bar on a wooden table.", "urgency": 1, "text": "", "say": "", "topic": "desk"}
        doorway = {"description": "An open doorway leading into a corridor.", "urgency": 1, "text": "", "say": "", "topic": "doorway"}
        main.state["sessions"].pop("ahead-notes", None)
        assert (await look("ahead-notes", table))["level"] == "silent"
        d = await look("ahead-notes", doorway)
        assert (d["level"], d["text"], d["speak"]) == ("speak", "Phone's on table", "Your phone is still on the table."), d
        assert d["trace"]["ahead"]["item"] == "phone" and d["trace"]["ahead"]["place"] == "table" and d["trace"]["urgency"] == 8
        again = await look("ahead-notes", doorway)                       # still in the corridor: said once, not again
        assert again["level"] == "silent" and again["trace"]["blocked_by"] == "cooldown", again["trace"]

        # The notes say nothing about a phone, but memory saw one on a desk earlier in the session.
        main.state["sessions"].pop("ahead-memory", None)
        memory = Memory({"phone": {"id": 7, "description": "phone, charger. A phone charging on a desk.", "keyword_match": True}})
        d = await look("ahead-memory", doorway, memory)
        assert (d["level"], d["text"]) == ("speak", "Phone's on desk") and d["trace"]["ahead"]["moment_id"] == 7, d
        assert memory.asked and all(quiet for _item, quiet in memory.asked)     # asked quietly: the garden doesn't react

        # Memory down, or only a resemblance with no keyword: no nudge, and the loop carries on.
        for sid, memory in (("ahead-down", Memory(fail=True)),
                            ("ahead-vague", Memory({"phone": {"id": 9, "description": "A phone on a desk.", "keyword_match": False}}))):
            main.state["sessions"].pop(sid, None)
            d = await look(sid, doorway, memory)
            assert d["level"] == "silent" and d["trace"]["ahead"] is None, d

        # Something in view at the door matters more: Iris says that, not the phone.
        main.state["sessions"].pop("ahead-busy", None)
        await look("ahead-busy", table)
        hazard = {**doorway, "urgency": 9, "text": "Step down ahead", "say": "Careful, there's a step down.", "topic": "step"}
        d = await look("ahead-busy", hazard)
        assert d["text"] == "Step down" and d["trace"]["ahead"] is None, d

        main.ahead.ON = False                                              # switched off: the loop is as it was
        main.state["sessions"].pop("ahead-off", None)
        await look("ahead-off", table)
        assert (await look("ahead-off", doorway))["level"] == "silent"
        for sid in [k for k in main.state["sessions"] if k.startswith("ahead-")]:
            main.state["sessions"].pop(sid)

    asyncio.run(loop_check())
    print("ahead ok")
