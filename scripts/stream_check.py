"""
Watches the brain's live video the way a dashboard does and reports the frame rate it actually gets.

    brain/.venv/bin/python scripts/stream_check.py --brain http://127.0.0.1:8000 --seconds 20

It reads /api/stream, counts the frames and how many of them differ from the one before, and prints
what the brain itself reports (stream or single frames, its own frame rate, drops and reconnects).
Point --brain at the web app's address or the tunnel's to measure through them instead.
"""
import argparse
import hashlib
import json
import sys
import time

import httpx

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent / "brain"))


def split(buf):
    """Complete JPEGs at the front of an MJPEG buffer (the same rule as brain/camera.py)."""
    import re
    frames = []
    while True:
        m = re.search(rb"Content-Length:\s*(\d+)", buf, re.I)
        if not m:
            break
        start = buf.find(b"\r\n\r\n", m.end())
        if start < 0 or len(buf) < start + 4 + int(m.group(1)):
            break
        frames.append(buf[start + 4:start + 4 + int(m.group(1))])
        buf = buf[start + 4 + int(m.group(1)):]
    return frames, buf


def watch(brain, seconds):
    t0 = time.monotonic()
    times, sizes, last, changed, buf, first = [], [], None, 0, b"", None
    with httpx.stream("GET", brain + "/api/stream", timeout=httpx.Timeout(10, connect=5)) as r:
        if r.status_code != 200:
            return {"error": f"HTTP {r.status_code}"}
        for chunk in r.iter_bytes():
            buf += chunk
            found, buf = split(buf)
            for jpeg in found:
                now = time.monotonic() - t0
                first = now if first is None else first
                digest = hashlib.md5(jpeg).digest()
                changed += digest != last
                last = digest
                times.append(now)
                sizes.append(len(jpeg))
            if time.monotonic() - t0 >= seconds:
                break
    span = (times[-1] - times[0]) if len(times) > 1 else 0
    gaps = sorted(b - a for a, b in zip(times, times[1:]))
    return {
        "frames": len(times), "different_frames": changed, "seconds": round(time.monotonic() - t0, 1),
        "fps": round((len(times) - 1) / span, 1) if span else 0.0,
        "first_frame_ms": round(first * 1000) if first is not None else None,
        "longest_gap_ms": round(gaps[-1] * 1000) if gaps else None,
        "frame_kb": round(sorted(sizes)[len(sizes) // 2] / 1000, 1) if sizes else None,
        "kb_per_s": round(sum(sizes) / 1000 / span) if span else None,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain", default="http://127.0.0.1:8000")
    ap.add_argument("--seconds", type=float, default=20)
    args = ap.parse_args()
    brain = args.brain.rstrip("/")
    result = watch(brain, args.seconds)
    try:
        m = httpx.get(brain + "/api/trace", timeout=5).json().get("metrics", {})
        result["brain_says"] = {k: m.get(k) for k in ("camera_source", "camera_fps")}
    except Exception as e:  # noqa: BLE001
        result["brain_says"] = f"{type(e).__name__}"
    print(json.dumps(result, indent=1))
