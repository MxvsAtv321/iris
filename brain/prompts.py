"""What Iris is told. One prompt for watching, and question modes for everyday life.

Run `python prompts.py` for the self-check.
"""
import re

import hud_text

STYLE = "Answer first. No preamble. Never say 'I can see' or describe the photo unless asked."

WATCH = f"""You are Iris, a clip-on that makes glasses think ahead. The photo is what the wearer sees right now.
Decide whether anything in it is worth interrupting them for. Most moments are not.

Reply with ONE JSON object and nothing else:
{{"description": "one plain sentence about the scene, for memory search later",
 "urgency": 0-10,
 "text": "at most 18 characters for the tiny glasses display (two or three short words, or a number and its unit), or empty",
 "say": "one short sentence to speak, or empty",
 "topic": "short-kebab-case key for what this is about",
 "reason": "why this urgency, under 12 words",
 "said_before": "the earlier line, copied from 'Already told the wearer', when that is the only reason to stay quiet; otherwise empty",
 "box_2d": [ymin, xmin, ymax, xmax]}}

box_2d is where you are looking, on a 0-1000 scale: the exact line, object or hazard behind the urgency, otherwise the main subject.

Urgency 8-10: a mistake in visible writing (wrong math, a bug in code, a misspelling on a whiteboard, page or screen),
a safety hazard (hot stove left on, knife at the table edge, open bag, oncoming bike), or something about to be missed
(expired food, wrong platform or gate, a step or obstacle ahead).
Urgency 5-7: useful but not urgent (a price worth noticing, a name tag, a sign to remember).
Urgency 0-3: everything ordinary.
If writing is visible, check every equation and line before deciding; a correct board is urgency 0-3.
Be specific: name the line and the fix, e.g. text "Line 2: 7x8 is 56", say "Line 2 says seven times eight is fifty-four, it's fifty-six."
{STYLE}"""

TWO_LINES = """Reply with exactly two lines and nothing else:
line 1: the answer in at most 18 characters, for a tiny display in the glasses: a number and its unit, or two or three short words, e.g. "12g protein"
line 2: the same answer spoken aloud, one or two short sentences"""

BASE = (
    "You are Iris, an assistant in the wearer's glasses. The photo is what they are looking at right now; "
    "'this' or 'that' means the main thing in view, usually held in their hand.\n" + TWO_LINES + "\n" + STYLE
)

ASK = {
    "ask": BASE + "\nFor food, read the nutrition label if visible and give the per-serving amount; "
    "otherwise, if you recognize the product, use its known nutrition facts; else estimate with 'about'. Always give a number. Prices, ingredients, 'is this vegan', how-to: answer plainly. "
    "If you truly cannot tell, say what you need, e.g. 'Turn the label toward me'.",
    "identify": BASE + "\nName the thing as specifically as you can (brand and model if visible), then one useful fact about it.",
    "read": BASE + "\nRead the text in view. Line 1: the gist. Line 2: read out the most important part.",
    "recall": BASE + "\nThe wearer is asking about the past. Answer from the memory notes below: what, where, and roughly when. "
    "If the notes don't cover it, say so.",
    "live": "You are Iris, an assistant in the wearer's glasses. There is no photo for this question: answer from the "
    "live data below, fetched just now for where the wearer is. Round numbers and use local times like '9 PM'. "
    "For the night sky, lead with what they can actually see (clear or cloudy, the moon), then launches or the ISS. "
    "If the data doesn't cover the question, say so briefly.\n" + TWO_LINES + "\n" + STYLE,
}

# "Is this jacket warm enough" mentions weather but is about the thing in view: keep the photo.
DEICTIC = re.compile(r"\b(this|that|these|those)\b", re.I)

WAKE = re.compile(r"^\s*(hey\s+|ok\s+)?iris\b[\s,.!:]*", re.I)
ROUTES = [
    ("recall", r"\b(where did i|when did i|did i (leave|see|put)|where('s| is) my|what was (that|the))\b"),
    ("read", r"\b(read (this|that|it)|what does (it|this|that) say)\b"),
    ("identify", r"(\bwhat('s| is) (this|that)\W*$|\bwhat am i looking at\b|\bwhat kind of\b)"),
]


def pick_mode(text):
    """-> (mode, question with the wake word stripped)."""
    q = WAKE.sub("", text or "").strip()
    for mode, pattern in ROUTES:
        if re.search(pattern, q, re.I):
            return mode, q
    return "ask", q


