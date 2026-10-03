"""ElevenLabs: streamed text-to-speech out, speech-to-text in. Keys stay on the server."""
import logging
import os

import httpx

log = logging.getLogger("iris.voice")
BASE = "https://api.elevenlabs.io/v1"
VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID") or "21m00Tcm4TlvDq8ikWAM"  # premade "Rachel"


def _key():
    return os.getenv("ELEVENLABS_API_KEY", "")


async def open_tts(http, text):
    """Start a streamed TTS response, or None if it can't start (caller returns 204)."""
    if not _key() or not text.strip():
        return None
    req = http.build_request(
        "POST", f"{BASE}/text-to-speech/{VOICE_ID}/stream",
        headers={"xi-api-key": _key()},
        json={"text": text[:500], "model_id": "eleven_flash_v2_5"},
        timeout=httpx.Timeout(5, connect=2),
    )
    try:
        r = await http.send(req, stream=True)
    except httpx.HTTPError as e:
        log.warning("tts failed: %s", e)
        return None
    if r.status_code != 200:
        log.warning("tts HTTP %s: %s", r.status_code, (await r.aread())[:200])
        await r.aclose()
        return None
    return r


async def relay(r):
    try:
        async for chunk in r.aiter_bytes():
            yield chunk
    finally:
        await r.aclose()


async def transcribe(http, audio, filename, content_type):
    """Draft for the phone: one recorded clip -> text. Raises on failure."""
    r = await http.post(
        f"{BASE}/speech-to-text",
        headers={"xi-api-key": _key()},
        data={"model_id": "scribe_v2"},
        files={"file": (filename or "clip.webm", audio, content_type or "audio/webm")},
        timeout=8,
    )
    r.raise_for_status()
    return (r.json().get("text") or "").strip()
