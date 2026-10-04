"""Iris Memory on Agentverse: "where did I see X?", answered from what the glasses saved.

Every frame the glasses describe is kept in Iris's memory (Neon Postgres with pgvector, photos in
Neon Object Storage). This agent searches it and says where and when the thing was last seen.

  python agent_memory.py          # run
  python agent_memory.py address  # print the agent address and stop
  python agent_memory.py check    # self-check, no network

Which session it searches: one named in the message ("... session judge-02"), else the session
running on the brain, else MEMORY_AGENT_SESSION, else judge-01.
"""
import os
import re
import sys
from datetime import datetime, timezone

import httpx

import agent_kit

BRAIN = os.getenv("BRAIN_URL") or "http://127.0.0.1:8000"
DEFAULT_SESSION = os.getenv("MEMORY_AGENT_SESSION") or "judge-01"
DESCRIPTION = (
    "Finds where and when Iris glasses last saw something: keys, a phone, a bottle, a sign. "
    "Searches the moments the glasses saved and answers with the place, the time and the photo."
)
GREETING = ("Ask me where you last saw something, for example: where did I leave my keys? "
            "I search what the Iris glasses saved and tell you where and when.")
NAMED_SESSION = re.compile(r"[\s,;(]*\b(?:in |for )?session[:=\s]+([A-Za-z0-9][\w.-]{0,79})\)?\s*$", re.I)
PHRASE = (
    "You are the memory of a pair of smart glasses. Answer the wearer's question from the saved moments below, "
    "newest first. Say where the thing was and when, in one or two short sentences, using the time given. "
    "Only use what the moments say. If none of them shows the thing, say you have not seen it."
)


def split_session(text):
    """'where are my keys? session judge-02' -> ('where are my keys?', 'judge-02'). No session named -> (text, None)."""
    m = NAMED_SESSION.search(text or "")
    if not m:
        return (text or "").strip(), None
    return text[:m.start()].strip(), m.group(1)


