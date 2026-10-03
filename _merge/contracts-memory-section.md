## Memory (Darren)

Memory saves what the glasses see and finds it again. It's one Neon Function next to the team's Neon Postgres database and Object Storage (project `delicate-cherry-79336457`, branch `production`), so it keeps working if any laptop sleeps. Setup and internals are in `neon/README.md`.

### Where it lives

The memory function's origin goes in `MEMORY_URL` in the root `.env`. Get it with `neon functions get memory` after deploying.

```
MEMORY_URL = https://<branch>-memory.compute.<cell>.us-east-1.aws.neon.tech
routes     = ${MEMORY_URL}/api/memory/...
```

### Storage

Everything is in Neon. Rows live in Postgres, and photos and depth maps live in a private Object Storage bucket called `uploads`, declared in `neon/neon.ts`. Only the memory function can read the bucket, and it checks the judge's session before serving anything.

One row per saved moment in the `memories` table.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint | Numeric, assigned by the database |
| `session_id` | text | One per judge |
| `captured_at` | timestamptz | When the glasses took the photo |
| `image_key` | text | Where the JPEG is in the `uploads` bucket |
| `description` | text | From the brain |
| `embedding` | vector(1536) | OpenAI `text-embedding-3-small` of the description |
| `depth_key` | text | Where the depth map PNG is, filled the first time a moment opens in 3D |

A moment's row only becomes visible once its photo is stored, so a moment never exists without its photo. A second table, `memory_searches`, logs every question so the garden can follow questions asked through the phone page.

Every id in every response is a JSON number, never a string.

### Sessions and Neon Auth

Every moment belongs to a `session_id`, one per judge. Neon Auth is enabled on the project (`auth: true` in `neon/neon.ts`). When a page sends a signed-in judge's token as `Authorization: Bearer <token>` (from the Neon Auth client's `authClient.token()`), the memory function verifies it and uses the token's user id as the session, whatever `session_id` the request names. A tampered or expired token gets a 401. Requests without a token use the `session_id` they pass, which is how the brain and image links work. For sessions that line up across everything, use the signed-in judge's user id as the `session_id` the brain saves frames under.

### The brain's side

The brain doesn't call the routes below directly. It uses `brain/memory`.

```python
from brain.memory import save_moment, router as memory_router

app.include_router(memory_router)   # serves POST /api/memory/search on the brain

moment_id = save_moment(session_id, captured_at, image_jpeg_bytes, description)
```

`save_moment(session_id, captured_at, image_jpeg_bytes, description) -> int | None` returns the new moment's id, or `None` when the frame was skipped as a near-duplicate of the last one or memory was unreachable. It never raises and gives up after 8 s. `captured_at` can be a datetime, a Unix time, or an ISO string. Descriptions should name visible objects plainly first ("phone, keys, laptop"), then one sentence about the scene. For async code, `save_moment_async` takes the same arguments.

### POST /api/memory/search (on the brain)

For the phone page and dashboard, through the team tunnel.

```json
{ "session_id": "judge-1", "query": "where did I leave my phone?" }
```

```json
{
  "found": true,
  "moment_id": 42,
  "captured_at": "2026-10-04T03:12:09.000Z",
  "description": "phone, mug. A desk by the window.",
  "image_url": "<MEMORY_URL>/api/memory/moments/42/image?session_id=judge-1",
  "score": 0.41,
  "target": "phone"
}
```

It answers within about 4 s and never returns an error status. When nothing matches or memory is down, `found` is `false` and the other fields are `null`. The match is the most recent moment showing the object, since "where is it" means where it was last seen.

### Memory function routes

Under `${MEMORY_URL}/api/memory`. Reads are scoped to one judge's session, from a verified Neon Auth token if one is sent, otherwise from `session_id`. Saving frames needs `INGEST_TOKEN`, which never goes to the browser.

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /ingest` | brain, through `save_moment` | Saves a frame. Raw JPEG body. Headers `Authorization: Bearer <INGEST_TOKEN>`, `X-Session-Id`, `X-Captured-At` (ISO 8601), `X-Description` (URI-encoded). Returns `{ "saved": true, "id": 42, "description": "...", "ms": 310 }`, or `saved: false` and `id: null` for a near-duplicate. |
| `POST /search` | brain router, garden | `{ "session_id", "question", "target"? }`. Returns `{ "search_id", "target", "moment", "top", "ms" }`, where `moment` is the match or `null` and `top` is the five closest by meaning. |
| `GET /moments?session_id=&limit=` | garden | Every moment in the session, oldest first |
| `GET /moments/:id/image?session_id=` | garden, phone page | The JPEG, served from the `uploads` bucket |
| `GET /moments/:id/depth?session_id=` | garden | The cached depth map PNG from the bucket, or 404 until the garden makes one |
| `PUT /moments/:id/depth?session_id=` | garden | Stores a depth map the browser computed (PNG body) in the bucket |
| `GET /searches/latest?session_id=` | garden | The newest question for the session, so a question asked through the phone page opens its answer in VR |
| `GET /health` | anyone | `{ "ok": true }` |

A moment, wherever it appears, looks like

```json
{
  "id": 42,
  "captured_at": "2026-10-04T03:12:09.000Z",
  "description": "phone, mug. A desk by the window.",
  "has_depth": false,
  "image_url": "<MEMORY_URL>/api/memory/moments/42/image?session_id=judge-1",
  "depth_url": "<MEMORY_URL>/api/memory/moments/42/depth?session_id=judge-1"
}
```

Search results add `similarity` and `keyword_match`.

### Timeouts and errors

The Python client gives up after 4 s for search and 8 s for ingest, and the garden after 4 s for every request. Inside the function, every OpenAI call stops after about 3 s with no retries. Errors come back as `{ "error": "..." }` with 400 for a bad request, 401 for a wrong ingest token or an invalid sign-in token, 413 for an oversized image, 502 when a model call failed, and 503 when the database is briefly unavailable. Retrying later is always safe.

### Settings

`MEMORY_URL`, `INGEST_TOKEN`, `OPENAI_API_KEY`, `DESCRIBE_URL`, `VISION_MODEL`, `TEXT_MODEL`, `DEDUPE_THRESHOLD`, `SEARCH_MIN_SIMILARITY`, `WEB_ORIGIN`, plus `VITE_MEMORY_URL` and `TUNNEL_HOST` for the web app. All are in the root `.env.example`.
