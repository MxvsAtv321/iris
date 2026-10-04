"""The Iris eye for the glasses display: 128x64, one colour, each pixel on or off.

The display is seen through a half-mirror, so only lit pixels show and they float in
the air. The eye is therefore drawn in thin lines and never filled.

Every frame starts as vector shapes: two circular arcs for the lids, circles for the
iris and pupil, straight radial lines for the fibres. Each shape is then traced onto
the 128x64 grid one pixel wide, with the corner pixels of every stair-step removed, so
lines keep the same weight at every angle. art/preview/eye.svg is the same drawing as
a vector file.

  python make_eye.py            # previews: art/preview/<name>.gif (enlarged) and <name>.png (all frames)
  python make_eye.py header     # also writes ../eye_frames.h for the firmware
"""
import math
import sys
from pathlib import Path

from PIL import Image

W, H = 128, 64
FPS = 30

CX, CORNER_Y, HALF_W = 63.5, 35.0, 56.0      # the eye's corners sit on this line
UP_OPEN, LO_OPEN, SHUT = 24.0, 17.0, 5.0     # how far each lid bows when open; both lids share one curve when shut
IRIS = (63.5, 30.5)
IRIS_R, PUPIL_R = 20.5, 6.5
FIBRES = 30                                   # multiple of 3: the fibre pattern repeats every three
INSET = 2.0                                   # the iris stays this far inside the lids
GAP_HALF = math.radians(24)                   # half the width of the opening that orbits while thinking

HERE = Path(__file__).resolve().parent
OUT = HERE / "preview"


def lid_y(x, bow):
    """Height of a lid at x. The lid is a circular arc through both corners; bow > 0 rises, bow < 0 dips."""
    if abs(bow) < 0.05:
        return CORNER_Y
    r = (HALF_W ** 2 + bow ** 2) / (2 * abs(bow))
    d = math.sqrt(max(r * r - (x - CX) ** 2, 0.0)) - (r - abs(bow))
    return CORNER_Y - math.copysign(max(d, 0.0), bow)


def lids(openness):
    """-> (upper bow, lower bow). At 0 both lids lie on the same gentle downward curve."""
    return -SHUT + (UP_OPEN + SHUT) * openness, -SHUT - (LO_OPEN - SHUT) * openness


def trace(pts):
    """Pixels along a path, one pixel wide: sample densely, then drop the corner pixel of every stair-step."""
    px = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, int(4 * max(abs(x1 - x0), abs(y1 - y0))))
        for i in range(n + 1):
            p = (round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n))
            if not px or px[-1] != p:
                px.append(p)
    out = []
    for p in px:
        while len(out) >= 2 and max(abs(out[-2][0] - p[0]), abs(out[-2][1] - p[1])) <= 1:
            out.pop()
        out.append(p)
    return out


def circle(c, r, n=240):
    return [(c[0] + r * math.cos(2 * math.pi * i / n), c[1] + r * math.sin(2 * math.pi * i / n)) for i in range(n + 1)]


def shapes(openness=1.0, pupil=PUPIL_R, iris=IRIS_R, turn=0.0, ripple=0.0, phase=0.0, gap=None):
    """The drawing as vector paths: -> (lid paths, iris paths, upper bow, lower bow)."""
    up, lo = lids(openness)
    xs = [CX - HALF_W + i * (2 * HALF_W) / 160 for i in range(161)]
    lid_paths = [[(x, lid_y(x, up)) for x in xs]]
    iris_paths = []
    if openness > 0.04:
        lid_paths.append([(x, lid_y(x, lo)) for x in xs])
    if openness > 0.32:      # through a narrower slit the iris is only fragments
        # a second, shorter arc just above the upper lid gives it weight that tapers to the corners
        lash = [x for x in xs if abs(x - CX) < HALF_W * 0.55 * openness]
        if len(lash) > 2:
            lid_paths.append([(x, lid_y(x, up) - 1.0) for x in lash])
        def in_gap(a):       # gap: where an opening in the iris sits, in turns clockwise from the top
            return gap is not None and abs((a + math.pi / 2 - 2 * math.pi * gap + math.pi) % (2 * math.pi) - math.pi) < GAP_HALF
        rim = [q for q in range(241) if not in_gap(2 * math.pi * q / 240)]
        runs, run = [], []
        for q in rim:        # the iris ring, broken where the gap is
            if run and q != run[-1] + 1:
                runs.append(run)
                run = []
            run.append(q)
        runs.append(run)
        for run in runs:
            iris_paths.append([(IRIS[0] + iris * math.cos(2 * math.pi * q / 240), IRIS[1] + iris * math.sin(2 * math.pi * q / 240)) for q in run])
        iris_paths.append(circle(IRIS, pupil))
        for i in range(FIBRES):
            a = 2 * math.pi * (i + turn) / FIBRES - math.pi / 2
            if in_gap(a):
                continue
            wave = math.sin(2 * math.pi * (3 * i / FIBRES - phase))
            kind = i % 3
            inner = pupil + (2.2, 5.5, 2.2)[kind] + ripple * 0.4 * wave
            outer = iris - (2.4, 2.4, 8.0)[kind] + ripple * wave
            if outer - inner < 1.5:
                continue
            iris_paths.append([(IRIS[0] + r * math.cos(a), IRIS[1] + r * math.sin(a)) for r in (inner, outer)])
    return lid_paths, iris_paths, up, lo


