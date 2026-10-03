# Iris memory (Darren)

How Iris remembers what it sees and finds it again, and the VR memory garden. Commands run from the repo root unless they `cd` first. Every setting lives in the root `.env` (see the memory keys in the root `.env.example`). The API other parts build against is the Memory section of `docs/contracts.md`.

## What's here

- `neon/` is the memory API, one Neon Function with every route, plus `neon.ts` (the function, Neon Auth, and the `uploads` bucket) and `db/schema.sql` for the database.
- `brain/memory/` is what the brain uses. `save_moment` saves a frame, the FastAPI `router` serves `POST /api/memory/search`, and `MemoryClient` sits underneath both.
- `web/src/garden/` is the memory garden at `/garden`, with the depth step and VR.
- `scripts/seed.py` loads sample photos and runs test searches. `scripts/relay.py` saves live camera frames without the brain. `scripts/check_deploy.py` checks a live setup end to end.

## How it fits together

The brain describes each frame and calls `save_moment`, which sends the JPEG and description to the memory function on Neon. The function embeds the description with OpenAI, inserts a row into the `memories` table (skipping frames that match the last one), and stores the photo in the private `uploads` bucket in Neon Object Storage. The row and the photo are saved together, so a moment never exists without its photo.

Searches come from two places. The phone page and dashboard call the brain's `POST /api/memory/search`, and the garden calls the memory function directly. Either way the function finds the most recent moment that matches, and logs the question so the garden can follow along and open the answer in 3D.

Everything a judge touches (phone page, dashboard, garden, brain) is served through the team's one Cloudflare tunnel, so it all shares one HTTPS address. The memory function runs on Neon, so it keeps working even if a laptop sleeps.

## Setup

Memory uses the team's Neon project, `delicate-cherry-79336457`, on its `production` branch, so everyone shares one database. Functions and Object Storage need the project in AWS US East (Ohio or N. Virginia), Frankfurt, or Singapore.

1. Install the CLI and sign in with `npm install -g neon@latest` and `neon auth`.
2. Link this folder to the shared project.

        cd neon
        neon link --project-id delicate-cherry-79336457 --branch production -y
        npm install

3. Paste all of `neon/db/schema.sql` into the SQL Editor for that project and run it. It's safe to run again.
4. Fill in the memory keys in the root `.env`. `INGEST_TOKEN` is any long random string (`openssl rand -hex 24`).
5. Deploy from `neon/` with `npm run deploy`. This applies `neon.ts`, which turns on Neon Auth, creates the private `uploads` bucket, and deploys the `memory` function. Nothing else is declared, so a template's `hello` function never gets deployed. If one was deployed earlier, remove it with `neon functions delete hello`.
6. Run `neon functions get memory` and put the origin of `invocation_url` in `MEMORY_URL` in the root `.env`. Hit `$MEMORY_URL/api/memory/health` once before judging so the function is warm.

`neon.ts` declares `functions` and `buckets` at the top level. Some Neon templates put them under `preview:`, but that's deprecated since `@neon/config` 1.6.0 and this project pins 1.8, so no `preview:` block is needed. `npm run deploy` writes the branch's credentials to `neon/.env.local`, which is gitignored.

**Neon Auth is enabled but not used yet.** Pages pass a plain `session_id`, and no page signs judges in. The memory function is ready for it, though. If a request ever carries a signed-in judge's Neon Auth token as `Authorization: Bearer <token>`, the function verifies it and uses that judge's user id as the session. Requests without a token, which is every request today, use the `session_id` they name.

## Wiring it into the brain

    from memory import save_moment, router    # the brain runs from brain/

    app.include_router(router)                # serves POST /api/memory/search

    moment_id = save_moment(session_id, captured_at, image_jpeg_bytes, description)

`save_moment` returns the new moment's id, or `None` when the frame was skipped as a near-duplicate or memory was unreachable. It never raises and gives up after 8 s. It blocks while the frame uploads, so from async code use `save_moment_async` (same arguments) or run it in a thread. `captured_at` can be a datetime, a Unix time, or an ISO string.

Write descriptions that name the visible objects plainly first ("phone, keys, laptop"), then one sentence about the scene. Search quality depends on this more than anything else.

