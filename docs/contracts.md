# Iris contracts

Everyone builds against these shapes. The owner may change their contract: update this file in a small pull request, tag the people who depend on it, and post in the team chat.

## Hardware (owner: Shrirang)

| Call | Result |
| --- | --- |
| `GET http://172.20.10.4/capture` | One JPEG from the glasses camera (about 0.2 s at 800x600). |
| `GET http://172.20.10.4/control?var=<name>&val=<n>` | Changes one camera setting until the camera restarts. The brain sends `framesize` 11 (800x600), `vflip` 0 and `hmirror` 1 at startup and at every session start, from `CAMERA_FRAMESIZE`, `CAMERA_VFLIP` and `CAMERA_HMIRROR`. |
| `GET http://172.20.10.4/status` | The camera's current settings as JSON. |
| `GET http://172.20.10.6/show?text=<url-encoded text>` | Shows the text on the glasses display. Under 40 characters stays in the large font. Returns `ok`. The text stays until it is replaced or cleared. |
| `GET http://172.20.10.6/show?text=...&eye=answer&hold=<ms>` | The eye blinks, the text shows for `hold` ms (default 4000), then the eye rests open for about 3 s and closes. The eye opens first if it is shut. |
| `GET http://172.20.10.6/show?text=...&eye=nudge&hold=<ms>` | The eye flicks open and blinks, the text shows for `hold` ms (default 5000), then the display goes dark. |
| `GET http://172.20.10.6/eye?anim=<name>` | Plays an eye animation at about 30 frames a second: `open`, `listening`, `thinking`, `speaking`, `idle`, `blink`, `close`. The eye opens first if it is shut. `listening`, `thinking` and `speaking` loop until the next call, and close by themselves after 15 s (`&for=<ms>` changes that). `idle` holds the eye open with a blink every 3 to 5 s. Returns `ok`, or 400 for an unknown name. |
| `GET http://172.20.10.6/clear` | Stops any animation and clears the display. Returns `ok`. |
| `GET http://172.20.10.6/status` | JSON: `state`, `eye_open`, `fps`, `draw_ms`, `cmd_to_first_frame_ms`. |

Use the IPs, never the `.local` names (about 5 s slower per request on macOS).

## Brain (owner: Matthew)

All routes are served by one FastAPI app on the integration laptop under `/api`.

### `POST /api/ask`

Request:
```json
{ "session_id": "judge-01", "text": "how much protein is in this?" }
```

Response:
```json
{
  "display": "12g protein per bar",
  "speak": "That bar has about 12 grams of protein.",
  "level": "speak",
  "latency_ms": 1840
}
```

`level` is one of `silent`, `display`, `speak`. `speak` may be an empty string. Never returns a 500: on failure `display` is "Didn't catch that, try again".

### `POST /api/session`, `DELETE /api/session`

`POST { "session_id": "judge-01" }` makes that session active and starts the watch loop; returns `{ "session_id", "earlier" }` (how many descriptions were carried over from the previous session). `DELETE` stops the loop. Cooldowns reset per session, so every judge gets the nudge.

### `POST /api/wake`

`POST { "session_id": "judge-01" }` when the phone hears the wake word "Iris". The eye on the glasses opens and listens, and the watch loop holds its nudges for 10 s. Returns `{ "eye": true, "display_ms": 48 }`: whether the display answered, and how long the brain waited for it (at most 1 s). The phone does not need to wait for the reply.

During `/api/ask` the brain drives the eye itself: it thinks while the model works, then blinks and shows the answer. A nudge from the watch loop arrives as a quick blink, then the text.

### `GET /api/live?q=...`

The live data a question would get, for testing and the dashboard: `{ "topics": ["sky"], "note": "Tonight in Ann Arbor: sunset 7:12 PM, ...", "sources": ["Open-Meteo"] }`. Topics: `weather`, `sky`, `launch`, `iss`. Questions on these topics are answered from this data (without the photo unless they say "this" or "that").

### `GET /api/scene`

What the glasses have just seen, for the Act agent: `{ "session_id": "judge-01" | null, "recently_seen": ["19:02 a protein bar on a wooden table"], "already_said": [] }`. `session_id` is null when no session is running.

