# Iris contracts

Everyone builds against these shapes. The owner may change their contract: update this file in a small pull request, tag the people who depend on it, and post in the team chat.

## Hardware (owner: Shrirang)

| Call | Result |
| --- | --- |
| `GET http://172.20.10.4/capture` | One JPEG from the glasses camera (about 0.2 s at 800x600). |
| `GET http://172.20.10.4/control?var=<name>&val=<n>` | Changes one camera setting until the camera restarts. The brain sends `framesize` 11 (800x600), `vflip` 0 and `hmirror` 1 at startup and at every session start, from `CAMERA_FRAMESIZE`, `CAMERA_VFLIP` and `CAMERA_HMIRROR`. |
| `GET http://172.20.10.4/status` | The camera's current settings as JSON. With the firmware in `firmware/glasses_cam/` it also has `temp_c`, the chip's temperature in Celsius. |
| `GET http://172.20.10.4:81/stream` | Live video as MJPEG (`multipart/x-mixed-replace`, each part a JPEG with its `Content-Length`). **One viewer at a time, and that viewer is the brain.** Everything else watches through the brain's `/api/stream`. |
| `GET http://172.20.10.6/show?text=<url-encoded text>` | Shows the text on the glasses display, centred, in a bold font at the largest size that fits: one short word very large ("12g"), two words large ("Stay in"), up to about 18 characters on two lines ("Line 2: 7x8 is 56") at the smallest comfortable size. Longer text still shows, but smaller, so keep to 18 characters; the brain shortens its own lines at a word (`brain/hud_text.py` holds the rule). Returns `ok`. The text stays until it is replaced or cleared. |
| `GET http://172.20.10.6/show?text=...&eye=answer&hold=<ms>` | The eye blinks, the text shows for `hold` ms (default 4000), then the eye rests open for about 3 s and closes. The eye opens first if it is shut. |
| `GET http://172.20.10.6/show?text=...&eye=nudge&hold=<ms>` | The eye flicks open and blinks, the text shows for `hold` ms (default 5000), then the display goes dark. |
| `GET http://172.20.10.6/eye?anim=<name>` | Plays an eye animation at about 30 frames a second: `open`, `listening`, `thinking`, `speaking`, `idle`, `blink`, `close`. The eye opens first if it is shut. `listening`, `thinking` and `speaking` loop until the next call, and close by themselves after 15 s (`&for=<ms>` changes that). `idle` holds the eye open with a blink every 3 to 5 s. Returns `ok`, or 400 for an unknown name. |
| `GET http://172.20.10.6/clear` | Stops any animation and clears the display. Returns `ok`. |
| `GET http://172.20.10.6/status` | JSON: `state`, `eye_open`, `fps`, `draw_ms`, `cmd_to_first_frame_ms`, and where things are drawn: `offset` `{ "x": 0, "y": 0 }`, `area` `{ "w": 116, "h": 52 }` (the space text is fitted into) and `flip` `{ "h": 0, "v": 1 }`. The brain reads `area` at startup and at every session start. |
| `GET http://172.20.10.6/test` | Draws a test pattern: a border at the screen's edge, a crosshair at its middle, `TL` `TR` `BL` `BR` in the corners (none of these move), and a dashed box around the area text and the eye are drawn in. Look through the lens to see which part of the screen is visible. `/test?grid=1` draws a grid of labels instead, `A1` to `C7`, 16 pixels apart (label `B3` is centred at x 48, y 32): the labels the wearer can read say how much of the screen the lens shows. Returns `ok`. |
| `GET http://172.20.10.6/calibrate?x=<px>&y=<px>` | Moves all text and the eye: `x` right (up to ±40), `y` down (up to ±20), as the wearer reads. Saved on the board, so it survives restarts and needs no re-flash. Optional `w` (48 to 128) and `h` (24 to 64) resize the area text is fitted into (116x52 unless changed). Optional `flip_h` and `flip_v` (0 or 1) mirror the picture left-right and top-bottom for the optics; changing both turns it 180 degrees. Draws the test pattern and returns `{ "offset": {...}, "area": {...}, "flip": {...} }`; without arguments it changes nothing. |
| Brightness | The display is at full brightness whenever anything is on it. The eye no longer fades in or out. `/calibrate?boost=0` or `1` (saved, 1 unless changed) drives the panel at 9 V instead of 7.5 V for more brightness; `/status` reports `boost`. |

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

