"""Iris Restraint on Agentverse: should this moment interrupt someone? Silent, show a line, or speak.

The gate Iris glasses run on every frame, offered as a service. Describe a moment in words and it
scores the urgency and applies the four rules; send JSON with an urgency and the rules alone decide.

  python agent_gate.py          # run
  python agent_gate.py address  # print the agent address and stop
  python agent_gate.py check    # self-check, no network
"""
import json
import os
import re
import sys
from collections import OrderedDict

import agent_kit
import gate

DESCRIPTION = (
    "Decides whether a moment is worth interrupting someone for: stay silent, show one line, or speak. "
    "The restraint gate from Iris glasses, with its urgency score and every rule's outcome."
)
GREETING = ("Describe a moment and I'll say whether it is worth interrupting someone for: stay silent, show one line, "
            "or speak. For example: the whiteboard in front of me says 7 x 8 = 54.")
SCORE = f"""You are the judgement of Iris, a clip-on that makes glasses think ahead. Someone describes what a person
is looking at right now. Decide whether anything in it is worth interrupting them for. Most moments are not.

Reply with ONE JSON object and nothing else:
{{"description": "one plain sentence about the scene",
 "urgency": 0-10,
 "text": "under 40 characters for a glasses display, or empty",
 "say": "one short sentence to speak, or empty",
 "topic": "short-kebab-case key for what this is about",
 "reason": "why this urgency, under 12 words"}}

Urgency 8-10: a mistake in visible writing (wrong math, a bug in code, a misspelling), a safety hazard (a stove left on,
a knife at the table edge, an oncoming bike), or something about to be missed (expired food, the wrong platform or gate).
Urgency 5-7: useful but not urgent (a price worth noticing, a name tag, a sign to remember).
Urgency 0-3: everything ordinary.
Be specific: name the line and the fix, e.g. text "Line 2: 7x8 is 56"."""
HAZARD = re.compile(r"\b(fire|smoke|burner on|stove (is |left )?on|left on|knife|about to fall|oncoming|expired|wrong platform|"
                    r"wrong gate|leaking|gas smell|unattended)\b", re.I)
MISTAKE = re.compile(r"\b(mistake|error|wrong|typo|misspell\w*|bug|incorrect)\b", re.I)
EQUATION = re.compile(r"(\d+)\s*(?:x|×|\*|times)\s*(\d+)\s*(?:=|is|equals)\s*(\d+)", re.I)
NOTABLE = re.compile(r"\b(price|sale|discount|name tag|sign|deadline|due|reminder|meeting)\b", re.I)
RULE_NAME = {"cooldown": "cooldown", "repeat": "repeat", "quiet_after_answer": "quiet after an answer", "rate_limit": "rate limit"}
gates = OrderedDict()   # sender -> gate.Gate: each conversation has its own cooldowns and its own "already said"
GATES_KEPT = 200


def gate_for(sender):
    g = gates.get(sender) or gate.Gate()
    gates[sender] = g
    gates.move_to_end(sender)
    while len(gates) > GATES_KEPT:
        gates.popitem(last=False)
    return g


def from_json(text):
    """A moment sent as JSON, or None if the message is plain words."""
    t = (text or "").strip()
    if not t.startswith("{"):
        return None
    try:
        w = json.loads(t)
    except ValueError:
        return None
    return w if isinstance(w, dict) else None


def by_rules(text):
    """A score with no model: arithmetic that can be checked, then words that name a hazard or a mistake."""
    t = (text or "").strip()
    w = {"description": t[:200], "urgency": 2, "text": "", "say": "", "topic": "ordinary", "reason": "nothing unusual described"}
    m = EQUATION.search(t)
    if m and int(m.group(1)) * int(m.group(2)) != int(m.group(3)):
        a, b = int(m.group(1)), int(m.group(2))
        w.update(urgency=9, topic="math-error", reason="arithmetic error in visible writing",
                 text=f"{a}x{b} is {a * b}", say=f"{a} times {b} is {a * b}, not {m.group(3)}.")
    elif HAZARD.search(t):
        w.update(urgency=9, topic="hazard", reason="a safety hazard", text="Check that now", say=f"Heads up: {t[:120]}")
    elif MISTAKE.search(t):
        w.update(urgency=8, topic="mistake", reason="a mistake in view", text="Check that again", say=f"Take another look: {t[:120]}")
    elif NOTABLE.search(t):
        w.update(urgency=5, topic="worth-noting", reason="useful but not urgent", text=t[:40])
    return w


async def score(text):
    """-> (watch dict, who scored it). ASI:One when it answers, the rules above when no model does."""
    try:
        raw, model = await agent_kit.think(SCORE, text, timeout=5, max_tokens=300)
        import llm
        w = llm.parse_json(raw)
        if isinstance(w, dict) and "urgency" in w:
            return w, agent_kit.engine(model)
    except Exception:  # noqa: BLE001 - no model: the rules still give a verdict
        pass
    return by_rules(text), "rules, no model"


