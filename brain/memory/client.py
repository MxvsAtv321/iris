"""
Client for the Iris memory API on Neon.

The brain uses two calls, and neither ever raises, so memory can't break the
brain. A failed or slow call logs a warning and returns an empty result.

    from memory import MemoryClient
    memory = MemoryClient()

    # after describing a frame
    memory.ingest(session_id, jpeg_bytes, description)

    # inside the ask endpoint, when the question is about finding something
    result = memory.search(session_id, "where did I leave my phone?")
    if result["moment"]:
        ...  # result["moment"]["captured_at"], ["description"], ["image_url"]

AsyncMemoryClient has the same methods for async code (FastAPI). Fire ingest
as a background task so saving a memory never adds latency to the gate.

    asyncio.create_task(memory.ingest(session_id, jpeg, description))

If MEMORY_URL isn't set, the client logs one warning and switches itself off.
Every call then returns an empty result, so the brain runs fine without memory.

Env vars
    MEMORY_URL     the memory function's invocation URL, origin only
    INGEST_TOKEN   shared secret for ingest, never sent to the browser
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import httpx

log = logging.getLogger("iris.memory")

# Short on purpose. A memory call should fail fast rather than stall the brain.
# The function keeps its own model calls inside these budgets.
INGEST_TIMEOUT_S = 8.0
SEARCH_TIMEOUT_S = 4.0
LIST_TIMEOUT_S = 8.0


def empty_search(target: str | None = None, error: str | None = None) -> dict[str, Any]:
    """What search returns when memory is off or a call failed. Same shape as a real result."""
    return {"search_id": None, "target": target or "", "moment": None, "top": [], "ms": 0, "error": error}


def _resolve_base(base_url: str | None) -> str | None:
    url = base_url or os.environ.get("MEMORY_URL")
    if not url:
        log.warning("MEMORY_URL isn't set, so memory is off. Ingest and search will return empty results.")
        return None
    return url.rstrip("/") + "/api/memory"


def _iso(captured_at: Any) -> str | None:
    """Accepts a datetime, a Unix timestamp, or an ISO string. Naive datetimes are treated as UTC."""
    if captured_at is None:
        return None
    if isinstance(captured_at, (int, float)):
        return datetime.fromtimestamp(captured_at, tz=timezone.utc).isoformat()
    if isinstance(captured_at, datetime):
        if captured_at.tzinfo is None:
            captured_at = captured_at.replace(tzinfo=timezone.utc)
        return captured_at.isoformat()
    return str(captured_at)


def image_hash(jpeg: bytes) -> str | None:
    """A 64-bit difference hash of the picture, as 16 hex characters, or None if it can't be made.

    The picture is shrunk to 9x8 grey pixels and each bit says whether a pixel is brighter than the
    one to its right. The same view through noise, a brightness change or a small shift of the
    camera moves 0 to 9 of the 64 bits; a different scene moves 20 to 40. Memory uses the distance
    to tell a repeat of the last frame from a new scene that happens to be described the same way.
    Needs Pillow; without it no hash is sent and memory compares descriptions alone, as before.
    """
    try:
        import io

        from PIL import Image

        px = Image.open(io.BytesIO(jpeg)).convert("L").resize((9, 8), Image.LANCZOS).tobytes()
    except Exception:  # Pillow missing, or not a picture: memory falls back to descriptions
        return None
    bits = 0
    for y in range(8):
        for x in range(8):
            bits = (bits << 1) | (px[y * 9 + x] > px[y * 9 + x + 1])
    return f"{bits:016x}"


def _ingest_headers(
    token: str | None, session_id: str, description: str | None, captured_at: Any = None, jpeg: bytes | None = None
) -> dict[str, str] | None:
    token = token or os.environ.get("INGEST_TOKEN")
    if not token:
        return None
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Session-Id": session_id,
        "Content-Type": "image/jpeg",
    }
    if description:
        headers["X-Description"] = quote(description, safe="")
    if captured_at is not None:
        headers["X-Captured-At"] = _iso(captured_at)
    picture = image_hash(jpeg) if jpeg else None
    if picture:
        headers["X-Image-Hash"] = picture
    return headers


def _search_body(session_id: str, question: str, target: str | None, quiet: bool = False) -> dict[str, Any]:
    body: dict[str, Any] = {"session_id": session_id, "question": question}
    if target:
        body["target"] = target
    if quiet:
        body["quiet"] = True     # Iris asking itself: not logged, so the garden doesn't fly to the answer
    return body


# httpx drops an idle connection after 5 s by default, so every save and search paid for a new TLS
# handshake (about 0.5 s to Neon). Kept for two minutes, a busy session reuses one connection.
KEEPALIVE = httpx.Limits(keepalive_expiry=120)


class _Base:
    def __init__(self, base_url: str | None, ingest_token: str | None):
        self.base = _resolve_base(base_url)
        self.token = ingest_token
        self._warned_token = False

    @property
    def enabled(self) -> bool:
        return self.base is not None

    def _headers_or_warn(self, session_id: str, description: str | None, captured_at: Any = None, jpeg: bytes | None = None) -> dict[str, str] | None:
        headers = _ingest_headers(self.token, session_id, description, captured_at, jpeg)
        if headers is None and not self._warned_token:
            log.warning("INGEST_TOKEN isn't set, so frames aren't being saved.")
            self._warned_token = True
        return headers


class MemoryClient(_Base):
    def __init__(self, base_url: str | None = None, ingest_token: str | None = None):
        super().__init__(base_url, ingest_token)
        self.http = httpx.Client(limits=KEEPALIVE)

    def ingest(self, session_id: str, jpeg: bytes, description: str | None = None, captured_at: Any = None) -> dict | None:
        """Save a frame. Returns {saved, id, description, ms}, or None if memory is off or the call failed.

        captured_at is when the glasses took the photo (datetime, Unix time, or ISO string). Default is now.

        Leave description empty only for testing. The function then describes the
        frame itself with a vision model.
        """
        if not self.enabled:
            return None
        headers = self._headers_or_warn(session_id, description, captured_at, jpeg)
        if headers is None:
            return None
        try:
            r = self.http.post(f"{self.base}/ingest", content=jpeg, headers=headers, timeout=INGEST_TIMEOUT_S)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log.warning("memory ingest failed: %s", e)
            return None

    def search(self, session_id: str, question: str, target: str | None = None) -> dict:
        """Find the most recent moment matching the question.

        Always returns a result. On failure, moment is None and error says why.
        Pass target ("phone") if you already know it, to skip one model call.
        """
        if not self.enabled:
            return empty_search(target, "memory is off")
        started = time.monotonic()
        try:
            r = self.http.post(f"{self.base}/search", json=_search_body(session_id, question, target), timeout=SEARCH_TIMEOUT_S)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log.warning("memory search failed after %.1fs: %s", time.monotonic() - started, e)
            return empty_search(target, str(e))

    def moments(self, session_id: str, limit: int = 500) -> list[dict]:
        """Every moment in a session, oldest first. Empty if memory is off or the call failed."""
        if not self.enabled:
            return []
        try:
            r = self.http.get(f"{self.base}/moments", params={"session_id": session_id, "limit": limit}, timeout=LIST_TIMEOUT_S)
            r.raise_for_status()
            return r.json()["moments"]
        except Exception as e:
            log.warning("memory moments failed: %s", e)
            return []


class AsyncMemoryClient(_Base):
    def __init__(self, base_url: str | None = None, ingest_token: str | None = None):
        super().__init__(base_url, ingest_token)
        self._http: httpx.AsyncClient | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def http(self) -> httpx.AsyncClient:
        # An async connection pool belongs to the event loop that opened it. If
        # this client is used from a different loop (tests, asyncio.run in a
        # thread), open a fresh pool there instead of failing.
        loop = asyncio.get_running_loop()
        if self._http is None or self._loop is not loop:
            self._http = httpx.AsyncClient(limits=KEEPALIVE)
            self._loop = loop
        return self._http

    async def ingest(self, session_id: str, jpeg: bytes, description: str | None = None, captured_at: Any = None) -> dict | None:
        if not self.enabled:
            return None
        headers = self._headers_or_warn(session_id, description, captured_at, jpeg)
        if headers is None:
            return None
        try:
            r = await self.http.post(f"{self.base}/ingest", content=jpeg, headers=headers, timeout=INGEST_TIMEOUT_S)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log.warning("memory ingest failed: %s", e)
            return None

    async def warm(self) -> bool:
        """Touch the memory function so it and the connection to it stay warm. Never raises."""
        if not self.enabled:
            return False
        try:
            return (await self.http.get(f"{self.base}/health", timeout=3)).status_code == 200
        except Exception as e:
            log.info("memory warm failed: %s", e)
            return False

    async def search(self, session_id: str, question: str, target: str | None = None, quiet: bool = False) -> dict:
        if not self.enabled:
            return empty_search(target, "memory is off")
        started = time.monotonic()
        try:
            r = await self.http.post(f"{self.base}/search", json=_search_body(session_id, question, target, quiet), timeout=SEARCH_TIMEOUT_S)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log.warning("memory search failed after %.1fs: %s", time.monotonic() - started, e)
            return empty_search(target, str(e))

    async def moments(self, session_id: str, limit: int = 500) -> list[dict]:
        if not self.enabled:
            return []
        try:
            r = await self.http.get(f"{self.base}/moments", params={"session_id": session_id, "limit": limit}, timeout=LIST_TIMEOUT_S)
            r.raise_for_status()
            return r.json()["moments"]
        except Exception as e:
            log.warning("memory moments failed: %s", e)
            return []


if __name__ == "__main__":
    # Self-check, no network: `python brain/memory/client.py`. Needs Pillow.
    import io

    from PIL import Image, ImageDraw, ImageEnhance

    def jpeg_of(img, quality=85):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality)
        return buf.getvalue()

    def bits(a, b):
        return bin(int(image_hash(a), 16) ^ int(image_hash(b), 16)).count("1")

    desk = Image.new("RGB", (800, 600), (200, 190, 170))
    d = ImageDraw.Draw(desk)
    d.rectangle((120, 260, 420, 520), fill=(40, 40, 60))
    d.ellipse((500, 120, 700, 320), fill=(230, 80, 60))
    d.rectangle((0, 540, 800, 600), fill=(90, 60, 40))
    door = Image.new("RGB", (800, 600), (60, 70, 90))
    ImageDraw.Draw(door).rectangle((300, 60, 520, 600), fill=(220, 215, 200))
    a = jpeg_of(desk)
    assert len(image_hash(a)) == 16 and image_hash(a) == image_hash(a)
    assert bits(a, jpeg_of(desk, 50)) <= 2                                             # recompressed
    assert bits(a, jpeg_of(ImageEnhance.Brightness(desk).enhance(1.1))) <= 2           # the light changed a little
    assert bits(a, jpeg_of(desk.crop((16, 6, 800, 600)).resize((800, 600)))) <= 14     # the camera moved a little
    assert bits(a, jpeg_of(door)) >= 20                                                # a different scene
    assert image_hash(b"not a picture") is None
    assert _ingest_headers("t", "s", "d", None, a)["X-Image-Hash"] == image_hash(a)
    assert "X-Image-Hash" not in _ingest_headers("t", "s", "d", None, b"not a picture")
    print("memory client ok")