`level` is one of `silent`, `display`, `speak`. `speak` may be an empty string. Never returns a 500: on failure `display` is "Say again".

Two optional fields carry what the phone measured before it sent the question, in ms: `wake_ms` (from hearing "Iris") and `listen_ms` (from the mic opening). They only feed the dashboard's timings.

The question uses the newest camera frame the brain holds when it is under 1 s old (from the watch loop or the wake word); otherwise it takes a new one.

### `POST /api/session`, `DELETE /api/session`

`POST { "session_id": "judge-01" }` makes that session active and starts the watch loop; returns `{ "session_id", "earlier" }` (how many descriptions were carried over from the previous session). `DELETE` stops the loop. Cooldowns reset per session, so every judge gets the nudge.

### `POST /api/wake`

`POST { "session_id": "judge-01" }` when the phone hears the wake word "Iris". The eye on the glasses opens and listens, and the watch loop holds its nudges for 10 s. Returns `{ "eye": true, "display_ms": 48 }`: whether the display answered, and how long the brain waited for it (at most 1 s). The phone does not need to wait for the reply.

The brain also gets ready for the question: for the next 8 s, or until the question arrives, it keeps a camera frame under a second old and its model and voice connections open. Send `"eye": false` when the mic opens without the wake word: the brain gets ready the same way and leaves the eye alone.

During `/api/ask` the brain drives the eye itself: it thinks while the model works, then blinks and shows the answer. A nudge from the watch loop arrives as a quick blink, then the text.

### `GET /api/live?q=...`

The live data a question would get, for testing and the dashboard: `{ "topics": ["sky"], "note": "Tonight in Ann Arbor: sunset 7:12 PM, ...", "sources": ["Open-Meteo"] }`. Topics: `weather`, `sky`, `launch`, `iss`. Questions on these topics are answered from this data (without the photo unless they say "this" or "that").

### `GET /api/scene`

What the glasses have just seen, for the Act agent: `{ "session_id": "judge-01" | null, "recently_seen": ["19:02 a protein bar on a wooden table"], "already_said": [] }`. `session_id` is null when no session is running.

### `GET /api/stream`

What the glasses see, as live video: MJPEG (`multipart/x-mixed-replace; boundary=frame`), which an `<img>` plays as it is. The brain reads the camera's stream as its only viewer, keeps the newest frame for the watch loop and for questions, and passes the frames on here, so any number of dashboards can watch. A slow viewer skips frames. If the camera's stream stops, the brain reconnects by itself and meanwhile takes single frames from `/capture` when it needs one; this route then keeps working at that pace (one frame every 2 s while a session runs).

Every frame the brain hands out, here and everywhere else, has been turned upright by `CAMERA_ROTATE` (0, 90, 180 or 270 degrees clockwise, in `.env`).

### `GET /api/frame`, `GET /api/frame/{frame_id}`

Every frame the brain hands out, here and to the model, memory and the dashboard, has been turned upright by `CAMERA_ROTATE` (0, 90, 180 or 270 degrees clockwise, in `.env`), for a camera mounted on its side.

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

Request: `{ "text": "Stay in" }`. Puts the text on the glasses display and returns `{ "text": "Stay in", "shown": true }`. `text` is the line as shown: one too long to read comfortably (over about 18 characters) is shortened at a word. `shown` is false when the text is empty or the display doesn't answer.

### `GET /api/tts?text=...`