def verdict(level, w, trace, scored_by):
    line = str(w.get("say") or w.get("text") or "").strip()
    shown = str(w.get("text") or w.get("say") or "").strip()[:40]
    if level == "speak":
        head = f'Speak: "{line}"'
    elif level == "display":
        head = f'Show a line: "{shown}"'
    elif trace["blocked_by"]:
        rule = next(r for r in trace["rules"] if r["rule"] == trace["blocked_by"])
        head = f"Stay silent. Held back by the {RULE_NAME[rule['rule']]} rule: {rule['detail']}."
    else:
        head = "Stay silent."
    lines = [head]
    if trace["urgency"] is None:
        lines.append("I couldn't read an urgency for that moment, so the answer is silence.")
    else:
        why = str(w.get("reason") or "").strip().rstrip(".")
        lines.append(f"Urgency {trace['urgency']} of 10{': ' + why if why else ''}. "
                     f"Speaks at {trace['speak_at']}, shows at {trace['display_at']}.")
    if any(r["outcome"] != "not_checked" for r in trace["rules"]):
        lines.append("Rules: " + ", ".join(f"{RULE_NAME[r['rule']]} {r['outcome'].replace('_', ' ')}" for r in trace["rules"]) + ".")
    lines.append(f"Scored by {scored_by}.")
    return "\n".join(lines)


async def answer(text, sender, now=None):
    w = from_json(text)
    if w is not None and "urgency" in w:
        scored_by = "the sender"                     # the rules alone decide: no model call
    else:
        w, scored_by = await score(str((w or {}).get("description") or text))
    level, _reason, trace = gate_for(sender).explain(w, now)
    return verdict(level, w, trace, scored_by)


def make():
    return agent_kit.build(
        name="Iris Restraint",
        handle=(os.getenv("GATE_AGENT_HANDLE") or "iris-restraint").strip() or "iris-restraint",
        port=int(os.getenv("GATE_AGENT_PORT") or 8003),
        description=DESCRIPTION,
        readme="agent_gate_readme.md",
        categories="attention,notifications,interruption,glasses,wearable",
        answer=answer,
        greeting=GREETING,
        seed_env="GATE_AGENT_SEED_PHRASE",
        seed_file=".agent_seed_gate",
    )


def check():
    import asyncio

    assert by_rules("the whiteboard says 7 x 8 = 54")["urgency"] == 9 and by_rules("the board says 7 x 8 = 56")["urgency"] == 2
    assert by_rules("a pan on the stove with the burner on, nobody around")["topic"] == "hazard"
    assert by_rules("a coffee cup on my desk")["urgency"] == 2 and by_rules("a sale sign: 40% off")["urgency"] == 5
    assert from_json('{"urgency": 9}') == {"urgency": 9} and from_json("hello") is None and from_json("{broken") is None

    async def run():
        real = agent_kit.think

        async def no_model(*a, **k):
            raise RuntimeError("no model")

        async def asi(system, text, **k):
            return ('{"description": "a whiteboard", "urgency": 9, "text": "Line 2: 7x8 is 56", "topic": "whiteboard-math", '
                    '"say": "Line 2 says seven times eight is fifty-four. It\'s fifty-six.", "reason": "arithmetic error"}', "asi:asi1-mini")

        agent_kit.think = asi
        t = 1000.0
        first = await answer("The whiteboard in front of me says 7 x 8 = 54.", "alice", t)
        assert first.startswith('Speak: "Line 2 says seven times eight') and "Urgency 9 of 10: arithmetic error" in first
        assert "cooldown passed" in first and first.endswith("Scored by ASI:One.")
        again = await answer("The whiteboard in front of me says 7 x 8 = 54.", "alice", t + 10)
        assert again.startswith("Stay silent. Held back by the cooldown rule") and "cooldown blocked" in again
        other = await answer("The whiteboard in front of me says 7 x 8 = 54.", "bob", t + 10)     # each sender has its own gate
        assert other.startswith("Speak:")
        agent_kit.think = no_model
        calm = await answer("I'm looking at a coffee cup on my desk.", "carol", t)
        assert calm.splitlines()[0] == "Stay silent." and "Urgency 2 of 10" in calm and calm.endswith("Scored by rules, no model.")
        assert "Rules:" not in calm                                           # nothing to hold back, so no rule was checked
        sent = await answer('{"description": "price tag", "urgency": 6, "topic": "price", "text": "Oat milk $3.49"}', "dave", t)
        assert sent.startswith('Show a line: "Oat milk $3.49"') and sent.endswith("Scored by the sender.")
        unscored = await answer('{"description": "the board says 7 x 8 = 54"}', "erin", t)         # JSON without urgency is scored
        assert unscored.startswith("Speak:") and "56" in unscored
        bad = await answer('{"urgency": "lots"}', "frank", t)
        assert bad.startswith("Stay silent.") and "couldn't read an urgency" in bad
        agent_kit.think = real

    asyncio.run(run())
    print("gate agent ok")


if __name__ == "__main__":
    if sys.argv[1:2] == ["check"]:
        check()
    else:
        agent_kit.main(make())
