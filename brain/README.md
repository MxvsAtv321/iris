# brain (owner: Matthew)
FastAPI server: vision model, gate, /api/ask, /api/ws, voice. See ../docs/contracts.md.

```bash
pip install -r requirements.txt
python gate.py && python prompts.py && python llm.py   # self-checks, no network
uvicorn main:app --port 8000                            # run from this folder
```

Start a session to start the watch loop: `POST /api/session {"session_id": "judge-01"}`.

| File | What |
| --- | --- |
| `main.py` | Loop, routes, WebSocket events, sessions (`state.json`) |
| `gate.py` | Silent / display / speak rules, repeat check, focus box |
| `prompts.py` | Watch prompt, question modes (ask, identify, read, recall) |
| `llm.py` | Providers, hedged streaming, free-tier budget |
| `voice.py` | ElevenLabs TTS and speech-to-text |
| `bakeoff.py` | Model comparison on `bakeoff/photos` + `bakeoff/labels.csv` |

Calibration knobs: thresholds and cooldowns at the top of `gate.py`; `CHANGE_THRESHOLD`, `LOOP_GAP_S` in `main.py`.