def frame(**kw):
    """One 128x64 on/off image.

    openness  0 shut .. 1 open          pupil, iris  radii in pixels
    turn      rotation of the fibres, in fibre spacings
    gap       where an opening in the ring and fibres sits, in turns from the top; None for a whole iris
    ripple    how far the fibre ends travel in and out (pixels), phase where the wave is (turns)
    """
    lid_paths, iris_paths, up, lo = shapes(**kw)
    im = Image.new("1", (W, H), 0)
    put = im.putpixel
    for path in iris_paths:      # the iris only shows through the opening between the lids
        for x, y in trace(path):
            if 0 <= x < W and 0 <= y < H and abs(x - CX) < HALF_W and lid_y(x, up) + INSET <= y <= lid_y(x, lo) - INSET:
                put((x, y), 1)
    for path in lid_paths:
        for x, y in trace(path):
            if 0 <= x < W and 0 <= y < H:
                put((x, y), 1)
    return im


def svg(path, **kw):
    lid_paths, iris_paths, up, lo = shapes(**kw)
    def d(p): return "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in p)
    xs = [CX - HALF_W + i * (2 * HALF_W) / 80 for i in range(81)]
    hole = [(x, lid_y(x, up) + INSET) for x in xs] + [(x, lid_y(x, lo) - INSET) for x in reversed(xs)]
    body = "".join(f'<path d="{d(p)}"/>' for p in lid_paths)
    inner = "".join(f'<path d="{d(p)}"/>' for p in iris_paths)
    path.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W * 8}" height="{H * 8}">'
                    f'<rect width="{W}" height="{H}" fill="#05060a"/><clipPath id="gap"><path d="{d(hole)}Z"/></clipPath>'
                    f'<g fill="none" stroke="#e8f2ff" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">'
                    f'{body}<g clip-path="url(#gap)">{inner}</g></g></svg>')


def ease(t):
    return t * t * (3 - 2 * t)


def ease_out(t):
    return 1 - (1 - t) ** 3


def animations():
    two_pi = 2 * math.pi
    a = {}
    n = 12   # open: the lid parts, and the pupil settles from wide to resting
    a["open"] = [frame(openness=ease_out((i + 1) / n), pupil=PUPIL_R + 3.0 * (1 - ease((i + 1) / n))) for i in range(n)]
    shut, hold, back = 3, 1, 5
    a["blink"] = ([frame(openness=1 - ease((i + 1) / shut)) for i in range(shut)] + [frame(openness=0)] * hold
                  + [frame(openness=ease_out((i + 1) / back)) for i in range(back)])
    n = 30   # listening: the pupil is wider and breathes; a ripple runs round the fibres
    a["listening"] = [frame(pupil=PUPIL_R + 2.0 + 0.6 * math.sin(two_pi * i / n), ripple=1.6, phase=i / n) for i in range(n)]
    n = 60   # thinking: an opening orbits the iris once per loop while the fibres turn three spacings, so the loop closes exactly
    a["thinking"] = [frame(turn=3 * i / n, gap=i / n) for i in range(n)]
    n = 20   # speaking: iris and pupil swell together, gently
    a["speaking"] = [frame(iris=IRIS_R + 1.2 * math.sin(math.pi * i / n) ** 2, pupil=PUPIL_R + 1.0 * math.sin(math.pi * i / n) ** 2) for i in range(n)]
    n = 7
    a["close"] = [frame(openness=1 - ease((i + 1) / n)) for i in range(n)]
    return a


def enlarge(im, k=6):
    """Lit pixels as soft white on black, the way the display looks."""
    big = im.convert("L").resize((W * k, H * k), Image.NEAREST)
    out = Image.new("RGB", big.size, (5, 6, 10))
    out.paste((232, 242, 255), mask=big)
    return out


