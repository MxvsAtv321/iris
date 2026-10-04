"""The glasses camera as the brain sees it: every frame turned upright.

The camera board is mounted on its side on the glasses, so its picture comes out sideways.
CAMERA_ROTATE says how far to turn each frame, and the brain does it once, as the frame arrives,
before the watch loop, questions, memory or the dashboard see it.

  CAMERA_ROTATE=0|90|180|270   degrees clockwise. scripts/pick_rotation.py shows a frame at each.

Run `python camera.py` for the self-check (no network).
"""
import io
import logging
import os

from PIL import Image

log = logging.getLogger("iris.camera")
try:
    ROTATE = int(os.getenv("CAMERA_ROTATE") or 0)
except ValueError:
    ROTATE = -1
if ROTATE not in (0, 90, 180, 270):
    log.warning("CAMERA_ROTATE must be 0, 90, 180 or 270; frames are left as they are")
    ROTATE = 0
TURN = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}   # PIL turns anticlockwise


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


if __name__ == "__main__":
    def jpeg_of(img):
        out = io.BytesIO()
        img.save(out, "JPEG", quality=95)
        return out.getvalue()

    wide = jpeg_of(Image.new("RGB", (80, 60), (10, 200, 10)))
    assert Image.open(io.BytesIO(upright(wide, 90))).size == (60, 80) and Image.open(io.BytesIO(upright(wide, 270))).size == (60, 80)
    assert Image.open(io.BytesIO(upright(wide, 180))).size == (80, 60)
    assert upright(wide, 0) is wide and upright(b"not a picture", 90) == b"not a picture"
    marked = Image.new("RGB", (80, 60), (0, 0, 0))
    marked.paste((255, 255, 255), (0, 0, 20, 20))                        # a white square in the top left corner...
    turned = Image.open(io.BytesIO(upright(jpeg_of(marked), 90))).convert("L")
    assert turned.getpixel((50, 10)) > 200 and turned.getpixel((10, 10)) < 60      # ...is top right after a quarter turn clockwise
    turned = Image.open(io.BytesIO(upright(jpeg_of(marked), 270))).convert("L")
    assert turned.getpixel((10, 70)) > 200 and turned.getpixel((10, 10)) < 60      # ...and bottom left after three
    print("camera ok")