Streams `audio/mpeg` (ElevenLabs). Returns `204` if speech is unavailable; just show the text.

### `GET /api/tts/{speech_id}`

The audio for one `speech` event (its `audio_url`). The brain starts fetching it the moment it emits the event, so this plays from the start whether the audio has finished arriving or not. `204` when there is no audio; just show the text. The brain keeps the newest 20.

### `POST /api/timing`

`POST { "session_id": "judge-01", "ask_id": "a_0007", "first_audio_ms": 1420 }` when the answer's voice starts playing on the phone: ms on the phone's clock since it sent the question. Returns `{ "ok": true }`, or `false` for an unknown question or a second report. The phone does not need to wait for the reply.

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
  "context": [],
  "trace": { "mode": "ask", "frame": { "source": "recent", "age_ms": 420 },
             "latency_ms": { "wake": 2140, "listen": 3050, "context": 4, "first_word": 620, "display": 910, "speech": 1180, "total": 1840 } } }

{ "type": "speech", "session_id": "judge-01", "at": "...", "ask_id": "a_0007", "seq": 0,
  "text": "That bar has about 12 grams of protein.", "audio_url": "/api/tts/s_0012" }

{ "type": "answer_timing", "session_id": "judge-01", "at": "...", "ask_id": "a_0007",
  "latency_ms": { "wake": 2140, "listen": 3050, "context": 4, "first_word": 620, "display": 910, "speech": 1180, "total": 1840, "first_audio": 1420 } }

{ "type": "memory_saved", "session_id": "judge-01", "at": "...",
  "moment_id": "m_0192", "description": "a protein bar on a wooden table" }