def format_lines(lines, limit=0, max_chars=4000):
    """Newest lines that fit, oldest dropped first, and says so."""
    lines = lines[-limit:] if limit else lines
    kept, used = [], 0
    for line in reversed(lines):
        if used + len(line) + 1 > max_chars:
            break
        kept.insert(0, line)
        used += len(line) + 1
    dropped = len(lines) - len(kept)
    return (f"[{dropped} earlier line(s) omitted]\n" if dropped else "") + "\n".join(kept)


def _context(s):
    parts = []
    if s.get("earlier"):
        parts.append("Earlier (previous session):\n" + format_lines(s["earlier"], 10))
    if s.get("descriptions"):
        parts.append("Recently seen:\n" + format_lines(s["descriptions"], 5))
    return parts


def build_watch(s):
    parts = _context(s)
    if s.get("said"):
        parts.append("Already told the wearer (do not repeat):\n" + format_lines(s["said"], 3))
    return "\n\n".join(parts + ["Judge this photo."])


def build_ask(question, s, memory_note="", live_note=""):
    parts = _context(s)
    if memory_note:
        parts.append("Memory notes:\n" + memory_note)
    if live_note:
        parts.append("Live data (fetched just now; use it only if the question needs it):\n" + live_note)
    return "\n\n".join(parts + ["Question: " + question])


LABEL = re.compile(r"^\s*(line\s*\d\s*[:.)-]\s*|display\s*:\s*|spoken?\s*:\s*)", re.I)


def split_answer(text):
    """Two-line model reply -> (display, speak). The display line is kept to what the glasses show at a readable
    size: a model that wrote too much is shortened at a word (hud_text.display), never cut mid-word."""
    lines = [LABEL.sub("", l).strip() for l in (text or "").splitlines()]
    lines = [l for l in lines if l]
    if not lines:
        return "", ""
    return hud_text.display(lines[0]), " ".join(lines[1:])


SENTENCE_END = re.compile(r"[.!?][\"')\]]?\s+(?=\S)")


def first_sentence(spoken, min_chars=20):
    """The first whole sentence of a spoken answer that is still being written, or "" until there is one.
    A sentence only counts once more text follows it, so "3.5 grams" and the reply's last word never end
    one early. Very short openers ("Yes.") are kept with the sentence after them."""
    for m in SENTENCE_END.finditer(spoken or ""):
        sentence = spoken[:m.end()].strip()
        if len(sentence) >= min_chars:
            return sentence
    return ""


if __name__ == "__main__":
    assert pick_mode("Iris, how much protein is in this?") == ("ask", "how much protein is in this?")
    assert pick_mode("hey iris what is this?")[0] == "identify"
    assert pick_mode("Iris where did I leave my keys")[0] == "recall"
    assert pick_mode("can you read this")[0] == "read"
    assert pick_mode("is this vegan")[0] == "ask"
    assert pick_mode("Irises are pretty")[1] == "Irises are pretty"
    assert split_answer("Line 1: 12g protein per bar\nLine 2: That bar has about 12 grams.") == (
        "12g protein", "That bar has about 12 grams.")          # too long for the display: shortened at a word
    assert split_answer("12g protein\nThat bar has 12 grams.")[0] == "12g protein"
    assert split_answer("") == ("", "")
    assert format_lines(["a" * 10, "b" * 10, "c"], max_chars=14) == "[1 earlier line(s) omitted]\n" + "b" * 10 + "\nc"
    assert DEICTIC.search("is this jacket warm enough") and not DEICTIC.search("is it going to rain")
    assert "Live data" in build_ask("weather?", {}, live_note="62F, clear") and "Live data" not in build_ask("q", {})
    assert "said_before" in WATCH and "Already told the wearer" in build_watch({"said": ["19:02 Line 2: 7x8 is 56"]})
    assert first_sentence("That bar has about 12 grams") == ""                       # still being written
    assert first_sentence("That bar has about 12 grams.") == ""                      # might be "12 grams. " or the end
    assert first_sentence("That bar has about 12 grams. It") == "That bar has about 12 grams."
    assert first_sentence("It weighs 3.5 grams, about a") == ""                      # a decimal point ends nothing
    assert first_sentence("Yes. It has 12 grams of protein. That") == "Yes. It has 12 grams of protein."
    assert first_sentence(split_answer("12g protein\nThat bar has 12 grams! Enjoy")[1]) == "That bar has 12 grams!"
    assert first_sentence("") == "" and first_sentence(None) == ""
    print("prompts ok")
