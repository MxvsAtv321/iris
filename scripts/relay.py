"""
Camera relay for testing memory before the brain is wired in.

Grabs a frame from the glasses every couple of seconds and saves it through
the memory API. Must run on a machine joined to ShriHotspot, because the
camera's address isn't reachable from anywhere else. Once the brain calls
memory.ingest itself, this script isn't needed.

    python scripts/relay.py --session demo-darren

Needs MEMORY_URL and INGEST_TOKEN.
"""

import argparse
import os
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from brain.memory import MemoryClient  # noqa: E402

# CAMERA_URL in the team .env is the camera's base address. Use the IP, not
# glasses-cam.local, which adds about five seconds per request on a Mac.
CAMERA_URL = os.environ.get("CAMERA_URL", "http://172.20.10.4").rstrip("/")
CAPTURE_URL = f"{CAMERA_URL}/capture"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--interval", type=float, default=2.0)
    args = ap.parse_args()

    memory = MemoryClient()
    camera = httpx.Client()
    print(f"[relay] {CAPTURE_URL} -> {memory.base}  session={args.session}")

    while True:
        started = time.monotonic()
        try:
            frame = camera.get(CAPTURE_URL, timeout=3)
            frame.raise_for_status()
            result = memory.ingest(args.session, frame.content, captured_at=time.time())
            if result and result["saved"]:
                print(f"[saved] #{result['id']} {result['ms']}ms {result['description'][:60]}")
            elif result:
                print(f"[skip] {result['ms']}ms same scene")
        except httpx.HTTPError as e:
            print(f"[camera] {e}")
        time.sleep(max(0.0, args.interval - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
