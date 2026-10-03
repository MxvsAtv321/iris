"""
POST /api/memory/search on the brain, for the phone page and dashboard.

    from brain.memory import router as memory_router
    app.include_router(memory_router)

Takes {"session_id", "query"}, asks the Neon memory function, and returns the
flat shape from docs/contracts.md. It answers within about 4 s and never
returns an error status, so a memory problem can't break the page. When
nothing matches, or memory is down, found is false.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from .adapter import shared_async_client

router = APIRouter()


class SearchRequest(BaseModel):
    session_id: str
    query: str


def to_flat(result: dict[str, Any]) -> dict[str, Any]:
    """The function's nested search result, flattened to the contract's shape. Change field names here only."""
    m = result.get("moment")
    return {
        "found": m is not None,
        "moment_id": m["id"] if m else None,
        "captured_at": m["captured_at"] if m else None,
        "description": m["description"] if m else None,
        "image_url": m["image_url"] if m else None,
        "score": m.get("similarity") if m else None,
        "target": result.get("target") or None,
    }


@router.post("/api/memory/search")
async def search(req: SearchRequest) -> dict[str, Any]:
    result = await shared_async_client().search(req.session_id, req.query)
    return to_flat(result)
