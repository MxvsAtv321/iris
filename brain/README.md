# brain (owner: Matthew)
FastAPI server: vision model, gate, /api/ask, /api/ws, voice. See ../docs/contracts.md.

```bash
pip install -r requirements.txt
python gate.py && python prompts.py && python llm.py && python live.py   # self-checks, no network
python bakeoff.py ping                                  # keys + model IDs + latency, one call per model
python live.py fetch "what can I see in space tonight"  # live data APIs, no model call
uvicorn main:app --port 8000                            # run from this folder
```

Start a session to start the watch loop: `POST /api/session {"session_id": "judge-01"}`.

## Models

Grok via the xAI API (`XAI_API_KEY`), with an OpenRouter backup. Questions and the watch loop can use
different models: `PRIMARY_MODEL` answers questions (latency first), `WATCH_MODEL` judges frames
(accuracy first: it has to catch the whiteboard mistake, and a few seconds late is fine).

## Live data

Questions about the weather, tonight's sky, SpaceX launches or the ISS get a note from free, keyless APIs
(`live.py`): Open-Meteo, Launch Library 2 (the old SpaceX API is offline) and wheretheiss.at; the moon phase
is computed. They are answered without the photo (faster) unless they say "this" or "that". Sources are
cached and prefetched at startup and session start, so these questions usually wait on nothing. Location:
`IRIS_LAT` / `IRIS_LON` / `IRIS_PLACE` (Ann Arbor by default). Try `GET /api/live?q=...`.

## Bake-off

On site, on the hotspot:
1. `python bakeoff.py snap <name>.jpg` for each row in `bakeoff/labels.csv` (stage the snack, the whiteboard, etc.).
2. Fill `answer_must_contain` for the snack rows with the protein from its label (e.g. `12g`). The whiteboard row expects `56`, for a planted `7 x 8 = 54`; change it if you plant something else.
3. `python bakeoff.py` and copy the recommended `WATCH_MODEL` / `PRIMARY_MODEL` into `.env`.

| File | What |
| --- | --- |
| `main.py` | Loop, routes, WebSocket events, sessions (`state.json`) |
| `gate.py` | Silent / display / speak rules, repeat check, focus box |
| `prompts.py` | Watch prompt, question modes (ask, identify, read, recall, live) |
| `llm.py` | Providers, hedged streaming, frame downscaling, call and spend counters |
| `live.py` | Weather, tonight's sky, SpaceX launches, ISS: cached, prefetched, for the `live` mode |
| `voice.py` | ElevenLabs TTS and speech-to-text |
| `bakeoff.py` | Model comparison on `bakeoff/photos` + `bakeoff/labels.csv` |

Calibration knobs: thresholds and cooldowns at the top of `gate.py`; `CHANGE_THRESHOLD`, `LOOP_GAP_S` in `main.py`.
