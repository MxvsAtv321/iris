"""How text is laid out on the glasses display, and how the brain keeps a line short enough to be read there.

The display is 128x64 pixels behind a small lens. The firmware draws text in a bold sans (Adafruit GFX's
FreeSansBold), centred, inside a safe area in the middle of the screen, at the largest size that fits:

    24 pt   one line     "12g"
    18 pt   one line     "Stay in"
    12 pt   two lines    "12g protein", "Line 2: 7x8 is 56"      <- the smallest size that reads comfortably
    9 pt    three lines  anything longer (smaller than the display's old text: a last resort)

The same rule is written twice, here and in firmware/glasses_hud/glasses_hud.ino; the numbers below are the fonts'
own, produced by firmware/glasses_hud/art/make_text.py metrics. The brain uses it to know whether a line will be shown
at a comfortable size, and to shorten it at a word when it won't, so nothing is ever cut off in the middle.

The safe area can be moved and resized on the board (/calibrate); the display reports the area it is using in
/status, and the brain passes it to set_area() so both keep fitting text to the same space.

Run `python hud.py` for the self-check.
"""
import re

W, H = 128, 64
SAFE_W, SAFE_H = 116, 52           # the middle of the screen, clear of the lens's edges
DEFAULT_AREA = (SAFE_W, SAFE_H)
# cap: height of a capital letter. descent: how far g, p, y hang below the line. adv: each character's width, from space to ~.
FONTS = {
    24: {"cap": 33, "descent": 12, "adv": [13, 16, 22, 26, 26, 42, 34, 12, 16, 16, 18, 27, 12, 16, 12, 13, 26, 26, 26, 26, 26, 26, 26, 26, 26, 26, 12, 12, 27, 27, 27, 29, 46, 33, 33, 34, 34, 31, 30, 36, 35, 15, 27, 34, 29, 41, 35, 37, 32, 37, 34, 32, 30, 35, 31, 45, 32, 30, 29, 16, 13, 16, 27, 26, 12, 27, 29, 26, 29, 27, 16, 29, 28, 13, 13, 27, 13, 42, 29, 29, 29, 29, 18, 26, 16, 29, 25, 37, 26, 26, 24, 18, 13, 18, 23]},
    18: {"cap": 25, "descent": 8, "adv": [10, 12, 17, 19, 19, 31, 25, 9, 12, 12, 14, 20, 9, 12, 9, 10, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 9, 9, 20, 20, 20, 21, 34, 24, 25, 25, 25, 23, 22, 27, 26, 11, 20, 25, 22, 30, 26, 27, 24, 27, 25, 24, 23, 26, 23, 34, 24, 22, 21, 12, 10, 12, 20, 19, 9, 20, 22, 20, 22, 20, 12, 21, 21, 10, 10, 20, 9, 31, 21, 21, 22, 22, 14, 19, 12, 21, 19, 27, 19, 19, 18, 14, 10, 14, 18]},
    12: {"cap": 17, "descent": 6, "adv": [7, 8, 11, 13, 13, 21, 17, 6, 8, 8, 9, 14, 6, 8, 6, 7, 13, 14, 13, 13, 13, 13, 13, 13, 13, 13, 6, 6, 14, 14, 14, 15, 23, 17, 17, 17, 17, 16, 15, 18, 18, 7, 14, 17, 15, 21, 18, 19, 16, 19, 17, 16, 15, 18, 16, 23, 16, 15, 15, 8, 7, 8, 14, 13, 6, 14, 15, 13, 15, 14, 8, 15, 14, 7, 7, 14, 6, 21, 15, 15, 15, 15, 9, 13, 8, 15, 13, 19, 13, 13, 12, 9, 7, 9, 12]},
    9: {"cap": 12, "descent": 5, "adv": [5, 6, 9, 10, 10, 16, 13, 5, 6, 6, 7, 11, 4, 6, 4, 5, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 4, 4, 11, 11, 11, 11, 18, 13, 13, 13, 13, 12, 11, 14, 13, 6, 10, 13, 11, 16, 14, 14, 12, 14, 13, 12, 12, 13, 12, 17, 12, 12, 11, 6, 5, 6, 11, 10, 5, 10, 11, 10, 11, 10, 6, 11, 11, 5, 5, 10, 5, 16, 11, 11, 11, 11, 7, 10, 6, 11, 10, 14, 10, 10, 9, 7, 5, 7, 9]},
}
STEP = {12: 23, 9: 16}             # baseline to baseline when there is more than one line
TIERS = ((24, 1), (18, 1), (12, 2), (9, 3))
COMFORTABLE = 12                   # text at this size or larger is what the brain aims for
SWAPS = {"×": "x", "’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-",
         "…": "...", "°": " deg", " ": " "}
