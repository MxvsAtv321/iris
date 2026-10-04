"""ElevenLabs: streamed text-to-speech out, speech-to-text in. Keys stay on the server."""
import asyncio
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


class Speech:
    """One spoken line, fetched from ElevenLabs as soon as the words exist. The audio is kept as it
    arrives, so the phone can read it from the start whether it asks before, during or after the fetch."""

    def __init__(self, text):
        self.text, self.parts, self.done = text, [], False
        self.news = asyncio.Condition()

    async def _tell(self):
        async with self.news:
            self.news.notify_all()

    async def fetch(self, http, on_first=None):
        """Never raises. on_first is called once, when the first audio bytes arrive."""
        r = None
        try:
            r = await open_tts(http, self.text)
            if r is not None:
                async for chunk in r.aiter_bytes():
                    if not self.parts and on_first:
                        on_first()
                    self.parts.append(chunk)
                    await self._tell()
        except Exception as e:  # noqa: BLE001 - the phone shows the text instead
            log.warning("speech fetch failed: %s", e)
        finally:
            if r is not None:
                await r.aclose()
            self.done = True
            await self._tell()

    async def started(self):
        """Wait for the first audio. False when there will be none."""
        async with self.news:
            await self.news.wait_for(lambda: self.parts or self.done)
        return bool(self.parts)

    async def read(self):
        i = 0
        while True:
            async with self.news:
                await self.news.wait_for(lambda: len(self.parts) > i or self.done)
            while i < len(self.parts):
                yield self.parts[i]
                i += 1
            if self.done and i >= len(self.parts):
                return


async def warm(http):
    """Keep a connection to ElevenLabs open, so the first spoken word skips the handshake."""
    if _key():
        try:
            await http.head(BASE + "/voices", timeout=3)
        except Exception as e:  # noqa: BLE001
            log.info("warm elevenlabs: %s", e)


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


if __name__ == "__main__":
    # Self-check, no network: everyone who reads a Speech gets the whole clip, whenever they start.
    class Stream:
        def __init__(self, parts):
            self.parts, self.closed = parts, False

        async def aiter_bytes(self):
            for part in self.parts:
                await asyncio.sleep(0.02)
                yield part

        async def aclose(self):
            self.closed = True

    async def check():
        global open_tts
        real, stream, firsts = open_tts, Stream([b"a", b"b", b"c"]), []

        async def answers(http, text):
            return stream

        async def unavailable(http, text):
            return None

        async def broken(http, text):
            raise RuntimeError("down")

        async def whole(s):
            return b"".join([part async for part in s.read()])

        open_tts = answers
        s = Speech("hello")
        early = asyncio.create_task(whole(s))                       # asked before the audio exists
        fetch = asyncio.create_task(s.fetch(None, on_first=lambda: firsts.append(1)))
        await asyncio.sleep(0.03)
        during = asyncio.create_task(whole(s))                      # asked while it is arriving
        assert await s.started() is True
        await fetch
        assert await early == await during == await whole(s) == b"abc" and firsts == [1] and stream.closed
        for failing in (unavailable, broken):                       # no voice: no audio, and nothing raises
            open_tts = failing
            s = Speech("hello")
            await s.fetch(None)
            assert await s.started() is False and await whole(s) == b""
        open_tts = real

    asyncio.run(check())
    print("voice ok")