### `GET /api/frame`, `GET /api/frame/{frame_id}`

`GET /api/frame` is the newest camera frame the brain holds, as `image/jpeg`, from the watch loop or a question. `204` before the first frame. Never cached.

`GET /api/frame/{frame_id}` is the frame behind one decision. Use the decision's `trace.frame_url` rather than building the path: it carries a `?v=` token that changes when the brain restarts, because frame ids start again from `f_0001`. The brain keeps the newest 450 frames (about 15 minutes); older ones return `404`.

### `GET /api/trace`

What the dashboard loads when it opens, so it can join a session partway through. Read-only: it never starts, restarts or touches a session.

```json
{ "session_id": "judge-01",
  "events": [ { "type": "decision", "...": "..." }, { "type": "answer", "...": "..." } ],
  "metrics": { "answer_latency_ms_p50": 1700, "gate_accuracy": 0.9, "moments_seen": 412, "...": "..." } }
```

- `session_id` is the running session, or `null` when none is.
- `events` are that session's `decision` and `answer` events, oldest first, in the same shape as on the WebSocket, up to the newest 1800 (an hour of frames). After a session stops they stay until another session's first event. They are held in memory, so a brain restart empties them.
- `metrics` has the same fields as the `metrics` event.

### `POST /api/show`

Request: `{ "text": "Stay in" }`. Puts the text on the glasses display (cut to 40 characters) and returns `{ "text": "Stay in", "shown": true }`. `shown` is false when the text is empty or the display doesn't answer.

### `GET /api/tts?text=...`

Streams `audio/mpeg` (ElevenLabs). Returns `204` if speech is unavailable; just show the text.

### `POST /api/transcribe` (draft)

Multipart `audio` (a MediaRecorder clip) and `session_id`. Returns `{ "text": "...", "dropped_as_echo": false }`. Empty `text` means don't ask: either nothing was heard, or it was Iris's own voice coming back through the mic. Then call `/api/ask` with the text.

### WebSocket `/api/ws`

One JSON message per event. Every message has `type`, `session_id` and `at` (ISO 8601 timestamp).

```json
{ "type": "decision", "session_id": "judge-01", "at": "2026-10-03T19:02:11Z",
  "level": "speak", "text": "Line 2: 7x8 is 56", "speak": "Line 2 says seven times eight is fifty-four, it's fifty-six.",
  "reason": "urgency 9: arithmetic error on whiteboard", "frame_id": "f_0192",
  "focus_box": [0.12, 0.31, 0.55, 0.09],
  "trace": { "...": "see Decision trace below" } }

{ "type": "answer_delta", "session_id": "judge-01", "at": "...", "ask_id": "a_0007", "text": "12g prot" }

{ "type": "answer", "session_id": "judge-01", "at": "...", "ask_id": "a_0007",
  "question": "how much protein is in this?", "display": "12g protein per bar",
  "speak": "That bar has about 12 grams of protein.", "latency_ms": 1840, "first_word_ms": 620,
  "context": [] }

{ "type": "memory_saved", "session_id": "judge-01", "at": "...",
  "moment_id": "m_0192", "description": "a protein bar on a wooden table" }

{ "type": "metrics", "session_id": "judge-01", "at": "...",
  "answer_latency_ms_p50": 1700, "answer_latency_ms_p95": 2400, "first_word_ms_p50": 650,
  "gate_precision": 0.9, "gate_accuracy": 0.9, "gate_precision_basis": "measured on 10 test photos",
  "moments_seen": 412, "moments_silent": 404, "moments_shown": 5, "moments_spoken": 3,
  "model_calls_today": 112, "model_usd_today": 0.41,
  "ask_model": "xai:grok-4.20-non-reasoning", "watch_model": "xai:grok-4.20-reasoning" }
```

