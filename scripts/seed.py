"""
Load sample photos into memory and run test searches, so search works before
the real glasses feed is connected.

    python scripts/seed.py path/to/photos --session demo-seed
    python scripts/seed.py path/to/photos --session demo-seed --ask "where did I leave my phone?"

Photos are saved in filename order, so name them 01.jpg, 02.jpg and so on in
the order you want them to have happened. Descriptions come from the
function's vision fallback, since the brain isn't in the loop here.

Needs MEMORY_URL and INGEST_TOKEN.
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from brain.memory import MemoryClient  # noqa: E402

DEFAULT_QUESTIONS = [
    "where did I leave my phone?",
    "where are my keys?",
    "when did I last see my water bottle?",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", type=Path)
    ap.add_argument("--session", default="demo-seed")
    ap.add_argument("--ask", action="append", help="question to test, repeatable")
    ap.add_argument("--gap", type=float, default=1.0, help="seconds between photos so timestamps differ")
    args = ap.parse_args()

    memory = MemoryClient()
    photos = sorted(p for p in args.folder.iterdir() if p.suffix.lower() in {".jpg", ".jpeg"})
    if not photos:
        sys.exit(f"no .jpg files in {args.folder}")

    print(f"seeding {len(photos)} photos into session {args.session}")
    for p in photos:
        result = memory.ingest(args.session, p.read_bytes())
        if result is None:
            print(f"  {p.name}  failed, see warning above")
        elif result["saved"]:
            print(f"  {p.name}  saved #{result['id']}  {result['description'][:70]}")
        else:
            print(f"  {p.name}  skipped as a duplicate")
        time.sleep(args.gap)

    for q in args.ask or DEFAULT_QUESTIONS:
        r = memory.search(args.session, q)
        m = r["moment"]
        print(f"\n? {q}   target={r['target']!r}  {r['ms']}ms")
        if m:
            print(f"  -> #{m['id']} at {m['captured_at']}  sim={m['similarity']:.2f}  keyword={m['keyword_match']}")
            print(f"     {m['description'][:90]}")
        else:
            print("  -> no match")
        for t in r["top"]:
            print(f"     top #{t['id']} sim={t['similarity']:.2f} {t['description'][:60]}")


if __name__ == "__main__":
    main()
