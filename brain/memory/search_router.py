"""
POST /api/memory/search on the brain, for the phone page and dashboard.

    from memory import save_moment, router    # the brain runs from brain/
    app.include_router(router)

Takes {"session_id", "query"}, asks the Neon memory function, and returns the
flat shape from docs/contracts.md. It answers within about 4 s and never
returns an error status, so a memory problem can't break the page. When
nothing matches, or memory is down, found is false.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from .adapter import shared_async_client

log = logging.getLogger("iris.memory")
router = APIRouter()


class SearchRequest(BaseModel):
    session_id: str
    query: str


NOT_FOUND: dict[str, Any] = {
    "found": False,
    "moment_id": None,
    "captured_at": None,
    "description": None,
    "image_url": None,
    "score": None,
    "target": None,
}


def to_flat(result: dict[str, Any]) -> dict[str, Any]:
    """The function's nested search result, flattened to the contract's shape. Change field names here only."""
    m = result.get("moment")
    if not m:
        return {**NOT_FOUND, "target": result.get("target") or None}
    return {
        "found": True,
        "moment_id": m["id"],
        "captured_at": m["captured_at"],
        "description": m["description"],
        "image_url": m["image_url"],
        "score": m.get("similarity"),
        "target": result.get("target") or None,
    }


def safe_flat(result: Any) -> dict[str, Any]:
    """to_flat, but an unexpected response becomes the not-found shape instead of a 500."""
    try:
        if not isinstance(result, dict):
            raise TypeError(f"expected a dict, got {type(result).__name__}")
        return to_flat(result)
    except Exception as e:
        log.warning("memory search returned an unexpected shape (%s), answering not found", e)
        return dict(NOT_FOUND)


@router.post("/api/memory/search")
async def search(req: SearchRequest) -> dict[str, Any]:
    try:
        result = await shared_async_client().search(req.session_id, req.query)
    except Exception as e:  # the client shouldn't raise, but the brain must never see a 500
        log.warning("memory search failed: %s", e)
        return dict(NOT_FOUND)
    return safe_flat(result)
