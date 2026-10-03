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

`level` is one of `silent`, `display`, `speak`. `speak` may be an empty string.

### WebSocket `/api/ws`

One JSON message per event. Every message has `type`, `session_id` and `at` (ISO 8601 timestamp).

```json
{ "type": "decision", "session_id": "judge-01", "at": "2026-10-03T19:02:11Z",
  "level": "silent", "text": "", "reason": "nothing new in view", "frame_id": "f_0192" }

{ "type": "answer", "session_id": "judge-01", "at": "...",
  "question": "how much protein is in this?", "display": "12g protein per bar",
  "speak": "That bar has about 12 grams of protein.", "latency_ms": 1840 }

{ "type": "memory_saved", "session_id": "judge-01", "at": "...",
  "moment_id": "m_0192", "description": "a protein bar on a wooden table" }

{ "type": "metrics", "session_id": "judge-01", "at": "...",
  "answer_latency_ms_p50": 1700, "gate_precision": 0.9 }
```

Every gate call emits a `decision`, including silent ones, so the dashboard can show what Iris chose not to say.

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
- [ ] Ali and Matthew: voice path. Proposed: the phone records audio, sends it to `/api/transcribe` on the brain, which calls ElevenLabs so keys stay on the server.
