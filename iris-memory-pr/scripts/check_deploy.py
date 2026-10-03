"""
Checks a live deployment end to end, from a browser's point of view.

Run it after deploying the memory function, with the web app and the brain
running behind the team's Cloudflare tunnel. Every check prints what's wrong
and how to fix it.

    python scripts/check_deploy.py --web https://<tunnel host>

Uses MEMORY_URL and INGEST_TOKEN from the environment, like the other scripts.

    --no-write      skip the check that saves and finds a test moment
    --no-brain      skip the brain checks (before the brain is ready)
    --brain         the brain's address, if it isn't the same as --web
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx

# A valid 1x1 JPEG, enough for the API to store.
TINY_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c"
    "20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f000001050101010101010000"
    "0000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191"
    "a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a"
    "737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8"
    "d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd3ffd9"
)

results: list[bool] = []


def check(name: str, ok: bool, detail: str = "", fix: str = "") -> bool:
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if not ok and fix:
        print(f"        fix: {fix}")
    return ok


def origin(url: str) -> str:
    u = urlparse(url)
    return f"{u.scheme}://{u.netloc}"


def is_secure_or_local(url: str) -> bool:
    u = urlparse(url)
    return u.scheme == "https" or u.hostname in ("localhost", "127.0.0.1")


def cors_allows(resp: httpx.Response, web_origin: str) -> bool:
    allowed = resp.headers.get("access-control-allow-origin", "")
    return allowed in ("*", web_origin)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--web", required=True, help="the team's tunnel address")
    ap.add_argument("--memory", default=os.environ.get("MEMORY_URL"))
    ap.add_argument("--brain", default=None, help="defaults to --web, since one tunnel serves both")
    ap.add_argument("--no-write", action="store_true")
    ap.add_argument("--no-brain", action="store_true")
    args = ap.parse_args()

    if not args.memory:
        sys.exit("set MEMORY_URL or pass --memory")
    web = args.web.rstrip("/")
    web_origin = origin(web)
    memory = args.memory.rstrip("/")
    api = f"{memory}/api/memory"
    http = httpx.Client(timeout=15, follow_redirects=True)

    # ------------------------------------------------------------ web app
    print("\nWeb app through the tunnel")
    check("served over https", is_secure_or_local(web), web, "VR and the phone mic only work on https pages")
    try:
        page = http.get(f"{web}/garden?session=deploy-check")
        html = page.text
        check("/garden loads the app", page.status_code == 200 and 'id="root"' in html, f"HTTP {page.status_code}",
              "the tunnel has to send /garden to the web app, which answers every app path with index.html")
        script = re.search(r'src="(/assets/index-[^"]+\.js)"', html)
        if check("app code is referenced", bool(script), "", "the upload looks incomplete, run npm run deploy again"):
            js = http.get(f"{web}{script.group(1)}")
            check("app code downloads", js.status_code == 200 and "javascript" in js.headers.get("content-type", ""),
                  f"HTTP {js.status_code}")
            # The garden is lazy-loaded, so the memory address lives in a chunk the entry file imports.
            texts = [js.text]
            for name in sorted(set(re.findall(r"[\w-]+\.js", js.text))):
                if name.startswith("Garden-") or name.startswith("index-"):
                    chunk = http.get(f"{web}/assets/{name}")
                    if chunk.status_code == 200:
                        texts.append(chunk.text)
            check("app points at this memory API", any(memory in t for t in texts), memory,
                  "VITE_MEMORY_URL is baked in at build time. Set it in the root .env and rebuild the web app")
        font = http.get(f"{web}/fonts/literata-latin-400-normal.woff")
        check("3D label font downloads", font.status_code == 200 and font.content[:4] == b"wOFF", f"HTTP {font.status_code}")
    except httpx.HTTPError as e:
        check("web app reachable", False, str(e), "is the tunnel running, and pointed at the web app?")

    # ------------------------------------------------------------ memory API
    print("\nMemory API on Neon")
    try:
        h = http.get(f"{api}/health")
        check("health", h.status_code == 200, f"HTTP {h.status_code}", "deploy it with npm run deploy in neon/")
        pre = http.options(f"{api}/search", headers={
            "Origin": web_origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
        check("browser calls from the web app are allowed", cors_allows(pre, web_origin),
              pre.headers.get("access-control-allow-origin", "no CORS header"),
              f"set WEB_ORIGIN={web_origin} in the root .env and redeploy the memory function")
    except httpx.HTTPError as e:
        check("memory API reachable", False, str(e), "check MEMORY_URL")

    if not args.no_write:
        token = os.environ.get("INGEST_TOKEN")
        if check("INGEST_TOKEN is set", bool(token), "", "export the same INGEST_TOKEN the function was deployed with"):
            session = f"deploy-check-{int(time.time())}"
            saved_id = None
            try:
                started = time.monotonic()
                r = http.post(f"{api}/ingest", content=TINY_JPEG, headers={
                    "Authorization": f"Bearer {token}", "X-Session-Id": session, "Content-Type": "image/jpeg",
                    "X-Description": "deploy%20check%20lantern.%20A%20test%20moment."})
                body = r.json() if "json" in r.headers.get("content-type", "") else {}
                saved = check("saving a moment works", r.status_code == 200 and body.get("saved") is True,
                              f"HTTP {r.status_code}, {time.monotonic() - started:.1f}s {body.get('error', '')}".strip(),
                              "a 401 means INGEST_TOKEN doesn't match the deployed one, a 502 usually means a bad OPENAI_API_KEY")
                if not saved:
                    raise StopIteration  # nothing to search for
                saved_id = body.get("id")
                check("ids are numbers", isinstance(saved_id, int), repr(saved_id), "redeploy the memory function")
                started = time.monotonic()
                s = http.post(f"{api}/search", json={"session_id": session, "question": "where is the lantern?", "target": "lantern"})
                found = s.json().get("moment") if s.status_code == 200 else None
                took = time.monotonic() - started
                check("finding it again works", bool(found) and found.get("id") == body.get("id"), f"{took:.1f}s",
                      "the moment saved but search missed it, check the function logs")
                check("search is inside the brain's 4 s budget", took < 4, f"{took:.1f}s")
                if found:
                    img = http.get(found["image_url"])
                    check("photo comes back from the uploads bucket", img.status_code == 200 and img.content == TINY_JPEG,
                          f"HTTP {img.status_code}",
                          "the uploads bucket is missing or unreachable. Check buckets in neon/neon.ts and run npm run deploy in neon/")
            except StopIteration:
                pass
            except (httpx.HTTPError, ValueError) as e:
                check("saving and finding a moment", False, str(e))

    # ------------------------------------------------------------ brain
    if not args.no_brain:
        brain = (args.brain or web).rstrip("/")
        print("\nBrain's memory search (the adapter)")
        session_for_brain = locals().get("session") or "deploy-check"
        try:
            started = time.monotonic()
            r = http.post(f"{brain}/api/memory/search",
                          json={"session_id": session_for_brain, "query": "where is the lantern?"},
                          headers={"Origin": web_origin})
            took = time.monotonic() - started
            flat = r.json() if "json" in r.headers.get("content-type", "") else {}
            check("brain answers POST /api/memory/search", r.status_code == 200, f"HTTP {r.status_code}, {took:.1f}s",
                  "include the memory router in the brain: app.include_router(router) after from memory import router, "
                  "and make sure the tunnel sends /api to the brain")
            check("answer is the flat shape", {"found", "moment_id", "description", "captured_at"} <= set(flat),
                  ", ".join(sorted(flat)) or "not JSON")
            if not args.no_write and locals().get("saved_id"):
                check("brain finds the test moment through memory", flat.get("found") is True
                      and flat.get("moment_id") == locals().get("saved_id"),
                      f"moment_id={flat.get('moment_id')}",
                      "the brain can't reach memory. Check MEMORY_URL in the .env on the brain's laptop")
            check("brain search is inside the 4 s budget", took < 4.5, f"{took:.1f}s")
        except (httpx.HTTPError, ValueError) as e:
            check("brain reachable", False, str(e), "is the brain running behind the tunnel?")

    passed, total = sum(results), len(results)
    print(f"\n{passed}/{total} checks passed" + ("" if passed == total else ", fix the FAIL lines above and run this again"))
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
