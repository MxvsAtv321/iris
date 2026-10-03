# Iris

Iris is a clip-on that turns any pair of glasses into glasses that think ahead. A camera on the glasses sees what the wearer sees; a brain on the laptop decides whether something is worth interrupting them for, and either stays silent, shows a short line on a tiny display in their view, or speaks in their ear. Everything it sees is remembered, and the wearer can step back into any moment in VR.

Built at MHacks 2026 (24 hours, Oct 3 to Oct 4). Team: Shrirang (hardware, integration, design direction, final review), Matthew (brain), Darren (memory and VR), Ali (web app and story).

## The three stages, in priority order

1. **See:** camera, gate (silent / display / speak), voice questions. Must work first.
2. **Remember:** every frame saved with a description to Neon; search; the moment opens in 3D in the memory garden.
3. **Act (stretch):** a Fetch.ai agent acts on what the wearer sees.

## Architecture

- `firmware/`: ESP32 sketches. The camera board serves photos; the display board shows text it receives over WiFi.
- `brain/`: one Python FastAPI server. Vision model calls, the gate, `/api/ask`, the `/api/ws` WebSocket, ElevenLabs voice.
- `brain/memory/`: Neon storage, embeddings, memory search, depth maps. Routes are mounted in the same FastAPI app.
- `web/`: one Vite + React + TypeScript + Tailwind app with routes `/phone`, `/dashboard` and `/garden` (react-three-fiber, @react-three/xr). Vite proxies `/api` to FastAPI. A Cloudflare tunnel gives the app an https address so the phone can use its mic.

The exact endpoints and data shapes are in `docs/contracts.md`. Read it before writing code that talks to another part.

## Hardware facts

- Camera: `GET http://172.20.10.4/capture` returns one JPEG in about 0.16 s.
- Display: `GET http://172.20.10.6/show?text=...` shows text; `/clear` clears it. Keep text under 40 characters for the large font.
- Always use the IP addresses. The `.local` names add about 5 seconds per request on macOS.
- Everything runs on the `ShriHotspot` network (2.4 GHz). The password is never written in the repo.

## Rules for every session

- Stay inside your own folder unless the change is agreed with its owner.
- Never commit secrets. Keys live in `.env` (gitignored); add new key names to `.env.example`.
- Every network call has a timeout and a fallback. The demo must never crash or hang.
- Latency matters: measure it and keep the question-to-answer time visible.
- Propose a plan before large changes, and keep pull requests small.
- `main` must always run.