def when(captured_at, now=None):
    """'2026-10-04T01:12:00Z' -> '9:12 PM (35 minutes ago)', in the laptop's time zone."""
    try:
        at = datetime.fromisoformat(str(captured_at).replace("Z", "+00:00"))
    except ValueError:
        return ""
    now = now or datetime.now(timezone.utc)
    minutes = max(0, int((now - at).total_seconds() // 60))
    ago = ("just now" if minutes < 1 else f"{minutes} minute{'s' * (minutes != 1)} ago" if minutes < 90
           else f"{minutes // 60} hours ago" if minutes < 48 * 60 else f"{minutes // 1440} days ago")
    return f"{at.astimezone().strftime('%-I:%M %p')} ({ago})"


def plain(target, moment, now=None):
    """The answer with no model: what memory found, as it is."""
    if not moment:
        return f"I haven't seen {target or 'that'} in what the glasses saved."
    return f"Last seen at {when(moment.get('captured_at'), now)}: {moment.get('description', '').strip()}"


async def current_session(http):
    try:
        r = await http.get(f"{BRAIN}/api/scene", timeout=1.5)
        return r.json().get("session_id") or None
    except Exception:  # noqa: BLE001 - the brain isn't running; memory is still reachable
        return None


async def answer(text, sender, search=None, now=None):
    """-> the reply. `search(session, question)` is the memory search; the default asks Iris's memory."""
    question, named = split_session(text)
    async with httpx.AsyncClient() as http:
        session = named or await current_session(http) or DEFAULT_SESSION
    if search is None:
        from memory.adapter import shared_async_client
        search = shared_async_client().search
    result = await search(session, question)
    moment, target = result.get("moment"), result.get("target") or ""
    if result.get("error"):
        return "I can't reach Iris's memory right now. Try again in a moment."
    reply, model = plain(target, moment, now), None
    if moment:
        notes = "\n".join(f"- {when(m.get('captured_at'), now)}: {m.get('description', '')}"
                          for m in [moment] + [t for t in result.get("top", []) if t.get("id") != moment.get("id")][:2])
        try:
            said, model = await agent_kit.think(PHRASE, f"Question: {question}\n\nSaved moments:\n{notes}", timeout=4, max_tokens=120)
            reply = said or reply
        except Exception:  # noqa: BLE001 - no model: the plain answer is still right
            model = None
    lines = [reply]
    if moment and moment.get("image_url"):
        lines.append(f"Photo: {moment['image_url']}")
    lines.append(f"Searched session {session} for \"{target or question}\""
                 + (f"; phrased by {agent_kit.engine(model)}." if model else "."))
    return "\n".join(lines)


def make():
    return agent_kit.build(
        name="Iris Memory",
        handle=(os.getenv("MEMORY_AGENT_HANDLE") or "iris-memory").strip() or "iris-memory",
        port=int(os.getenv("MEMORY_AGENT_PORT") or 8002),
        description=DESCRIPTION,
        readme="agent_memory_readme.md",
        categories="memory,glasses,recall,lost-and-found,wearable",
        answer=answer,
        greeting=GREETING,
        seed_env="MEMORY_AGENT_SEED_PHRASE",
        seed_file=".agent_seed_memory",
    )


def check():
    import asyncio

    assert split_session("where are my keys? session judge-02") == ("where are my keys?", "judge-02")
    assert split_session("where are my keys (session: memtest-2229)") == ("where are my keys", "memtest-2229")
    assert split_session("where was the jam session") == ("where was the jam session", None)
    assert split_session("where did I leave my phone?") == ("where did I leave my phone?", None)
    now = datetime(2026, 10, 4, 1, 47, tzinfo=timezone.utc)
    assert "(35 minutes ago)" in when("2026-10-04T01:12:00Z", now) and when("nonsense") == ""
    assert "(just now)" in when("2026-10-04T01:46:40Z", now) and "(3 hours ago)" in when("2026-10-03T22:40:00Z", now)
    moment = {"id": 15, "captured_at": "2026-10-04T01:12:00Z", "description": "red umbrella, coat rack. By the door.",
              "image_url": "https://memory.example/api/memory/moments/15/image?session_id=s"}
    assert plain("umbrella", moment, now).endswith("red umbrella, coat rack. By the door.")
    assert plain("phone", None) == "I haven't seen phone in what the glasses saved."

    async def run():
        real = agent_kit.think
        asked = []

        async def found(session, question):
            asked.append((session, question))
            return {"moment": moment, "target": "umbrella", "top": [moment]}

        async def nothing(session, question):
            return {"moment": None, "target": "phone", "top": []}

        async def down(session, question):
            return {"moment": None, "target": "", "top": [], "error": "timed out"}

        async def no_model(*a, **k):
            raise RuntimeError("no model")

        async def asi(system, text, **k):
            assert "red umbrella" in text and "Question: where did I leave my umbrella?" in text
            return "Your umbrella is on the coat rack by the door.", "asi:asi1-mini"

        agent_kit.think = no_model
        reply = await answer("where did I leave my umbrella? session memtest-2229", "agent1q", found, now)
        assert asked == [("memtest-2229", "where did I leave my umbrella?")]
        assert reply.splitlines()[0].startswith("Last seen at") and "Photo: https://memory.example" in reply
        assert reply.endswith('Searched session memtest-2229 for "umbrella".')
        agent_kit.think = asi
        reply = await answer("where did I leave my umbrella? session memtest-2229", "agent1q", found, now)
        assert reply.splitlines()[0] == "Your umbrella is on the coat rack by the door." and reply.endswith("phrased by ASI:One.")
        assert (await answer("where is my phone? session s", "agent1q", nothing)).startswith("I haven't seen phone")
        assert (await answer("where is my phone? session s", "agent1q", down)).startswith("I can't reach Iris's memory")
        agent_kit.think = real

    asyncio.run(run())
    print("memory agent ok")


if __name__ == "__main__":
    if sys.argv[1:2] == ["check"]:
        check()
    else:
        agent_kit.main(make())
