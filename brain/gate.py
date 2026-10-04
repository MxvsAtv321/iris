"""The gate: the model proposes an urgency, these rules decide silent / display / speak.

Rules only ever make a decision quieter, and every outcome carries a reason.
Run `python gate.py` for the self-check.
"""
import re
import time

# Calibration knobs.
SPEAK_AT, DISPLAY_AT = 8, 5          # urgency thresholds
TOPIC_COOLDOWN_S = 120               # one nudge per topic per two minutes
REPEAT_WINDOW_S = 300                # how far back "already said" reaches
REPEAT_SIM = 0.6                     # share of word pairs that makes a line a repeat
SPEAK_GAP_S, DISPLAY_GAP_S = 15, 5   # rate limits
QUIET_AFTER_ANSWER_S = 10            # keep the loop off the display after an /api/ask answer
RULES = ("cooldown", "repeat", "quiet_after_answer", "rate_limit")   # the order they are checked in


def words(s):
    return re.sub(r"[^a-z0-9' ]+", " ", str(s or "").lower()).split()


def bigrams(w):
    return [w[i] + " " + w[i + 1] for i in range(len(w) - 1)]


def echo_score(text, candidates):
    """Share of `text`'s word pairs that appear in `candidates`. Word pairs, not single
    words, so lines that merely share vocabulary don't match. Under three words is
    never a repeat: too little evidence."""
    w = words(text)
    if len(w) < 3:
        return 0.0
    pool = {g for c in candidates for g in bigrams(words(c))}
    grams = bigrams(w)
    return sum(g in pool for g in grams) / len(grams) if pool else 0.0


def is_echo(text, candidates, threshold=REPEAT_SIM):
    return echo_score(text, candidates) >= threshold


def to_focus_box(box_2d):
    """[ymin, xmin, ymax, xmax] on 0-1000 (the convention the watch prompt asks for) -> [x, y, w, h] fractions, or None."""
    try:
        ymin, xmin, ymax, xmax = (min(max(float(v) / 1000, 0.0), 1.0) for v in box_2d)
    except (TypeError, ValueError):
        return None
    if xmax <= xmin or ymax <= ymin:
        return None
    return [round(xmin, 3), round(ymin, 3), round(xmax - xmin, 3), round(ymax - ymin, 3)]


class Gate:
    """One per session. Cooldowns and said-history live here, so a new session starts fresh."""

    def __init__(self):
        self.said = []       # (ts, line)
        self.topics = {}     # topic -> ts of last nudge
        self.last = {"speak": 0.0, "display": 0.0}
        self.held_at = 0.0   # last /api/ask activity

    def hold(self, line="", now=None):
        """An answer is on screen: keep the loop quiet, and remember what was said."""
        now = now or time.time()
        self.held_at = now
        if line:
            self.said = (self.said + [(now, line)])[-20:]

    def decide(self, w, now=None):
        """w: parsed watch output. Returns (level, reason)."""
        return self.explain(w, now)[:2]

    def explain(self, w, now=None):
        """decide, plus the trace the dashboard shows: the urgency against its thresholds, and every
        rule in the order it is checked. Returns (level, reason, trace).

        A rule's outcome is "passed", "blocked", "softened" (spoken line shown instead) or
        "not_checked" (urgency was under the display threshold, so there was nothing to hold back).
        All four are worked out even after one blocks; `blocked_by` names the first, which is the
        one that decided."""
        now = now or time.time()
        rules = [{"rule": r, "outcome": "not_checked", "detail": ""} for r in RULES]
        trace = {"urgency": None, "display_at": DISPLAY_AT, "speak_at": SPEAK_AT, "proposed": "silent",
                 "rules": rules, "blocked_by": None}
        try:
            u = int(float(w.get("urgency", 0)))
        except (TypeError, ValueError, AttributeError):
            return "silent", "bad model output", trace
        why = str(w.get("reason") or w.get("description") or "")[:100]
        reason = f"urgency {u}: {why}"
        level = "speak" if u >= SPEAK_AT else "display" if u >= DISPLAY_AT else "silent"
        trace.update(urgency=u, proposed=level)
        if level == "silent":
            return level, reason, trace

        topic = str(w.get("topic") or "")
        line = str(w.get("say") or w.get("text") or "")
        cooldown, repeat, quiet, rate = rules

        since = now - self.topics.get(topic, -1e9)
        if topic and since < TOPIC_COOLDOWN_S:
            cooldown.update(outcome="blocked", detail=f"nudged about '{topic}' {since:.0f} s ago; one per {TOPIC_COOLDOWN_S} s")
        else:
            cooldown.update(outcome="passed", detail=f"no nudge about '{topic}' in the last {TOPIC_COOLDOWN_S} s")

        recent = [l for t, l in self.said if now - t < REPEAT_WINDOW_S]
        sim, match = max(((echo_score(line, [l]), l) for l in recent), default=(0.0, ""))
        repeat.update(similarity=round(sim, 2), threshold=REPEAT_SIM)
        if sim >= REPEAT_SIM:
            repeat.update(outcome="blocked", detail=f"already said '{match}'")
        else:
            repeat.update(outcome="passed", detail=f"not said in the last {REPEAT_WINDOW_S // 60} minutes")

        since = now - self.held_at
        if since < QUIET_AFTER_ANSWER_S:
            quiet.update(outcome="blocked", detail=f"answered a question {since:.0f} s ago; quiet for {QUIET_AFTER_ANSWER_S} s")
        else:
            quiet.update(outcome="passed", detail=f"no answer in the last {QUIET_AFTER_ANSWER_S} s")

        softened = level == "speak" and now - self.last["speak"] < SPEAK_GAP_S
        since = now - self.last["display"]
        if (softened or level == "display") and since < DISPLAY_GAP_S:
            rate.update(outcome="blocked", detail=f"showed a line {since:.0f} s ago; one per {DISPLAY_GAP_S} s")
        elif softened:
            rate.update(outcome="softened", detail=f"spoke {now - self.last['speak']:.0f} s ago; one spoken line per {SPEAK_GAP_S} s, so shown instead")
        else:
            rate.update(outcome="passed", detail=f"nothing {'spoken' if level == 'speak' else 'shown'} in the last "
                                                 f"{SPEAK_GAP_S if level == 'speak' else DISPLAY_GAP_S} s")

        trace["blocked_by"] = next((r["rule"] for r in rules if r["outcome"] == "blocked"), None)
        if trace["blocked_by"]:
            return "silent", {"cooldown": f"cooldown on '{topic}'",
                              "repeat": f"repeat of '{match}' (sim {sim:.1f})",
                              "quiet_after_answer": "quiet after answer",
                              "rate_limit": "display rate limit"}[trace["blocked_by"]], trace
        if softened:
            level, reason = "display", reason + " (speak rate limit)"

        self.topics[topic] = now
        self.last[level] = self.last["display"] = now
        self.said = (self.said + [(now, line)])[-20:]
        return level, reason, trace


