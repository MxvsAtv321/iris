# Iris web · Ali
React + TypeScript + Tailwind. Run from **web**, not the earlier frontend starter.

## Start
```bash
cd ~/iris/web
npm install
npm run dev
```
Open http://localhost:5173/phone or /dashboard. The phone starts the session (default judge-01);
change it to match the brain. Session is a routing identifier, not authentication.
The dashboard only watches: it shows whichever session the brain is running, and opening or reloading it never starts or restarts one.
The phone runs without the brain: turn on **Demo mode** for explicitly scripted examples.
Demo does not contact the backend or represent actual camera observations; precision is never fabricated.
Use /garden only as a reserved integration route for Darren.

## Backend
Vite proxies /api and the /api/ws WebSocket to http://127.0.0.1:8000.
Copy .env.example to .env.local to override IRIS_API_TARGET.
POST /api/ask and WebSocket messages follow ../docs/contracts.md.
Ask requests time out after 25 seconds. WebSocket connections retry with bounded backoff.
The phone's feed is session-filtered and bounded to 200 events in the current tab.
The dashboard (src/dashboard) loads the session so far from GET /api/trace, then follows the WebSocket; frames come from each decision's trace.frame_url.
Gate accuracy and median latency come from backend metrics; absent metrics show a dash.
If median latency is absent, the dashboard displays the most recent answer event's latency.
The phone measures client end-to-end ask latency separately (not microphone transcription or playback).

## HTTPS phone setup
Run a Cloudflare tunnel to http://localhost:5173 using your installed cloudflared:
```bash
cloudflared tunnel --url http://localhost:5173
```
Set IRIS_ALLOWED_HOSTS in .env.local to the **exact hostname** returned by the tunnel (no protocol/path),
then restart Vite. Use comma-separated hostnames if needed. Do not allow all hosts.
Open the HTTPS URL + /phone on the phone. Allow the microphone when asked.
Wake lock is requested while the page is visible and reacquired when you return; the UI reports failure.
A quick tunnel is public: use a temporary judge session and stop the tunnel after the demo.
For a public production deployment, serve the built app with a backend reverse proxy; Vite's dev proxy is not in the build.

## Voice integration status
The shared contract still lists transcription as an open decision; no ElevenLabs route exists in this checkout.
Current fallback: browser SpeechRecognition (where supported) and speechSynthesis.
The browser provider may process audio remotely. Unsupported/denied mic access always has a text fallback.
Tap to begin each question. The optional wake phrase accepts Iris, Irish, Aries, Eyeris, or Iriss at the start.
This is not always-on/background wake-word detection. Listening is bounded to 20 seconds.
Spoken answers have replay and stop controls because some mobile browsers block automatic playback.
Before ElevenLabs integration, agree on /api/transcribe upload field, response JSON, limits, and TTS response format with Matthew.
Keep vendor keys in the backend, never in VITE_ environment variables.

## Verify
```bash
npm run build
npm run lint
npm test
```
Manual: demo on/off, session change, dashboard reload mid-session, ask timeout/error, live WebSocket,
mic denied, unsupported speech, wake word, screen wake lock, and physical-phone audio replay.
Design uses placeholder typography and a muted green accent pending Shrirang's Figma.

Browser checks: run npm run test:e2e. The test runner starts Vite automatically if needed. On a fresh machine, run npx playwright install --with-deps chromium first. Tests use mocked API/WebSocket responses; physical-phone microphone, audio, wake lock, and real glasses integration still need a manual check.

## WebGL iris
The phone visual uses a single WebGL fragment pass with periodic polar noise, violet/indigo fibers, analytic bloom, and a dark pupil. State and audio inputs update without React renders per frame. Listening dilates and ripples; thinking contracts and spirals; speaking expands with the envelope.
Full quality caps the backing canvas at 512 pixels and DPR at 1.5. Two consecutive 1.2-second windows below 30fps switch to two noise octaves and a 280-pixel cap. Continued slow rendering switches to CSS. Hidden tabs stop drawing, reduced-motion users get a stationary shader, and WebGL loss has a CSS fallback with recovery.
AudioLevel measures microphone RMS locally only while listening, stops tracks afterward, and safely releases late permission results. attachVoice(audioElement) accepts actual TTS media for waveform analysis when available. The current browser SpeechSynthesis fallback exposes no PCM: it drives an approximate word-boundary envelope, not measured speech volume. Voice services that omit boundary events only get the initial pulse and speaking state.
The 60fps target is not a measured iPhone guarantee. Verify on physical Safari with microphone permission, voice playback, thermal load, background/foreground transitions, and reduced motion. Browser tests verify shader compilation, context recovery, degraded quality, and state transitions; unit tests cover the frame budget and microphone cleanup.

## Figma phone design
The phone screen implements node 3:413 (Iris visual assistant) from https://www.figma.com/design/CNuh6kIdUTLzYeQX8W3e1X/Untitled?node-id=3-413. Figma assets are local in public/figma, and Inter fonts are bundled locally. The existing audio-reactive WebGL iris replaces the reference's static artwork, per the shader requirement. Native iPhone bezel/status/home chrome is left to the actual device/browser. The dashboard has no counterpart in this Figma file; it uses the phone page's typeface and colours.
More options opens session, demo, and wake-word controls. Demo mode shows the Figma product/nutrition example with explicit sample labels. Live mode uses actual ask/decision data and leaves unavailable confidence, nutrition, and camera imagery unspecified. Product context expands on tap.

## Merged memory garden
/garden now loads Darren's real viewer lazily. The Garden navigation link carries the active session as ?session=.
Root .env settings are supported alongside web/.env.local; web settings win. Set VITE_MEMORY_URL to the memory service address. The brain proxy remains IRIS_API_TARGET (default http://127.0.0.1:8000).
Tunnel hosts must be listed explicitly through TUNNEL_HOST or IRIS_ALLOWED_HOSTS. Restart Vite after configuration changes.
The combined lint command runs ESLint for the frontend and the garden's existing Oxlint checks. Garden React compiler warnings and large lazy-loaded 3D/depth chunks currently remain.