- Every gate call emits a `decision`, including silent ones, so the dashboard can show what Iris chose not to say.
- `focus_box` is `[x, y, w, h]` as fractions (0 to 1) of the image, origin top left: where Iris is looking. It is on every decision. On "no change" frames it repeats the last box; it is `null` on errors or before the first look.
- `speak` on a decision is the sentence to say; empty unless `level` is `speak`. `text` is the display line.
- `answer_delta.text` is new text only: append it. Deltas for one question share an `ask_id`, and the final `answer` carries the same `ask_id`. The text is two lines: the display line, then the spoken answer.
- `answer.context` lists the live data sources the answer used, e.g. `["Open-Meteo", "Launch Library 2 (SpaceX)"]`; empty for ordinary questions.
- `model_usd_today` is model spend reported by the providers (Grok credits included); `ask_model` / `watch_model` are `provider:model[@effort]`.
- `gate_precision` comes from the bake-off, not live use. Show it with `gate_precision_basis`, e.g. "Gate precision 0.9, measured on test photos". It is `null` until the bake-off has run.
- `gate_accuracy` is the share of test photos where the gate chose the expected level (the bake-off's `level_agreement` for the watch model). Same basis and same `null` rule as `gate_precision`.
- `moments_seen` counts every decision in the running session, and `moments_silent` + `moments_shown` + `moments_spoken` add up to it.
- **Phone audio:** play speech only from WebSocket events. A `decision` with `level: "speak"` means fetch `/api/tts?text=<speak>`; an `answer` with non-empty `speak` means the same. Never play from the `/api/ask` HTTP response, or it plays twice. Unlock audio with a tap at session start, because mobile browsers block autoplay.

### Decision trace

Every `decision` carries `trace`: how Iris got to that verdict. All keys are always present.

```json
"trace": {
  "frame_url": "/api/frame/f_0192?v=68e06b2f",
  "looked": true,
  "skipped": null,
  "change": { "score": 31.4, "threshold": 12 },
  "saw": "A whiteboard of times tables. Line 2 reads 7 x 8 = 54.",
  "why": "arithmetic error on whiteboard",
  "topic": "whiteboard-math",
  "model": "xai:grok-4.20-reasoning",
  "candidate": { "text": "Line 2: 7x8 is 56", "say": "Line 2 says seven times eight is fifty-four, it's fifty-six." },
  "urgency": 9, "display_at": 5, "speak_at": 8,
  "proposed": "speak",
  "rules": [
    { "rule": "cooldown", "outcome": "blocked", "detail": "nudged about 'whiteboard-math' 20 s ago; one per 120 s" },
    { "rule": "repeat", "outcome": "blocked", "similarity": 0.86, "threshold": 0.6, "detail": "already said 'Line 2 says ...'" },
    { "rule": "quiet_after_answer", "outcome": "passed", "detail": "no question in the last 10 s" },
    { "rule": "rate_limit", "outcome": "passed", "detail": "nothing spoken in the last 15 s" }
  ],
  "blocked_by": "cooldown",
  "verdict": "silent",
  "latency_ms": { "capture": 164, "model": 2380, "gate": 0.05, "total": 2551 }
}
```

- `frame_url` is the frame this decision is about, relative to the brain; `null` when the camera didn't answer.
- `looked` is true when the vision model judged this frame. Most frames are not looked at, and `skipped` says why: `no_change` (the scene is the same as the last one judged), `model_spacing` (it changed, but the last model call was under 6 s ago), `question_in_progress`, or `error` (`reason` has the error). `skipped` is `null` when `looked` is true.
- `change` is how different the frame is from the last one judged, against the threshold that triggers a look; `null` on the first frame of a session.
- `saw` is the model's description, `why` its reason for the urgency, `model` the model that answered (the backup's name if the watch model failed). `candidate` is the line the model had ready, kept here even when Iris stayed silent, so the dashboard can show what was held back. The top-level `text` and `speak` stay empty unless the line was actually shown or spoken.
- `urgency` is 0 to 10, or `null` when the frame wasn't looked at or the reply couldn't be read. `proposed` is the level that urgency asks for on its own: `speak` at `speak_at`, `display` at `display_at`, otherwise `silent`.
- `rules` are the gate's four rules in the order it checks them. `outcome` is `passed`, `blocked`, `softened` (only `rate_limit`: spoken too recently, so the line is shown instead) or `not_checked` (urgency was under `display_at`, so there was nothing to hold back). Every rule is worked out even after one blocks; `blocked_by` names the first that blocked, which is the one that decided, or is `null`. `repeat` also carries its `similarity` and `threshold`. `quiet_after_answer` covers the 10 s after a question is asked or answered, or the wake word is heard. `detail` is a plain phrase to show as it is. `rules` is empty when the frame wasn't looked at.
- `verdict` is the same as the decision's `level`.
- `latency_ms`: `capture` is the camera request, `model` the vision call, `gate` the rules, `total` the whole tick. `model` and `gate` are missing when the frame wasn't looked at.

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