def sheet(frames, k=3, cols=6):
    rows = math.ceil(len(frames) / cols)
    out = Image.new("RGB", (cols * (W * k + 6) + 6, rows * (H * k + 6) + 6), (40, 40, 48))
    for i, f in enumerate(frames):
        out.paste(enlarge(f, k), (6 + (i % cols) * (W * k + 6), 6 + (i // cols) * (H * k + 6)))
    return out


def gif(frames, path, repeat=1, hold=0):
    seq = [enlarge(f) for f in frames] * repeat
    durations = [round(1000 / FPS)] * len(seq)
    if hold:
        durations[-1] = hold
    seq[0].save(path, save_all=True, append_images=seq[1:], duration=durations, loop=0, disposal=2)


def pages(im):
    """The frame in the display's own byte order: 8 rows per byte, lowest bit on top, 128 bytes per band of 8 rows."""
    px = im.load()
    return bytes(sum(1 << b for b in range(8) if px[x, band * 8 + b]) for band in range(H // 8) for x in range(W))


def squeeze(data):
    """Most bytes are zero. A zero is stored as 0 followed by how many zeros there are (1 to 255)."""
    out, i = bytearray(), 0
    while i < len(data):
        if data[i]:
            out.append(data[i])
            i += 1
        else:
            n = 1
            while i + n < len(data) and data[i + n] == 0 and n < 255:
                n += 1
            out += bytes((0, n))
            i += n
    return bytes(out)


LOOPS = ("listening", "thinking", "speaking")


def header(a, path):
    blob, starts, table = bytearray(), [], []
    for name, frames in a.items():
        table.append((name, len(starts), len(frames), name in LOOPS))
        for f in frames:
            starts.append(len(blob))
            blob += squeeze(pages(f))
    starts.append(len(blob))
    lines = ["// Generated by art/make_eye.py. Do not edit by hand: change the script and run `python make_eye.py header`.",
             "// Each frame is the display buffer (1024 bytes) with runs of zeros stored as 0, count.",
             "#pragma once", "#include <Arduino.h>", "",
             "struct EyeAnim { const char *name; uint16_t first; uint16_t count; bool loops; };", "",
             f"const uint8_t EYE_ANIM_COUNT = {len(table)};",
             "const EyeAnim EYE_ANIMS[EYE_ANIM_COUNT] = {"]
    lines += [f'  {{"{n}", {first}, {count}, {"true" if loops else "false"}}},' for n, first, count, loops in table]
    lines += ["};", "", f"const uint16_t EYE_FRAME_COUNT = {len(starts) - 1};",
              "const uint32_t EYE_FRAME_START[EYE_FRAME_COUNT + 1] PROGMEM = {"]
    lines += ["  " + ", ".join(str(v) for v in starts[i:i + 12]) + "," for i in range(0, len(starts), 12)]
    lines += ["};", "", f"const uint8_t EYE_DATA[{len(blob)}] PROGMEM = {{"]
    lines += ["  " + ",".join(str(v) for v in blob[i:i + 32]) + "," for i in range(0, len(blob), 32)]
    lines += ["};", ""]
    path.write_text("\n".join(lines))
    print(f"wrote {path.name}: {len(starts) - 1} frames, {len(blob)} bytes ({len(blob) / (len(starts) - 1):.0f} per frame; unpacked they are 1024)")


def main():
    OUT.mkdir(exist_ok=True)
    a = animations()
    for name, frames in a.items():
        loops = name in ("listening", "thinking", "speaking")
        gif(frames, OUT / f"{name}.gif", repeat=3 if loops else 1, hold=0 if loops else 900)
        sheet(frames).save(OUT / f"{name}.png")
        lit = sum(f.convert("L").histogram()[255] for f in frames) / len(frames)
        print(f"{name:10} {len(frames):3} frames  {len(frames) / FPS:.2f} s  about {lit / (W * H) * 100:.1f}% of pixels lit")
    # idle is not a set of frames: the firmware holds the open eye and plays blink every 3 to 5 s at random
    rest = a["blink"][-1]
    idle = [rest] * 100 + a["blink"] + [rest] * 140 + a["blink"] + [rest] * 112 + a["blink"] + [rest] * 30
    gif(idle, OUT / "idle.gif")
    story = (a["open"] + a["listening"] * 2 + a["thinking"] * 2 + a["blink"] + a["speaking"] * 3
             + [rest] * 95 + a["blink"] + [rest] * 40 + a["close"] + [Image.new("1", (W, H), 0)] * 8)
    gif(story, OUT / "all_in_order.gif")
    enlarge(frame(), 8).save(OUT / "eye_open.png")
    svg(OUT / "eye.svg")
    if sys.argv[1:2] == ["header"]:
        header(a, HERE.parent / "eye_frames.h")


if __name__ == "__main__":
    main()
