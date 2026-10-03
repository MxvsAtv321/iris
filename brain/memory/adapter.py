"""
The brain's side of memory, in the shape the brain already calls.

    from brain.memory import save_moment
    moment_id = save_moment(session_id, captured_at, image_jpeg_bytes, description)

save_moment wraps ingest. It returns the new moment's id (an int), or None when
the frame was skipped as a near-duplicate of the last one, or when memory is
off or unreachable. It never raises, and gives up after 8 s at most.

It blocks while the frame uploads (usually well under a second). From async
code, use save_moment_async, or run save_moment in a thread, so the event loop
isn't held up.
"""

from __future__ import annotations

import threading
from typing import Any

from .client import AsyncMemoryClient, MemoryClient

_sync: MemoryClient | None = None
_async: AsyncMemoryClient | None = None
_lock = threading.Lock()


def _sync_client() -> MemoryClient:
    global _sync
    with _lock:
        if _sync is None:
            _sync = MemoryClient()
        return _sync


def _async_client() -> AsyncMemoryClient:
    global _async
    if _async is None:
        _async = AsyncMemoryClient()
    return _async


def save_moment(session_id: str, captured_at: Any, image_jpeg_bytes: bytes, description: str) -> int | None:
    """Save one frame. Returns the moment id, or None if it wasn't saved."""
    result = _sync_client().ingest(session_id, image_jpeg_bytes, description, captured_at=captured_at)
    return result["id"] if result and result.get("saved") else None


async def save_moment_async(session_id: str, captured_at: Any, image_jpeg_bytes: bytes, description: str) -> int | None:
    """Same as save_moment, for async code."""
    result = await _async_client().ingest(session_id, image_jpeg_bytes, description, captured_at=captured_at)
    return result["id"] if result and result.get("saved") else None


def shared_async_client() -> AsyncMemoryClient:
    """The client the search router uses, so the brain holds one connection pool."""
    return _async_client()