FILLER = re.compile(r"\b(the|a|an|about|approximately|around|roughly|your|is|are|of|that|this|it's|its|please)\b", re.I)
DANGLING = {"with", "by", "on", "in", "at", "to", "and", "or", "per", "for", "from", "says", "has", "have", "is", "are", "the", "a", "an", "of"}


def set_area(w, h):
    """Fit text to the area the display says it is using (its /status "area"). Odd values are ignored."""
    global SAFE_W, SAFE_H
    try:
        w, h = int(w), int(h)
    except (TypeError, ValueError):
        return False
    if not (48 <= w <= W and 24 <= h <= H):
        return False
    SAFE_W, SAFE_H = w, h
    return True


def clean(text):
    """Only the characters the display's font has, on one line, single-spaced."""
    t = str(text or "")
    for odd, plain in SWAPS.items():
        t = t.replace(odd, plain)
    t = "".join(c if " " <= c <= "~" else " " for c in t)
    return re.sub(r"\s+", " ", t).strip()


def width(pt, text):
    adv = FONTS[pt]["adv"]
    return sum(adv[ord(c) - 32] for c in text)


def wrap(pt, text, max_lines):
    """The text as lines no wider than the safe area, or None if it can't be done in max_lines."""
    lines, line = [], ""
    for word in text.split(" "):
        if width(pt, word) > SAFE_W:
            return None
        trial = f"{line} {word}" if line else word
        if width(pt, trial) <= SAFE_W:
            line = trial
        else:
            lines.append(line)
            line = word
    lines.append(line)
    return lines if len(lines) <= max_lines else None


def block_height(pt, lines):
    """Top of the capitals on the first line to the lowest pixel of the last."""
    f = FONTS[pt]
    hangs = any(c in "gjpqy,;" for c in lines[-1])
    return f["cap"] + (len(lines) - 1) * STEP.get(pt, 0) + (f["descent"] if hangs else 0)


def fit(text):
    """-> (point size, lines) at the largest size that fits, or None when even the smallest doesn't."""
    t = clean(text)
    if not t:
        return None
    for pt, max_lines in TIERS:
        lines = wrap(pt, t, max_lines)
        if lines and block_height(pt, lines) <= SAFE_H:
            return pt, lines
    return None


