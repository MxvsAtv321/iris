from .adapter import save_moment, save_moment_async
from .client import AsyncMemoryClient, MemoryClient, empty_search

__all__ = ["save_moment", "save_moment_async", "router", "MemoryClient", "AsyncMemoryClient", "empty_search"]


def __getattr__(name: str):
    # The router needs FastAPI. Load it only when asked for, so scripts that
    # just use the client (seed, relay) don't need FastAPI installed.
    # The file is search_router.py, not router.py, on purpose. A submodule named
    # router would shadow this and hand back the module instead of the router.
    if name == "router":
        from .search_router import router

        return router
    raise AttributeError(name)
