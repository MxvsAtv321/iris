"""The glasses camera as the brain sees it: one live MJPEG stream, turned upright.

The camera board serves single frames at /capture (port 80) and a multipart MJPEG stream at
:81/stream. The brain is the stream's only client. It keeps the newest frame in memory for the
watch loop, questions and memory, and re-serves the frames to the dashboard as live video, so the
camera never has more than one viewer. If the stream stops, the brain reconnects by itself, and
until it is back a frame is fetched from /capture whenever one is needed, as before the stream.

  CAMERA_ROTATE=0|90|180|270   turn every frame this many degrees clockwise before anything uses it
  CAMERA_STREAM=0              never use the stream: /capture only
  CAMERA_STREAM_URL=...        where the stream is (default: the camera's address, port 81, /stream)

Run `python camera.py` for the self-check (no network).
"""
import asyncio
import io
import logging
import os
import re
import time
from collections import deque
from urllib.parse import urlsplit

from PIL import Image

log = logging.getLogger("iris.camera")
CAMERA = (os.getenv("CAMERA_URL") or "http://172.20.10.4").rstrip("/")
_host = urlsplit(CAMERA)
STREAM_URL = os.getenv("CAMERA_STREAM_URL") or f"{_host.scheme}://{_host.hostname}:81/stream"
STREAM_ON = (os.getenv("CAMERA_STREAM") or "1") != "0"
FRESH_S = 1.0            # a stream frame older than this means the stream has stalled: ask /capture instead
QUIET_S = 4.0            # no bytes from the stream for this long: drop the connection and reconnect
MAX_BUFFER = 4_000_000   # a stream that never completes a frame is not a stream
try:
    ROTATE = int(os.getenv("CAMERA_ROTATE") or 0)
except ValueError:
    ROTATE = -1
if ROTATE not in (0, 90, 180, 270):
    log.warning("CAMERA_ROTATE must be 0, 90, 180 or 270; frames are left as they are")
    ROTATE = 0
TURN = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}   # PIL turns anticlockwise

LENGTH = re.compile(rb"Content-Length:\s*(\d+)", re.I)
SOI, EOI = b"\xff\xd8", b"\xff\xd9"

frame = {"jpeg": b"", "ts": 0.0, "seq": 0}     # the newest frame from anywhere, upright
state = {"connected": False, "connects": 0, "drops": 0, "frames": 0, "last_error": ""}
arrivals = deque(maxlen=120)                   # when each stream frame arrived, for the frame rate
news = None                                    # asyncio.Condition, made on first use inside the running loop


def upright(jpeg, degrees=None):
    """The frame turned `degrees` clockwise (default CAMERA_ROTATE). A frame that can't be read is returned as it is."""
    degrees = ROTATE if degrees is None else degrees
    if not degrees:
        return jpeg
    try:
        out = io.BytesIO()
        Image.open(io.BytesIO(jpeg)).transpose(TURN[degrees]).save(out, "JPEG", quality=85)
        return out.getvalue()
    except Exception:  # noqa: BLE001 - a sideways frame is better than none
        return jpeg


def split(buf):
    """Complete JPEG frames at the front of an MJPEG buffer. -> (frames, what is left).
    The camera labels each part with its Content-Length; without one, the JPEG's own start and end marks are used."""
    frames = []
    while True:
        m = LENGTH.search(buf)
        if m:
            start = buf.find(b"\r\n\r\n", m.end())
            if start < 0:
                break
            start, size = start + 4, int(m.group(1))
            if len(buf) < start + size:
                break
            frames.append(buf[start:start + size])
            buf = buf[start + size:]
            continue
        i = buf.find(SOI)
        j = buf.find(EOI, i + 2) if i >= 0 else -1
        if j < 0:
            break
        frames.append(buf[i:j + 2])
        buf = buf[j + 2:]
    return frames, buf


def condition():
    global news
    if news is None:
        news = asyncio.Condition()
    return news


async def publish(jpeg, from_stream=False):
    """A new frame from the stream or from /capture: turn it upright, keep it, and wake whoever is waiting for one."""
    if ROTATE:
        jpeg = await asyncio.to_thread(upright, jpeg)
    frame.update(jpeg=jpeg, ts=time.time(), seq=frame["seq"] + 1)
    if from_stream:
        state["frames"] += 1
        arrivals.append(time.monotonic())
    async with condition():
        condition().notify_all()
    return jpeg


def live():
    """True while the stream is delivering: the newest frame came from it and is under a second old."""
    return STREAM_ON and state["connected"] and time.time() - frame["ts"] < FRESH_S


def fps(window=3.0):
    now = time.monotonic()
    recent = [t for t in arrivals if now - t <= window]
    return round(len(recent) / window, 1) if state["connected"] else 0.0


async def read_stream(http):
    """Follow the camera's stream for as long as the brain runs. Never raises: a stream that fails or goes quiet
    is dropped and tried again, quickly at first and then every few seconds."""
    wait = 0.5
    while STREAM_ON:
        try:
            async with http.stream("GET", STREAM_URL, timeout=_timeout()) as r:
                if r.status_code != 200:
                    raise RuntimeError(f"HTTP {r.status_code}")
                state.update(connected=True, connects=state["connects"] + 1, last_error="")
                log.info("camera stream connected (%s)", STREAM_URL)
                buf, wait = b"", 0.5
                async for chunk in r.aiter_bytes():
                    buf += chunk
                    found, buf = split(buf)
                    if found:
                        await publish(found[-1], from_stream=True)    # only the newest matters
                        state["frames"] += len(found) - 1
                    if len(buf) > MAX_BUFFER:
                        raise RuntimeError("no complete frame in the stream")
            raise RuntimeError("the camera closed the stream")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            if state["connected"]:
                state["drops"] += 1
            state.update(connected=False, last_error=f"{type(e).__name__}: {e}"[:120])
            log.warning("camera stream: %s; /capture until it is back (retry in %.1fs)", state["last_error"], wait)
            await asyncio.sleep(wait)
            wait = min(wait * 2, 10.0)


