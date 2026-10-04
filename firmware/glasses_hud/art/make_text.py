"""
Previews of text on the glasses display, drawn with the same fonts and the same fitting rule as the firmware.

    python make_text.py metrics                 # the font measurements brain/hud.py needs (paste its output there)
    python make_text.py preview "12g protein"   # one PNG per message into preview/, six times life size
    python make_text.py sheet                   # preview/text_sizes.png: the standard examples on one sheet
    python make_text.py examples                # preview/text_examples.png: real answers and nudges, and the eye beside them
    python make_text.py test                    # preview/test_pattern.png: what /test draws

The fonts are Adafruit GFX's FreeSansBold at 9, 12, 18 and 24 pt, read from the Arduino library's own headers, so a
preview shows the exact pixels the board will light. The fitting rule lives in brain/hud.py and is shared with the brain.
"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent.parent / "brain"))
FONT_DIR = Path.home() / "Documents/Arduino/libraries/Adafruit_GFX_Library/Fonts"
SIZES = (24, 18, 12, 9)
W, H = 128, 64


def load(pt):
    """A GFX font header -> {"glyphs": {char: (width, height, advance, x offset, y offset, rows of bits)}}"""
    src = (FONT_DIR / f"FreeSansBold{pt}pt7b.h").read_text()
    data = bytes(int(b, 16) for b in re.findall(r"0x[0-9A-Fa-f]{2}", src.split("Bitmaps[] PROGMEM = {")[1].split("};")[0]))
    rows = re.findall(r"\{\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(-?\d+),\s*(-?\d+)\s*\}", src.split("Glyphs[] PROGMEM = {")[1])
    glyphs = {}
    for code, row in enumerate(rows, 0x20):
        at, w, h, adv, xo, yo = map(int, row)
        bits = "".join(f"{b:08b}" for b in data[at:at + (w * h + 7) // 8])
        glyphs[chr(code)] = (w, h, adv, xo, yo, [bits[r * w:(r + 1) * w] for r in range(h)])
    return {"pt": pt, "glyphs": glyphs}


FONTS = {pt: load(pt) for pt in SIZES}


def metrics():
    out = []
    for pt in SIZES:
        g = FONTS[pt]["glyphs"]
        out.append(f'    {pt}: {{"cap": {-g["H"][4]}, "descent": {g["g"][1] + g["g"][4]}, '
                   f'"adv": {[g[chr(c)][2] for c in range(0x20, 0x7F)]}}},')
    return "FONTS = {\n" + "\n".join(out) + "\n}"


def area(offset, size=None):
    """The content area the board uses once /calibrate has moved it: never wider than what is left of the screen."""
    import hud_text as hud
    w, h = size or hud.DEFAULT_AREA
    return min(w, W - 2 * abs(offset[0])), min(h, H - 2 * abs(offset[1]))


def draw(text, offset=(0, 0), box=False, size=None):
    """The 128x64 picture the board shows for this text, as a 1-bit image. offset and size are what /calibrate saved."""
    import hud_text as hud
    im = Image.new("1", (W, H), 0)
    px = im.load()
    hud.set_area(*area(offset, size))
    placed = hud.layout(text)
    hud.set_area(*hud.DEFAULT_AREA)
    for pt, line, x, baseline in placed:
        x += offset[0]
        for ch in line:
            w, h, adv, xo, yo, rows = FONTS[pt]["glyphs"][ch]
            for r, bits in enumerate(rows):
                for c, bit in enumerate(bits):
                    X, Y = x + xo + c, baseline + offset[1] + yo + r
                    if bit == "1" and 0 <= X < W and 0 <= Y < H:
                        px[X, Y] = 1
            x += adv
    if box:
        dashed_area(im, offset, size)
    return im


def dashed_area(im, offset=(0, 0), size=None):
    """The content area's outline, dashed, the way /test draws it."""
    px = im.load()
    w, h = area(offset, size)
    l, t = (W - w) // 2 + offset[0], (H - h) // 2 + offset[1]
    for X in range(l, l + w):
        if (X // 2) % 2 == 0:
            px[X, t] = px[X, t + h - 1] = 1
    for Y in range(t, t + h):
        if (Y // 2) % 2 == 0:
            px[l, Y] = px[l + w - 1, Y] = 1


LIT, DIM = (170, 225, 255), (52, 74, 96)


def enlarge(im, k=6, under=None):
    """Each pixel as a dot on black with a faint grid, the way the panel looks up close. under: a second picture
    drawn dim behind the first, to compare where two things sit on the screen (the panel itself shows one at a time)."""
    out = Image.new("RGB", (im.width * k, im.height * k), (6, 6, 10))
    d = ImageDraw.Draw(out)
    for y in range(im.height):
        for x in range(im.width):
            if im.getpixel((x, y)):
                d.rectangle((x * k, y * k, x * k + k - 2, y * k + k - 2), fill=LIT)
            elif under is not None and under.getpixel((x, y)):
                d.rectangle((x * k, y * k, x * k + k - 2, y * k + k - 2), fill=DIM)
    return out


def classic():
    """The 5x7 font the display used until now (glcdfont.c), for an honest before and after."""
    src = (FONT_DIR.parent / "glcdfont.c").read_text()
    data = [int(b, 16) for b in re.findall(r"0x[0-9A-Fa-f]{2}", src.split("font[] PROGMEM = {")[1])]
    return [data[c * 5:c * 5 + 5] for c in range(256)]


def draw_old(text, size=2):
    """What the old firmware drew: the 5x7 font doubled, from the top left corner, ten characters to a line."""
    font, im = classic(), Image.new("1", (W, H), 0)
    px = im.load()
    per_line, lines, line = W // (6 * size), [], ""
    for word in text.split(" "):
        trial = f"{line} {word}" if line else word
        if len(trial) <= per_line:
            line = trial
        else:
            if line:
                lines.append(line)
            line = word[:per_line]
    lines.append(line)
    for row, line in enumerate(lines[:H // (8 * size)]):
        for col, ch in enumerate(line):
            for cx in range(5):
                bits = font[ord(ch) if ord(ch) < 256 else 63][cx]
                for cy in range(8):
                    if bits >> cy & 1:
                        for dx in range(size):
                            for dy in range(size):
                                X, Y = col * 6 * size + cx * size + dx, row * 8 * size + cy * size + dy
                                if X < W and Y < H:
                                    px[X, Y] = 1
    return im


def small(im, text, x, y):
    """A label in the 5x7 font at its own size, for the test pattern."""
    font, px = classic(), im.load()
    for col, ch in enumerate(text):
        for cx in range(5):
            for cy in range(8):
                X, Y = x + col * 6 + cx, y + cy
                if font[ord(ch)][cx] >> cy & 1 and 0 <= X < W and 0 <= Y < H:
                    px[X, Y] = 1


def test_pattern(offset=(0, 0), size=None):
    """What /test draws: the screen's edge, a crosshair at its middle and a label in each corner, which never move,
    and (dashed) the content area text and the eye are kept inside, moved by the saved offset."""
    im = Image.new("1", (W, H), 0)
    dashed_area(im, offset, size)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, W - 1, H - 1), outline=1)
    d.line((W // 2 - 6, H // 2, W // 2 + 6, H // 2), fill=1)
    d.line((W // 2, H // 2 - 6, W // 2, H // 2 + 6), fill=1)
    for label, x, y in (("TL", 3, 3), ("TR", W - 3 - 11, 3), ("BL", 3, H - 3 - 7), ("BR", W - 3 - 11, H - 3 - 7)):
        d.rectangle((x - 1, y - 1, x + 11, y + 7), fill=0)
        small(im, label, x, y)
    label = f"x{offset[0]:+d} y{offset[1]:+d}"
    small(im, label, (W - len(label) * 6) // 2 + offset[0], H // 2 + 10 + offset[1])
    return im


def eye_frame(name="open", last=True):
    """One frame of the eye from eye_frames.h, unpacked the way the firmware does it."""
    src = (HERE.parent / "eye_frames.h").read_text()
    body = lambda marker: src[src.index("{", src.index(marker)) + 1:].split("};")[0]  # noqa: E731
    data = [int(n, 0) for n in re.findall(r"0x[0-9A-Fa-f]+|\d+", body("EYE_DATA["))]
    starts = [int(n) for n in re.findall(r"\d+", body("EYE_FRAME_START["))]
    anims = re.findall(r'\{\s*"(\w+)",\s*(\d+),\s*(\d+)', body("EYE_ANIMS["))
    first, count = next((int(a), int(b)) for n, a, b in anims if n == name)
    index = first + count - 1 if last else first
    out, i = [], starts[index]
    while i < starts[index + 1] and len(out) < W * H // 8:
        b = data[i]
        i += 1
        if b:
            out.append(b)
        else:
            out.extend([0] * data[i])
            i += 1
    out = (out + [0] * (W * H // 8))[:W * H // 8]
    im = Image.new("1", (W, H), 0)
    px = im.load()
    for page in range(8):
        for x in range(W):
            for bit in range(8):
                if out[page * W + x] >> bit & 1:
                    px[x, page * 8 + bit] = 1
    return im


def shifted(im, offset):
    out = Image.new("1", (W, H), 0)
    out.paste(im, offset)
    return out


def labelled(tiles, cols, k=5, title_h=26):
    """A sheet of pictures, each enlarged with its caption above it."""
    from PIL import ImageFont
    try:
        font = ImageFont.truetype("Arial.ttf", 15)
    except OSError:
        font = ImageFont.load_default()
    cw, ch = W * k + 16, H * k + title_h + 14
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cw + 16, rows * ch + 16), (24, 24, 28))
    d = ImageDraw.Draw(sheet)
    for n, (caption, im, *under) in enumerate(tiles):
        x, y = 16 + (n % cols) * cw, 16 + (n // cols) * ch
        d.text((x, y), caption, font=font, fill=(255, 220, 120))
        sheet.paste(enlarge(im, k, *under), (x, y + title_h))
    return sheet


def now(what, text):
    import hud_text as hud
    pt, lines = hud.fit(text)
    return (f'{what}: "{text}"  {pt} pt, {len(lines)} line{"s" * (len(lines) > 1)}', draw(text))


if __name__ == "__main__":
    import hud_text as hud
    cmd = sys.argv[1:2]
    out = HERE / "preview"
    out.mkdir(exist_ok=True)
    if cmd == ["metrics"]:
        print(metrics())
    elif cmd == ["preview"]:
        for text in sys.argv[2:]:
            name = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:40]
            enlarge(draw(text)).save(out / f"text_{name}.png")
            print(text, "->", hud.fit(text), out / f"text_{name}.png")
    elif cmd == ["sheet"]:
        tiles = []
        for text in sys.argv[2:] or ["12g", "Stay in", "12g protein", "7x8 is 56", "Line 2: 7x8 is 56", "Phone's on table"]:
            tiles.append((f'before: "{text}"', draw_old(text)))
            tiles.append(now("now", text))
        labelled(tiles, 2).save(out / "text_sizes.png")
        print("wrote", out / "text_sizes.png")
    elif cmd == ["examples"]:
        # Before: the lines the models wrote when asked for "under 40 characters". Now: asked for at most 18.
        eye = eye_frame()
        tiles = [('snack answer, before: "12g protein per bar"', draw_old("12g protein per bar")), now("snack answer, now", "12g protein"),
                 ('whiteboard nudge, before: "Line 2: 7x8 is 56"', draw_old("Line 2: 7x8 is 56")), now("whiteboard nudge, now", "7x8 = 56"),
                 now("a longer nudge still fits", "Line 2: 7x8 is 56"), now("calories", "210 calories"),
                 ("the eye, which opens before the text and rests after it", eye),
                 ("the answer over the eye's outline (dim): same centre, same space", draw("12g protein"), eye),
                 ("the nudge over the eye's outline (dim)", draw("7x8 = 56"), eye),
                 ("the largest size over the eye's outline (dim)", draw("12g"), eye)]
        labelled(tiles, 2).save(out / "text_examples.png")
        print("wrote", out / "text_examples.png")
    elif cmd == ["test"]:
        tiles = [("/test with no offset", test_pattern()), ("/test after /calibrate?x=10&y=-6", test_pattern((10, -6))),
                 ("the eye, centred", eye_frame()), ("the eye after /calibrate?x=10&y=-6", shifted(eye_frame(), (10, -6))),
                 ('"12g protein", centred', draw("12g protein")), ('"12g protein" after /calibrate?x=10&y=-6', draw("12g protein", (10, -6)))]
        labelled(tiles, 2).save(out / "test_pattern.png")
        print("wrote", out / "test_pattern.png")