Every moment belongs to a `session_id`, one per judge, and every caller passes it. Neon Auth is enabled on the project (`auth: true` in `neon/neon.ts`) but not used yet, and no page signs judges in. The memory function is ready for it. A request carrying a signed-in judge's Neon Auth token as `Authorization: Bearer <token>` would be scoped to that judge's user id, and a tampered or expired token would get a 401. Requests without a token, which is every request today, use the `session_id` they pass.

### The brain's side

The brain doesn't call the routes below directly. It uses `brain/memory`.

```python
from memory import save_moment, router    # the brain runs from brain/

app.include_router(router)                # serves POST /api/memory/search on the brain

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

It's one embedding call and one database query, so it answers inside the brain's 2 s budget, usually in a few hundred milliseconds, and gives up by about 1.5 s if the embedding service hangs. The object comes from the question's words, with no model call. It never returns an error status, and an unexpected response from memory comes back as the not-found shape. When nothing matches or memory is down, `found` is `false` and the other fields are `null`. The match is the most recent moment showing the object, since "where is it" means where it was last seen.

### Memory function routes

Under `${MEMORY_URL}/api/memory`. Reads are scoped to one judge's session, from a verified Neon Auth token if one is sent, otherwise from `session_id`. Saving frames needs `INGEST_TOKEN`, which never goes to the browser.

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /ingest` | brain, through `save_moment` | Saves a frame. Raw JPEG body. Headers `Authorization: Bearer <INGEST_TOKEN>`, `X-Session-Id`, `X-Captured-At` (ISO 8601), `X-Description` (URI-encoded). Returns `{ "saved": true, "id": 42, "description": "...", "ms": 310 }`, or `saved: false` and `id: null` for a near-duplicate. |
| `POST /search` | brain router, garden | `{ "session_id", "question", "target"? }`. Without `target`, the object is picked out of the question's words, with no model call. Returns `{ "search_id", "target", "moment", "top", "ms" }`, where `moment` is the match or `null` and `top` is the five closest by meaning. |
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

`MEMORY_URL`, `INGEST_TOKEN`, `OPENAI_API_KEY`, `DESCRIBE_URL`, `VISION_MODEL`, `DEDUPE_THRESHOLD`, `SEARCH_MIN_SIMILARITY`, `WEB_ORIGIN`, plus `VITE_MEMORY_URL` and `TUNNEL_HOST` for the web app. All are in the root `.env.example`.

## Web app (owner: Ali, `/garden` owned by Darren)

- Routes: `/phone`, `/dashboard`, `/garden`.
- `/dashboard` only watches. It reads `GET /api/trace`, the WebSocket and the frame routes, and never calls `POST` or `DELETE /api/session`: opening or reloading it changes nothing. It shows whichever session the brain is running. Sessions are started from `/phone`.
- Vite proxies `/api` (including the WebSocket) to the FastAPI server.
- One Cloudflare tunnel serves the app over https; add its host to `server.allowedHosts` in the Vite config.

## Open decisions (settle by 2:30pm)

- [x] Darren: images stored in Neon, or on disk and served by FastAPI.
- [x] Ali and Matthew: voice path. The phone records audio, sends it to `/api/transcribe` on the brain, which calls ElevenLabs so keys stay on the server (draft; Ali may change it).
- [ ] Darren: `save_moment` is called with `captured_at` as a timezone-aware UTC `datetime`; sync or async both work. Recall questions call `POST /api/memory/search`.