{ "type": "metrics", "session_id": "judge-01", "at": "...",
  "answer_latency_ms_p50": 1700, "answer_latency_ms_p95": 2400, "first_word_ms_p50": 650, "first_audio_ms_p50": 1400,
  "gate_precision": 0.9, "gate_accuracy": 0.9, "gate_precision_basis": "measured on 10 test photos",
  "moments_seen": 412, "moments_silent": 404, "moments_shown": 5, "moments_spoken": 3,
  "model_calls_today": 112, "model_usd_today": 0.41,
  "ask_model": "xai:grok-4.20-non-reasoning", "watch_model": "xai:grok-4.20-reasoning",
  "camera_source": "stream", "camera_fps": 11.5 }
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
- **Phone audio:** play speech only from WebSocket events. A `decision` with `level: "speak"` means fetch `/api/tts?text=<speak>`. An answer's voice arrives as `speech` events: play each one's `audio_url`, in `seq` order, and then do not also speak the `answer` that follows with the same `ask_id`. An `answer` with non-empty `speak` and no `speech` events before it (a brain with early speech turned off) means fetch `/api/tts?text=<speak>` as before. Never play from the `/api/ask` HTTP response, or it plays twice. Unlock audio with a tap at session start, because mobile browsers block autoplay.
- `speech` is one part of an answer's spoken line, sent as soon as the words exist: the first sentence while the rest is still being written, then the remainder (`seq` 0, then 1). The parts joined with a space are the `answer`'s `speak`. The brain is already fetching the audio when the event goes out.
- `answer.trace` is where the question's time went. `latency_ms` is in ms from the question reaching the brain: `context` (frame, memory and live data in hand), `first_word` (the model's first text), `display` (the glasses confirmed the line), `speech` (the first audio bytes reached the brain), `total` (the answer complete). `wake` and `listen` are the phone's `wake_ms` and `listen_ms`. `first_audio` is the phone's report to `/api/timing`. A step is missing when it didn't happen (no display, no voice). `frame` is the photo the answer used: `source` is `recent` (already in hand, `age_ms` old) or `fresh` (taken for this question); `null` when the answer used no photo. `mode` is `ask`, `identify`, `read`, `recall` or `live`; `mode_by` is `rules`, or `jev` when the brain runs with `JEV_GATE=1` and Jev picked it (`latency_ms.mode` is then how long that took).
- `answer_timing` carries the whole `latency_ms` again whenever a step finishes after the `answer` went out (usually `display`, `speech` or `first_audio`). Replace the answer's `trace.latency_ms` with it.
- `camera_source` is `stream` while the camera's video stream is delivering and `capture` while the brain is taking single frames instead; `camera_fps` is the stream's frame rate over the last 3 s (0 when it is down).
- `first_audio_ms_p50` is the median of the phones' `first_audio` reports; `null` until one arrives.

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
  "said_before": "",
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
  "latency_ms": { "capture": 164, "model": 2380, "gate": 0.05, "total": 2551 },
  "jev": null,
  "ahead": null
}
```

- `frame_url` is the frame this decision is about, relative to the brain; `null` when the camera didn't answer.
- `looked` is true when the vision model judged this frame. Most frames are not looked at, and `skipped` says why: `no_change` (the scene is the same as the last one judged), `model_spacing` (it changed, but the last model call was under 6 s ago), `question_in_progress`, or `error` (`reason` has the error). `skipped` is `null` when `looked` is true.
- `change` is how different the frame is from the last one judged, against the threshold that triggers a look; `null` on the first frame of a session.
- `saw` is the model's description, `why` its reason for the urgency, `model` the model that answered: the watch model, or `WATCH_LATE_MODEL` when the watch model was slow to start and the second model answered first, or the backup if the watch model failed. `candidate` is the line the model had ready, kept here even when Iris stayed silent, so the dashboard can show what was held back. The top-level `text` and `speak` stay empty unless the line was actually shown or spoken.
- `said_before` is for the silence the model chooses itself. The watch prompt lists what the wearer was already told, and the model keeps its urgency low instead of repeating it, so the gate's rules never see the moment. When that is why it stayed quiet, `said_before` is the earlier line (the session's own wording when the model's copy matches it); otherwise it is empty. It is only set when urgency is under `display_at` and the session has said something.
- `urgency` is 0 to 10, or `null` when the frame wasn't looked at or the reply couldn't be read. `proposed` is the level that urgency asks for on its own: `speak` at `speak_at`, `display` at `display_at`, otherwise `silent`.
- `rules` are the gate's four rules in the order it checks them. `outcome` is `passed`, `blocked`, `softened` (only `rate_limit`: spoken too recently, so the line is shown instead) or `not_checked` (urgency was under `display_at`, so there was nothing to hold back). Every rule is worked out even after one blocks; `blocked_by` names the first that blocked, which is the one that decided, or is `null`. `repeat` also carries its `similarity` and `threshold`. `quiet_after_answer` covers the 10 s after a question is asked or answered, or the wake word is heard. `detail` is a plain phrase to show as it is. `rules` is empty when the frame wasn't looked at.
- `verdict` is the same as the decision's `level`.
- `latency_ms`: `capture` is the camera request, `model` the vision call, `gate` the rules, `total` the whole tick. `model` and `gate` are missing when the frame wasn't looked at.
- `jev` is `null` unless the brain runs with `JEV_GATE=1` (off by default) and Jev answered in time for this frame. Then it is `{ "probability": 0.88, "model": "typesafe-ai/jev", "ms": 210, "watch_urgency": 8 }`: Jev's chance that the moment is worth an interruption, which replaced the vision model's own urgency (`watch_urgency`) before the rules ran. `urgency` is then that probability times ten, rounded, and `latency_ms.jev` is the call. Jev is only asked when the vision model has a line ready.
- `ahead` is `null` except when Iris is thinking ahead: the scene is a doorway, a corridor or the outdoors, and something the wearer carries was last seen resting on a surface and is not in view. Then it is `{ "item": "phone", "place": "table", "seen": "A phone on a wooden table.", "at": "19:02" }` (plus `moment_id` when memory supplied the sighting), and the decision's line is about that thing: `text` "Phone's on table", `speak` "Your phone is still on the table.", urgency 8, topic `left-behind-phone`. The gate's rules still apply, so it is said once. It is off unless the brain runs with `THINK_AHEAD=1`.

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

Every moment belongs to a `session_id`, one per judge, and every caller passes it.

Sign-in is off by default, so the demo has no login step. It is switched on with `VITE_JUDGE_SIGN_IN=1` in the root `.env` (restart the web server), or for one phone by opening `/phone?signin=1` once (`?signin=0` switches it off). While it is off the app makes no sign-in request and sends no token.

**Signed in.** With sign-in on, a judge can sign in on the phone page with their name (Settings, "Your name"). That makes them an account in Neon Auth, and the account's id becomes their `session_id`: the brain saves their moments under it and their garden shows only those. The garden's requests for that session carry the judge's Neon Auth token as `Authorization: Bearer <token>`. Memory verifies it and answers for that judge whatever `session_id` the request names; a tampered or expired token gets a 401, and the garden then repeats the request without it.

**Not signed in.** Requests without a token use the `session_id` they pass, as before. This is also the fallback: if sign-in is on but isn't configured, is unreachable, or fails, the phone page offers no sign-in and keeps its no-login session (`judge-01` unless changed in Settings).

The web server passes `/auth/*` on to Neon Auth (`NEON_AUTH_BASE_URL` in the root `.env`), so sign-in is same-origin for the browser. The brain is not involved: to it, a signed-in judge's `session_id` is a session id like any other.

Sign-in gives each judge their own memory; it does not lock it. Photos load by URL with the `session_id` in it, so anyone holding a judge's id (a random UUID) can still read that session.

### The brain's side

The brain doesn't call the routes below directly. It uses `brain/memory`.

```python
from memory import save_moment, router    # the brain runs from brain/

app.include_router(router)                # serves POST /api/memory/search on the brain

moment_id = save_moment(session_id, captured_at, image_jpeg_bytes, description)
```

`save_moment(session_id, captured_at, image_jpeg_bytes, description) -> int | None` returns the new moment's id, or `None` when the frame was skipped as a near-duplicate of the last one or memory was unreachable. It never raises and gives up after 8 s. `captured_at` can be a datetime, a Unix time, or an ISO string. Descriptions should name visible objects plainly first ("phone, keys, laptop"), then one sentence about the scene. For async code, `save_moment_async` takes the same arguments.

A frame is a duplicate when it looks like the session's last saved moment and reads like it. `save_moment` sends a 64-bit difference hash of the photo, and memory compares it with the last moment's: the same picture (6 bits or fewer apart) with similar words (description similarity above 0.80) is skipped, and so is a slightly moved view (14 bits or fewer) with near-identical words (above `DEDUPE_THRESHOLD`). A different scene described the same way is kept, and so is a question asked about the scene just saved. When no hash is sent, the descriptions alone decide, as before.

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
| `POST /ingest` | brain, through `save_moment` | Saves a frame. Raw JPEG body. Headers `Authorization: Bearer <INGEST_TOKEN>`, `X-Session-Id`, `X-Captured-At` (ISO 8601), `X-Description` (URI-encoded), and `X-Image-Hash` (16 hex characters; `save_moment` adds it). Returns `{ "saved": true, "id": 42, "skipped": null, "description": "...", "ms": 310 }`. For a duplicate of the session's last moment, `saved` is false, `id` is null and `skipped` says why: `same_image`, `same_scene` or `same_description`. |
| `POST /search` | brain router, garden | `{ "session_id", "question", "target"?, "quiet"? }`. Without `target`, the object is picked out of the question's words, with no model call. With `"quiet": true` the search is not logged, so the garden does not follow it and `search_id` is `null`; the brain uses it when it looks something up for itself. Returns `{ "search_id", "target", "moment", "top", "ms" }`, where `moment` is the match or `null` and `top` is the five closest by meaning. |
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
