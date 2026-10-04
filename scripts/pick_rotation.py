"""
Shows one camera frame at each of the four rotations, so you can pick CAMERA_ROTATE.

    brain/.venv/bin/python scripts/pick_rotation.py            # makes the sheet and opens it
    brain/.venv/bin/python scripts/pick_rotation.py --set 90   # writes CAMERA_ROTATE=90 to .env

Point the camera at something with an obvious top first: a face, a doorway, a line of text. The frame
comes straight from the camera (/capture), before the brain turns it, so the sheet shows what each
setting would do. After --set, restart the brain: scripts/run_demo.sh restart-brain
"""
import argparse
import io
import os
import re
import subprocess
import sys
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
TURN = {0: None, 90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}


def camera_url():
    for line in (ROOT / ".env").read_text().splitlines() if (ROOT / ".env").exists() else []:
        if line.startswith("CAMERA_URL="):
            return line.split("=", 1)[1].split(" #")[0].strip().strip('"') or "http://172.20.10.4"
    return os.getenv("CAMERA_URL") or "http://172.20.10.4"


def set_env(value):
    env = ROOT / ".env"
    lines = env.read_text().splitlines()
    kept = [l for l in lines if not re.match(r"CAMERA_ROTATE\s*=", l)]
    env.write_text("\n".join(kept + [f"CAMERA_ROTATE={value}"]) + "\n")
    print(f"CAMERA_ROTATE={value} written to .env. Restart the brain: scripts/run_demo.sh restart-brain")


def sheet(jpeg, out):
    raw = Image.open(io.BytesIO(jpeg)).convert("RGB")
    try:
        font = ImageFont.truetype("Arial Bold.ttf", 44)
    except OSError:
        font = ImageFont.load_default()
    page = Image.new("RGB", (1360, 1520), (24, 24, 28))
    for i, (degrees, turn) in enumerate(TURN.items()):
        im = raw.transpose(turn) if turn else raw.copy()
        im.thumbnail((640, 640))
        x, y = (i % 2) * 680, (i // 2) * 760
        page.paste(im, (x + (680 - im.width) // 2, y + 90 + (640 - im.height) // 2))
        ImageDraw.Draw(page).text((x + 24, y + 20), f"CAMERA_ROTATE={degrees}", font=font, fill=(255, 220, 120))
    out.parent.mkdir(parents=True, exist_ok=True)
    page.save(out)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", type=int, choices=[0, 90, 180, 270], help="write this rotation to .env instead of making a sheet")
    ap.add_argument("--out", default="~/Documents/iris-references/rotate/pick-a-rotation.png")
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()
    if args.set is not None:
        set_env(args.set)
        sys.exit()
    r = httpx.get(camera_url() + "/capture", timeout=4)
    r.raise_for_status()
    path = sheet(r.content, Path(args.out).expanduser())
    print("wrote", path)
    if not args.no_open and sys.platform == "darwin":
        subprocess.run(["open", str(path)], check=False)