def _timeout():
    import httpx
    return httpx.Timeout(QUIET_S, connect=3.0)


async def frames_for_a_viewer(max_fps=20.0, heartbeat_s=5.0):
    """The newest frame each time there is one, for one dashboard. A slow viewer skips frames, it never queues them.
    When nothing new arrives for a while the last frame is sent again, so the picture and the connection stay up."""
    sent, gap = -1, 1.0 / max_fps
    while True:
        try:
            async with condition():
                await asyncio.wait_for(condition().wait_for(lambda: frame["seq"] != sent), heartbeat_s)
        except asyncio.TimeoutError:
            pass
        if frame["jpeg"]:
            sent = frame["seq"]
            yield frame["jpeg"]
        await asyncio.sleep(gap)


def multipart(jpeg):
    return b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n"


if __name__ == "__main__":
    def jpeg_of(size, colour):
        out = io.BytesIO()
        Image.new("RGB", size, colour).save(out, "JPEG")
        return out.getvalue()

    a, b = jpeg_of((80, 60), (200, 30, 30)), jpeg_of((80, 60), (30, 30, 200))
    part = lambda j: b"\r\n--123456789000000000000987654321\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\nX-Timestamp: 1.000001\r\n\r\n" % len(j) + j  # noqa: E731
    whole = part(a) + part(b)
    assert split(whole) == ([a, b], b"")
    for cut in (10, 60, len(part(a)) - 1, len(part(a)) + 40):          # a frame split across network chunks waits for the rest
        got, rest = split(whole[:cut])
        more, rest = split(rest + whole[cut:])
        assert got + more == [a, b] and rest == b"", cut
    assert split(b"junk" + a + b"more" + b[:20]) == ([a], b"more" + b[:20])   # no part headers: the JPEG's own marks
    assert split(b"") == ([], b"")

    wide = jpeg_of((80, 60), (10, 200, 10))
    assert Image.open(io.BytesIO(upright(wide, 90))).size == (60, 80) and Image.open(io.BytesIO(upright(wide, 180))).size == (80, 60)
    assert upright(wide, 0) is wide and upright(b"not a picture", 90) == b"not a picture"
    marked = Image.new("RGB", (80, 60), (0, 0, 0))
    marked.paste((255, 255, 255), (0, 0, 20, 20))                        # a white square in the top left corner...
    out = io.BytesIO()
    marked.save(out, "JPEG", quality=95)
    turned = Image.open(io.BytesIO(upright(out.getvalue(), 90))).convert("L")
    assert turned.getpixel((50, 10)) > 200 and turned.getpixel((10, 10)) < 60      # ...is in the top right after a quarter turn clockwise

    class Stream:
        """Stands in for the camera: sends some frames, then fails or goes quiet the way a real one does."""
        def __init__(self, script):
            self.script, self.opened = list(script), 0

        def stream(self, method, url, timeout=None):
            self.opened += 1
            return Reply(self.script.pop(0) if self.script else ("hang",))

    class Reply:
        def __init__(self, plan):
            self.plan, self.status_code = plan, 500 if plan[0] == "refuse" else 200

        async def __aenter__(self):
            if self.plan[0] == "down":
                raise ConnectionError("camera unreachable")
            return self

        async def __aexit__(self, *a):
            return False

        async def aiter_bytes(self):
            if self.plan[0] == "frames":
                for j in self.plan[1]:
                    data = part(j)
                    yield data[:37]                                       # in two pieces, as a network delivers it
                    yield data[37:]
                    await asyncio.sleep(0.01)
            if self.plan[0] == "hang":
                await asyncio.sleep(3600)

    async def check():
        cam = Stream([("down",), ("refuse",), ("frames", [a, b, a]), ("frames", [b])])
        task = asyncio.create_task(read_stream(cam))
        seen = []

        async def viewer():
            async for j in frames_for_a_viewer(max_fps=200, heartbeat_s=0.2):
                seen.append(j)

        watching = asyncio.create_task(viewer())
        for _ in range(400):
            await asyncio.sleep(0.01)
            if state["frames"] >= 4 and state["drops"] >= 1 and cam.opened >= 5:
                break
        # unreachable, then refused, then three frames and the stream ends, it reconnects for one more frame and the
        # stream ends again, and the third connection stays open without sending anything
        assert state["frames"] == 4 and state["connects"] == 3 and state["drops"] == 2 and cam.opened == 5, (state, cam.opened)
        assert frame["jpeg"] == b and frame["seq"] == 4 and seen and seen[-1] == b and a in seen
        assert live()                                                     # the last frame is fresh and the stream is connected
        frame["ts"] -= 2
        assert not live()                                                 # stalled: /capture takes over
        await publish(a)                                                  # ...and a /capture frame reaches the viewer too
        await asyncio.sleep(0.05)
        assert seen[-1] == a and state["frames"] == 4
        task.cancel()
        watching.cancel()
        assert multipart(a).startswith(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(a)) and multipart(a).endswith(a + b"\r\n")

    asyncio.run(check())
    print("camera ok")
