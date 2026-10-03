# Iris contracts

Everyone builds against these shapes. The owner may change their contract: update this file in a small pull request, tag the people who depend on it, and post in the team chat.

## Hardware (owner: Shrirang)

| Call | Result |
| --- | --- |
| `GET http://172.20.10.4/capture` | One JPEG from the glasses camera (about 0.16 s). |
| `GET http://172.20.10.6/show?text=<url-encoded text>` | Shows the text on the glasses display. Under 40 characters stays in the large font. Returns `ok`. |
| `GET http://172.20.10.6/clear` | Clears the display. Returns `ok`. |

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
  "focus_box": [0.12, 0.31, 0.55, 0.09] }

{ "type": "answer_delta", "session_id": "judge-01", "at": "...", "ask_id": "a_0007", "text": "12g prot" }

{ "type": "answer", "session_id": "judge-01", "at": "...", "ask_id": "a_0007",
  "question": "how much protein is in this?", "display": "12g protein per bar",
  "speak": "That bar has about 12 grams of protein.", "latency_ms": 1840, "first_word_ms": 620 }

{ "type": "memory_saved", "session_id": "judge-01", "at": "...",
  "moment_id": "m_0192", "description": "a protein bar on a wooden table" }

{ "type": "metrics", "session_id": "judge-01", "at": "...",
  "answer_latency_ms_p50": 1700, "answer_latency_ms_p95": 2400, "first_word_ms_p50": 650,
  "gate_precision": 0.9, "gate_precision_basis": "measured on 10 test photos",
  "model_calls_today": 112, "model_usd_today": 0.41,
  "ask_model": "xai:grok-4.20-non-reasoning", "watch_model": "xai:grok-4.20-reasoning" }
```

- Every gate call emits a `decision`, including silent ones, so the dashboard can show what Iris chose not to say.
- `focus_box` is `[x, y, w, h]` as fractions (0 to 1) of the image, origin top left: where Iris is looking. It is on every decision. On "no change" frames it repeats the last box; it is `null` on errors or before the first look.
- `speak` on a decision is the sentence to say; empty unless `level` is `speak`. `text` is the display line.
- `answer_delta.text` is new text only: append it. Deltas for one question share an `ask_id`, and the final `answer` carries the same `ask_id`. The text is two lines: the display line, then the spoken answer.
- `model_usd_today` is model spend reported by the providers (Grok credits included); `ask_model` / `watch_model` are `provider:model[@effort]`.
- `gate_precision` comes from the bake-off, not live use. Show it with `gate_precision_basis`, e.g. "Gate precision 0.9, measured on test photos". It is `null` until the bake-off has run.
- **Phone audio:** play speech only from WebSocket events. A `decision` with `level: "speak"` means fetch `/api/tts?text=<speak>`; an `answer` with non-empty `speak` means the same. Never play from the `/api/ask` HTTP response, or it plays twice. Unlock audio with a tap at session start, because mobile browsers block autoplay.

## Memory (owner: Darren)

### Write (called by the brain for each frame)

`save_moment(session_id, captured_at, image_jpeg_bytes, description) -> moment_id`

### `POST /api/memory/search`

Request:
```json
{ "session_id": "judge-01", "query": "where did I leave my phone?" }
```

Response:
```json
{
  "moment_id": "m_0142",
  "image_url": "/api/memory/image/m_0142",
  "depth_url": "/api/memory/depth/m_0142",
  "description": "a phone face down next to a laptop",
  "captured_at": "2026-10-03T19:00:40Z",
  "score": 0.83
}
```

### Neon table `moments` (starting point)

```sql
create extension if not exists vector;

create table moments (
  id           text primary key,
  session_id   text not null,
  captured_at  timestamptz not null,
  image_url    text,            -- or image bytes; Darren decides by 2:30pm
  description  text not null,
  embedding    vector           -- set the dimension to match the embedding model
);
```

## Web app (owner: Ali, `/garden` owned by Darren)

- Routes: `/phone`, `/dashboard`, `/garden`.
- Vite proxies `/api` (including the WebSocket) to the FastAPI server.
- One Cloudflare tunnel serves the app over https; add its host to `server.allowedHosts` in the Vite config.

## Open decisions (settle by 2:30pm)

- [ ] Darren: images stored in Neon, or on disk and served by FastAPI.
- [x] Ali and Matthew: voice path. The phone records audio, sends it to `/api/transcribe` on the brain, which calls ElevenLabs so keys stay on the server (draft; Ali may change it).
- [ ] Darren: `save_moment` is called with `captured_at` as a timezone-aware UTC `datetime`; sync or async both work. Recall questions call `POST /api/memory/search`.
