"""
Designs the Iris voice with ElevenLabs Voice Design and saves the candidates to listen to.

    brain/.venv/bin/python scripts/design_voice.py previews --out ~/Documents/iris-references/voice
    brain/.venv/bin/python scripts/design_voice.py create <generated_voice_id>

`previews` writes one MP3 per candidate and a candidates.json with each one's id, length and how
well ElevenLabs' own speech-to-text reads it back. `create` saves one candidate to the account as
"Iris" and prints the voice id to put in ELEVENLABS_VOICE_ID. Needs ELEVENLABS_API_KEY in .env.
"""
import argparse
import base64
import difflib
import json
import os
import re
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
BASE = "https://api.elevenlabs.io/v1"
NAME = "Iris"
# What Iris should sound like: a quiet voice at your side, not an announcer.
DESCRIPTION = (
    "A calm, warm woman in her early thirties with a soft, low-mid voice and a neutral North American accent. "
    "She speaks gently and close to the microphone, like a thoughtful friend talking quietly at your side. "
    "Even, unhurried but not slow, clear and brief. Never excited, never salesy. Clean studio recording, no reverb."
)
# The kind of lines Iris actually says.
SAMPLE = (
    "Line two says seven times eight is fifty-four. It's fifty-six. "
    "That bar has about twelve grams of protein. "
    "Your phone is on the table by the door. "
    "No umbrella needed today, there's only a small chance of rain."
)


def words(text):
    return re.findall(r"[a-z']+", text.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["previews", "create"])
    ap.add_argument("generated_voice_id", nargs="?")
    ap.add_argument("--out", default="voice-previews")
    ap.add_argument("--models", default="eleven_ttv_v3,eleven_multilingual_ttv_v2")
    args = ap.parse_args()
    http = httpx.Client(headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]}, timeout=120)

    if args.action == "create":
        r = http.post(f"{BASE}/text-to-voice", json={"voice_name": NAME, "voice_description": DESCRIPTION,
                                                      "generated_voice_id": args.generated_voice_id})
        r.raise_for_status()
        print("ELEVENLABS_VOICE_ID=" + r.json()["voice_id"])
        return

    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    found = []
    for model in args.models.split(","):
        r = http.post(f"{BASE}/text-to-voice/design", json={"voice_description": DESCRIPTION, "text": SAMPLE, "model_id": model})
        if r.status_code != 200:
            print(f"{model}: HTTP {r.status_code} {r.text[:200]}")
            continue
        for n, p in enumerate(r.json()["previews"], 1):
            audio = base64.b64decode(p["audio_base_64"])
            name = f"iris-{model.replace('eleven_', '').replace('_ttv', '')}-{n}.mp3"
            (out / name).write_bytes(audio)
            heard = http.post(f"{BASE}/speech-to-text", data={"model_id": "scribe_v2"}, files={"file": (name, audio, "audio/mpeg")})
            text = heard.json().get("text", "") if heard.status_code == 200 else ""
            found.append({
                "file": name, "model": model, "generated_voice_id": p["generated_voice_id"],
                "seconds": round(p.get("duration_secs") or 0, 2),
                "words_per_second": round(len(words(SAMPLE)) / p["duration_secs"], 2) if p.get("duration_secs") else None,
                "read_back": round(difflib.SequenceMatcher(None, words(SAMPLE), words(text)).ratio(), 3),
            })
            print(found[-1])
    (out / "candidates.json").write_text(json.dumps({"description": DESCRIPTION, "sample": SAMPLE, "candidates": found}, indent=1))


if __name__ == "__main__":
    main()