if __name__ == "__main__":
    g, t = Gate(), 1000.0
    nudge = {"urgency": 9, "topic": "whiteboard-math", "say": "Line 2 has a math error: 7 times 8 is 56"}
    assert g.decide(nudge, t)[0] == "speak"
    level, reason = g.decide(nudge, t + 10)
    assert level == "silent" and "cooldown" in reason, reason
    reworded = {"urgency": 9, "topic": "board-error", "say": "Check line 2, math error: 7 times 8 is 56"}
    level, reason = g.decide(reworded, t + 20)
    assert level == "silent" and "repeat" in reason, reason
    assert not is_echo("yes ok", ["yes ok"])
    assert g.decide({"urgency": 2}, t)[0] == "silent"
    assert g.decide({"urgency": "high"}, t) == ("silent", "bad model output")
    assert to_focus_box([100, 200, 300, 600]) == [0.2, 0.1, 0.4, 0.2]
    assert to_focus_box([300, 200, 100, 600]) is None      # zero/negative area
    assert to_focus_box([1, 2]) is None and to_focus_box(None) is None
    assert to_focus_box([-50, 0, 1200, 500]) == [0.0, 0.0, 0.5, 1.0]  # clamped
    h = Gate()
    h.hold("12g protein per bar", now=t)
    assert h.decide({"urgency": 9, "topic": "x", "say": "Watch the stove, it is on"}, t + 3)[1] == "quiet after answer"

    # The trace: every rule in order, and the first one that blocked.
    g = Gate()
    level, _, tr = g.explain(nudge, t)
    assert level == "speak" and tr["blocked_by"] is None and tr["proposed"] == "speak"
    assert [r["rule"] for r in tr["rules"]] == list(RULES) and {r["outcome"] for r in tr["rules"]} == {"passed"}
    assert (tr["urgency"], tr["display_at"], tr["speak_at"]) == (9, DISPLAY_AT, SPEAK_AT)
    level, _, tr = g.explain(reworded, t + 20)
    outcome = {r["rule"]: r["outcome"] for r in tr["rules"]}
    assert level == "silent" and tr["blocked_by"] == "repeat" and outcome["cooldown"] == "passed"
    assert tr["rules"][1]["similarity"] >= REPEAT_SIM and tr["rules"][1]["threshold"] == REPEAT_SIM
    level, reason, tr = g.explain({"urgency": 9, "topic": "stove", "say": "The stove is still on behind you"}, t + 8)
    assert level == "display" and "speak rate limit" in reason and tr["rules"][3]["outcome"] == "softened"
    level, reason, tr = g.explain({"urgency": 6, "topic": "price", "text": "Oat milk is two for five"}, t + 9)
    assert (level, reason, tr["blocked_by"]) == ("silent", "display rate limit", "rate_limit")
    level, _, tr = g.explain({"urgency": 2}, t)
    assert level == "silent" and tr["blocked_by"] is None and {r["outcome"] for r in tr["rules"]} == {"not_checked"}
    assert g.explain({"urgency": "high"}, t)[2]["urgency"] is None
    print("gate ok")
