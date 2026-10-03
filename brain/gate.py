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
        now = now or time.time()
        try:
            u = int(float(w.get("urgency", 0)))
        except (TypeError, ValueError, AttributeError):
            return "silent", "bad model output"
        why = str(w.get("reason") or w.get("description") or "")[:100]
        reason = f"urgency {u}: {why}"
        level = "speak" if u >= SPEAK_AT else "display" if u >= DISPLAY_AT else "silent"
        if level == "silent":
            return level, reason

        topic = str(w.get("topic") or "")
        line = str(w.get("say") or w.get("text") or "")
        if topic and now - self.topics.get(topic, -1e9) < TOPIC_COOLDOWN_S:
            return "silent", f"cooldown on '{topic}'"
        recent = [l for t, l in self.said if now - t < REPEAT_WINDOW_S]
        sim, match = max(((echo_score(line, [l]), l) for l in recent), default=(0.0, ""))
        if sim >= REPEAT_SIM:
            return "silent", f"repeat of '{match}' (sim {sim:.1f})"
        if now - self.held_at < QUIET_AFTER_ANSWER_S:
            return "silent", "quiet after answer"
        if level == "speak" and now - self.last["speak"] < SPEAK_GAP_S:
            level, reason = "display", reason + " (speak rate limit)"
        if level == "display" and now - self.last["display"] < DISPLAY_GAP_S:
            return "silent", "display rate limit"

        self.topics[topic] = now
        self.last[level] = self.last["display"] = now
        self.said = (self.said + [(now, line)])[-20:]
        return level, reason


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
    print("gate ok")