The router never returns an error status. If memory is down or nothing matches, `found` is `false`. The flat result shape is in `brain/memory/search_router.py` (`to_flat`) and in `docs/contracts.md`.

If `MEMORY_URL` isn't set, everything in `brain/memory` logs one warning and switches off, so the brain still runs without memory.

## Testing with sample photos

Take about 20 photos on your phone, with your phone, keys and a water bottle in a few of them. Name them in order (01.jpg, 02.jpg and so on), then

    python3 -m venv .venv && source .venv/bin/activate
    pip install -r brain/memory/requirements.txt
    set -a; source .env; set +a
    python scripts/seed.py path/to/photos --session demo-seed

It prints what was saved and what each test question found. Add your own with `--ask "where is my badge?"`.

To save live frames from the glasses without the brain, on a laptop joined to the hotspot run `python scripts/relay.py --session live-test`. It reads the camera's base address from `CAMERA_URL` and fetches `/capture` from it.

## The memory garden

Open `/garden?session=<id>`. Each moment is a glowing bud along a winding path, newest by the entrance, so walking the path walks back in time. Asking where something is, typed in the garden or asked through the phone page, makes the matching bud bloom gold, glides to it, and opens that moment in 3D. New moments appear on their own every few seconds.

The depth step runs Depth Anything V2 Small in the browser. The first time a moment opens, the browser computes its depth map and saves it back to Neon, so later views are instant. The model downloads once per device, so open the garden on the demo headset before judging starts.

On a laptop, drag to look around and click a bud. On a Quest, press Enter VR, point at the ground to teleport, and click a bud. With only a phone, press Cardboard, then look at a bud and hold still to select it.

**Running it.** Set `VITE_MEMORY_URL` in the root `.env` (it defaults to `MEMORY_URL`). Only `VITE_` settings reach the browser.

    cd web
    npm install
    npm run dev      # port 5173, for working on it
    npm run serve    # port 4173, a production build, use this behind the tunnel for judging

**Behind the tunnel.** The team's tunnel provides the HTTPS that VR needs. Point it at the web app's port for `/garden` and the other page routes, and set `TUNNEL_HOST` in the root `.env` to the tunnel's hostname, because Vite refuses hostnames it doesn't know. Once the hostname is settled, set `WEB_ORIGIN=https://<tunnel host>` and redeploy the memory function, so only the team's site can call memory from a browser.

**Fitting it into the team's app.** If the app has a router, mount `<Garden />` from `src/garden/Garden.tsx` at `/garden` and keep it lazy-loaded like `App.tsx` does, since the 3D code is large and the other pages don't need it. The garden's styles are all scoped under `.garden`.

**Swapping in the shared look.** Every color in the garden, 2D and 3D, comes from the tokens at the top of `src/garden/garden.css`. Change the values there and the scene follows. Keep them as hex or `rgb()`. For the font, change `--font` there and the font link in `index.html`, then put `.woff` files in `public/fonts` and point `FONT_REGULAR` and `FONT_BOLD` in `src/garden/theme.ts` at them.

## Checking a live setup

With the function deployed and the web app and brain running behind the tunnel, run

    python scripts/check_deploy.py --web https://<tunnel host>

It checks the garden loading over HTTPS against the right memory address, the memory API allowing calls from the site, saving and finding a test moment within budget, numeric ids, the photo coming back from the `uploads` bucket, and the brain's `POST /api/memory/search` returning the flat shape and finding that test moment. Each failure prints its fix. Use `--no-brain` before the brain is up.

## Timeouts

Search is one embedding call and one database query, so it answers well inside the brain's 2 s budget, usually in a few hundred milliseconds. The object being asked about ("phone" in "where did I leave my phone?") comes from the question's words, with no model call. If the embedding service hangs, search gives up at about 1.5 s. Ingest gives up within 8 s. The Python client's limits are 4 s for search and 8 s for ingest, every garden request gives up at 4 s, and every OpenAI call inside the function stops after about 3 s with no retries.

## Tuning

`DEDUPE_THRESHOLD` (0.95) is how similar a frame must be to the last saved one to be skipped. Lower it if near-identical frames pile up, raise it if real changes get skipped.

`SEARCH_MIN_SIMILARITY` (0.30) is the floor for counting a frame as a match by meaning alone. Run the seed script with real photos and look at the `sim=` numbers to set it. Changing either means redeploying the function.