def layout(text):
    """Where each line is drawn: [(point size, line, x of its left edge, y of its baseline)], centred on the screen."""
    found = fit(text)
    if not found:
        return []
    pt, lines = found
    f, step = FONTS[pt], STEP.get(pt, 0)
    top = (H - block_height(pt, lines)) // 2
    return [(pt, line, (W - width(pt, line)) // 2, top + f["cap"] + i * step) for i, line in enumerate(lines)]


def size_of(text):
    """The point size the display will use, or 0 when the text is too long for any of them."""
    found = fit(text)
    return found[0] if found else 0


def _tidy(text):
    """Single spaces, no space before punctuation, no punctuation left hanging at either end."""
    return re.sub(r" +([,.;:!?])", r"\g<1>", re.sub(r" +", " ", text)).strip(" ,;:-")


def _small(text):
    """The words of text that the display's small built-in font can show whole (the firmware falls back to it for
    text no bold size fits): 6 pixels a character, 8 a line. "" when even the first word is too long."""
    per, max_lines = SAFE_W // 6, min(8, SAFE_H // 8)
    words = text.split(" ")
    while words:
        lines, line = 1, ""
        for w in words:
            trial = f"{line} {w}" if line else w
            if len(trial) <= per:
                line = trial
            else:
                lines, line = lines + 1, w
        if all(len(w) <= per for w in words) and lines <= max_lines:
            return " ".join(words)
        words.pop()
    return ""


def display(text):
    """The line the brain sends to the glasses: the text itself when it fits at a comfortable size, otherwise
    shortened at a word until it does. Filler words go first, then words off the end, and it never ends on a word
    like "with" or "by". Never cut inside a word, unless one word alone is wider than the display. The models are
    asked for a short line; this is the safety net."""
    t = re.sub(r" ?= ?", " = ", clean(text)).strip()        # "7x8=56" can break at the equals sign
    if size_of(t) >= COMFORTABLE:
        return t
    lean = _tidy(FILLER.sub("", t)) or t
    words = lean.split(" ")
    # a word too wide for the comfortable size ("Wednesday") is shown smaller rather than dropped
    aim = COMFORTABLE if all(width(COMFORTABLE, w) <= SAFE_W for w in words) else TIERS[-1][0]
    for whole in (t, lean):
        if size_of(whole) >= aim:
            return whole
    while len(words) > 1 and (size_of(" ".join(words)) < aim or words[-1].lower().strip(",.;:") in DANGLING):
        words.pop()
    short = _tidy(" ".join(words))
    says_something = any(w.lower().strip(",.;:") not in DANGLING for w in short.split(" "))
    if size_of(short) and says_something:
        return short
    whole = _small(lean)                     # no bold size holds a word that says anything: small, but every word whole
    if whole:
        return whole
    if size_of(short):
        return short
    while short and not size_of(short):      # one word wider than the display at any size: its start is all that fits
        short = short[:-1]
    return short


def hint():
    """A sentence for the models when the display's text area has been made much narrower than usual (/calibrate
    moved it to the edge of the screen), so they write a line that fits it. "" at the usual size."""
    if SAFE_W >= 100:
        return ""
    per = max(3, round(SAFE_W / 12))
    lines = 2 if SAFE_H >= 46 else 1
    return (f"The glasses display is very narrow right now. Its line must be at most {lines} word{'s' * (lines > 1)}, each at most "
            f'{per} characters, with no longer word in it: a number with a short unit ("12g", "210 cal", "$5"), '
            f'"Yes" or "No", or a short fix like "7x8 = 56". Never a word longer than {per} characters. '
            "Everything else goes in the spoken sentence.")


if __name__ == "__main__":
    assert fit("12g") == (24, ["12g"]) and fit("Stay in") == (18, ["Stay in"])
    assert fit("12g protein") == (12, ["12g", "protein"]) and fit("7x8 is 56") == (12, ["7x8 is 56"])
    assert fit("Line 2: 7x8 is 56") == (12, ["Line 2:", "7x8 is 56"])
    assert fit("12g protein per bar")[0] == 9 and fit("") is None            # three lines: too long to be comfortable
    assert fit("x" * 80) is None and fit("supercalifragilistic") is None
    assert all(width(pt, line) <= SAFE_W for t in ("12g protein per bar", "Phone's on the table") for pt, lines in [fit(t)] for line in lines)
    assert clean("7×8 = 54…  it’s 56") == "7x8 = 54... it's 56" and clean("café \n ok") == "caf ok"
    # centred, and inside the safe area, at every size
    for t in ("12g", "Stay in", "12g protein", "gypsy jog", "Line 2: 7x8 is 56", "Take an umbrella today"):
        placed = layout(t)
        pt = placed[0][0]
        for _pt, line, x, base in placed:
            assert (W - SAFE_W) // 2 <= x and x + width(pt, line) <= W - (W - SAFE_W) // 2, (t, line)
            assert abs((x + width(pt, line) / 2) - W / 2) <= 1, (t, line)
        top, bottom = placed[0][3] - FONTS[pt]["cap"], placed[-1][3] + (FONTS[pt]["descent"] if any(c in "gjpqy,;" for c in placed[-1][1]) else 0)
        assert (H - SAFE_H) // 2 <= top and bottom <= H - (H - SAFE_H) // 2, (t, top, bottom)
        assert abs((top + bottom) / 2 - H / 2) <= 1, (t, top, bottom)
    # the brain's line: untouched when it fits, shortened at a word when it doesn't
    assert display("12g protein") == "12g protein" and display("Line 2: 7x8 is 56") == "Line 2: 7x8 is 56"
    assert display("12g protein per bar") == "12g protein per" or size_of(display("12g protein per bar")) >= 12
    for long in ("That bar has about 12 grams of protein per serving", "Your phone is on the table by the door", "Line 2 says 7 x 8 = 54, it should be 56"):
        short = display(long)
        assert size_of(short) >= COMFORTABLE and short and all(w in clean(long).split(" ") for w in short.split(" ")), (long, short)
    assert display("") == "" and size_of(display("supercalifragilisticexpialidocious")) == 9
    assert display("Wednesday 3pm") == "Wednesday 3pm"                         # one long word: smaller, nothing dropped
    assert display("Didn't catch that, try again") != "" and display("Say that again?") == "Say that again?"
    # the display was calibrated to a smaller area: the same text now needs a smaller size, or fewer words
    assert set_area(90, 40) and (SAFE_W, SAFE_H) == (90, 40) and not set_area(10, 10) and not set_area("x", None)
    assert fit("12g")[0] == 18 and fit("Stay in")[0] == 12 and size_of(display("Line 2: 7x8 is 56")) >= 12
    # moved to the edge of the screen, the area is very narrow: whole words, never the start of one
    assert set_area(48, 48) and display("12g protein") == "12g" and display("7x8 = 56") == "7x8 = 56"
    assert display("7x8=56") == "7x8 = 56" and fit("7x8 = 56") == (12, ["7x8", "= 56"])
    assert display("Stay in") == "Stay in" and display("Step down") == "Step down"
    assert display("Phone's on table") == "Phone's on table" and fit("Phone's on table") is None     # the small font shows it
    assert display("Laptop") == "Laptop" and display("Stove on") == "Stove on"
    assert display("By laptop") == "By laptop" and display("Take umbrella") == "Take"      # never just "By"
    assert "at most 2 words, each at most 4 characters" in hint()
    assert set_area(*DEFAULT_AREA) and fit("Stay in")[0] == 18 and hint() == ""
    print("hud_text ok")
