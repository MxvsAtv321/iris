"""
A stand-in for the glasses, for working on the brain away from the hotspot.

It answers the camera and display calls in docs/contracts.md with the timings measured on the
real boards: a capture takes about 0.17 s and one at a time, a display call about 0.05 s.

    brain/.venv/bin/python scripts/fake_glasses.py --port 8041 [--image photo.jpg]

Then run the brain with CAMERA_URL=http://127.0.0.1:8041 HUD_URL=http://127.0.0.1:8041
CAMERA_STREAM_URL=http://127.0.0.1:8041/stream (the stream is on the same port here; /stall?s=8 pauses it).
Without --image it serves a drawn product card, so questions have something to read.
"""
import argparse
import asyncio
import io
import time

import uvicorn
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from PIL import Image, ImageDraw, ImageFont

CAPTURE_S, DISPLAY_S, STREAM_FPS = 0.17, 0.05, 12.0
app = FastAPI()
camera = asyncio.Lock()          # the ESP32 serves one request at a time
state = {"jpeg": b"", "shown": "", "eye": "closed", "frames": 0, "settings": {"framesize": 11, "vflip": 0, "hmirror": 1}}


def card():
    """An 800x600 photo-like card with a nutrition label the models can read."""
    img = Image.new("RGB", (800, 600), (212, 204, 190))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((90, 110, 710, 490), 28, fill=(60, 42, 30))
    try:
        big, small = ImageFont.truetype("Arial Bold.ttf", 46), ImageFont.truetype("Arial.ttf", 34)
    except OSError:
        big = small = ImageFont.load_default()
    d.text((130, 150), "ALMOND PROTEIN BAR", font=big, fill=(245, 236, 220))
    for i, line in enumerate(("Dark chocolate, sea salt", "Per bar (52 g): 12 g protein", "210 kcal, 4 g sugar", "Vegan. Contains almonds.")):
        d.text((130, 250 + i * 52, ), line, font=small, fill=(245, 236, 220))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


@app.get("/capture")
async def capture():
    async with camera:
        await asyncio.sleep(CAPTURE_S)
        state["frames"] += 1
        return Response(state["jpeg"], media_type="image/jpeg")


def numbered(n):
    """The frame with a moving bar on it, so every stream frame is different and a viewer can count them."""
    img = Image.open(io.BytesIO(state["jpeg"])).convert("RGB")
    d = ImageDraw.Draw(img)
    x = (n * 16) % img.width
    d.rectangle((x, img.height - 14, x + 40, img.height), fill=(255, 220, 120))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return buf.getvalue()


@app.get("/stream")
async def stream(fps: float = STREAM_FPS):
    """The MJPEG stream the real board serves on port 81, with the same part headers. /stall pauses it."""
    async def parts():
        n = 0
        while True:
            if time.time() < state.get("stalled_until", 0):
                await asyncio.sleep(0.1)
                continue
            n += 1
            state["frames"] += 1
            jpeg = numbered(n)
            yield (b"\r\n--123456789000000000000987654321\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n"
                   b"X-Timestamp: %d.000000\r\n\r\n" % (len(jpeg), int(time.time()))) + jpeg
            await asyncio.sleep(1 / fps)
    return StreamingResponse(parts(), media_type="multipart/x-mixed-replace;boundary=123456789000000000000987654321")


@app.get("/stall")
async def stall(s: float = 8.0):
    """Make the stream go quiet for a while, the way a real one does when the WiFi drops."""
    state["stalled_until"] = time.time() + s
    return PlainTextResponse("ok")


@app.get("/control")
async def control(var: str, val: int):
    state["settings"][var] = val
    return PlainTextResponse("ok")


@app.get("/show")
async def show(text: str = "", eye: str = "", hold: int = 0):
    await asyncio.sleep(DISPLAY_S)
    state.update(shown=text, shown_at=time.time())
    return PlainTextResponse("ok")


@app.get("/eye")
async def eye(anim: str = ""):
    await asyncio.sleep(DISPLAY_S)
    state["eye"] = anim
    return PlainTextResponse("ok")


@app.get("/clear")
async def clear():
    state.update(shown="", eye="closed")
    return PlainTextResponse("ok")


@app.get("/status")
async def status():
    return {**state["settings"], "state": state["eye"], "shown": state["shown"], "frames": state["frames"], "fake": True}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8041)
    ap.add_argument("--image", help="a JPEG to serve as every frame")
    args = ap.parse_args()
    state["jpeg"] = open(args.image, "rb").read() if args.image else card()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
