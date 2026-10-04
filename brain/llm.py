"""Model calls. Every provider here speaks the OpenAI chat-completions dialect, so switching
is one line in .env. Models are "provider:model", with an optional "@effort" suffix for
reasoning models, e.g. "xai:grok-4.7@low".

  PRIMARY_MODEL  answers questions (latency first)
  WATCH_MODEL    judges loop frames (accuracy first; defaults to PRIMARY_MODEL)
  BACKUP_MODEL   takes over when either fails or is slow

Run `python llm.py` for the hedging self-check (no network).
"""
import asyncio
import base64
import io
import json
import logging
import os
import re
from datetime import date
from pathlib import Path

import httpx
from dotenv import load_dotenv
from PIL import Image

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
log = logging.getLogger("iris.llm")

PROVIDERS = {
    "xai": ("https://api.x.ai/v1/", "XAI_API_KEY"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/", "GEMINI_API_KEY"),
    "openai": ("https://api.openai.com/v1/", "OPENAI_API_KEY"),
    "anthropic": ("https://api.anthropic.com/v1/", "ANTHROPIC_API_KEY"),   # its OpenAI-compatible endpoint; takes images
    "openrouter": ("https://openrouter.ai/api/v1/", "OPENROUTER_API_KEY"),
    "asi": ("https://api.asi1.ai/v1/", "ASI_API_KEY"),   # Fetch.ai ASI:One: asi1-mini (fastest), asi1, asi1-ultra
}
PRIMARY = os.getenv("PRIMARY_MODEL") or "xai:grok-4.20-non-reasoning"
WATCH = os.getenv("WATCH_MODEL") or PRIMARY
BACKUP = os.getenv("BACKUP_MODEL") or "openrouter:google/gemini-3.5-flash-lite"
HEDGE_S = 2.5        # start the backup if the primary has no first chunk by then
MAX_SIDE = int(os.getenv("IMAGE_MAX_SIDE") or 1280)   # px; bigger frames are downscaled before upload

# httpx closes idle connections after 5 s by default; a question after a pause would pay a fresh TLS handshake.
http = httpx.AsyncClient(limits=httpx.Limits(keepalive_expiry=120))
usage = {"day": "", "calls": 0, "usd": 0.0}   # main.py persists this in state.json


def _roll():
    if usage.get("day") != date.today().isoformat():
        usage.update(day=date.today().isoformat(), calls=0, usd=0.0)


def calls_today():
    _roll()
    return usage["calls"]


def usd_today():
    _roll()
    return round(usage["usd"], 4)


def parse(model):
    """'xai:grok-4.7@low' -> ('xai', 'grok-4.7', 'low')"""
    provider, rest = model.split(":", 1)
    name, _, effort = rest.partition("@")
    return provider, name, effort


def shrink(jpeg, max_side=MAX_SIDE):
    """Frames over max_side are downscaled: less upload time on the hotspot, fewer image tokens."""
    try:
        img = Image.open(io.BytesIO(jpeg))
        if max(img.size) <= max_side:
            return jpeg
        img.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=85)
        return buf.getvalue()
    except Exception:  # noqa: BLE001 - an odd frame is sent as is
        return jpeg


def messages(system, text, jpeg=None):
    """No jpeg means a text-only question."""
    if not jpeg:
        return [{"role": "system", "content": system}, {"role": "user", "content": text}]
    image = "data:image/jpeg;base64," + base64.b64encode(shrink(jpeg)).decode()
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": [{"type": "text", "text": text},
                                     {"type": "image_url", "image_url": {"url": image}}]},
    ]


async def warm():
    """Open (or keep open) a pooled connection to each model host, so no question pays for a handshake.
    Any reply keeps the connection alive, a 4xx included. Never raises."""
    async def touch(base):
        try:
            await http.head(base, timeout=3)
        except Exception as e:  # noqa: BLE001
            log.info("warm %s: %s", base, e)
    await asyncio.gather(*(touch(base) for base in {PROVIDERS[parse(m)[0]][0] for m in (PRIMARY, WATCH, BACKUP)}))


def _cost(u):
    """USD from a usage block: xAI reports ticks (1e10 per dollar), OpenRouter reports dollars."""
    if u.get("cost_in_usd_ticks") is not None:
        return u["cost_in_usd_ticks"] / 1e10
    return float(u.get("cost") or 0)


def request_body(model, msgs, max_tokens=1500):
    """The chat-completions body for a model, with only the settings its provider accepts."""
    provider, name, effort = parse(model)
    gpt6 = provider == "openai" and name.startswith("gpt-6")
    body = {"model": name, "messages": msgs, "stream": True, "stream_options": {"include_usage": True}}
    # OpenAI's current models reject max_tokens; every other provider here expects it.
    body["max_completion_tokens" if provider == "openai" else "max_tokens"] = max_tokens
    # gpt-6 and the Claude models after Haiku 4.5 only allow the default temperature.
    if not (gpt6 or (provider == "anthropic" and "haiku" not in name)):
        body["temperature"] = 0.2
    effort = effort or ("none" if gpt6 else "")   # gpt-6 reasons unless told not to, which delays the first word
    if effort:
        body["reasoning_effort"] = effort
    return body


async def stream(model, msgs, max_tokens=1500):
    """Yield text chunks as the model writes them. Raises on HTTP errors (429 included).
    max_tokens is generous because reasoning tokens can count against it."""
    provider, name, effort = parse(model)
    base, key_env = PROVIDERS[provider]
    key = os.getenv(key_env)
    if not key:
        raise RuntimeError(f"{key_env} not set")
    _roll()
    usage["calls"] += 1
    body = request_body(model, msgs, max_tokens)
    headers = {"Authorization": f"Bearer {key}"}
    async with http.stream("POST", base + "chat/completions", json=body, headers=headers,
                           timeout=httpx.Timeout(20, connect=3)) as r:
        if r.status_code >= 400:
            raise RuntimeError(f"{model} HTTP {r.status_code}: {(await r.aread())[:200]!r}")
        async for line in r.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except ValueError:
                continue
            if isinstance(chunk.get("usage"), dict):
                usage["usd"] += _cost(chunk["usage"])
            try:
                delta = chunk["choices"][0]["delta"].get("content")
            except (KeyError, IndexError, TypeError, AttributeError):
                continue
            if delta:
                yield delta


async def chat(msgs, model=None, timeout=6.0):
    """Whole reply, model (default PRIMARY) first, backup on any failure. -> (text, model used)"""
    last = None
    for m in dict.fromkeys([model or PRIMARY, BACKUP]):
        try:
            async with asyncio.timeout(timeout):
                return "".join([c async for c in stream(m, msgs)]), m
        except Exception as e:  # noqa: BLE001 - any failure means "try the backup"
            last = e
            log.warning("%s failed: %s", m, e)
    raise RuntimeError(f"all models failed: {last}")


async def hedged_stream(msgs, model=None, hedge_s=HEDGE_S):
    """Stream from model (default PRIMARY). If it has no first chunk within hedge_s, or fails,
    race the backup and keep whichever produces a chunk first; the other is cancelled."""
    model = model or PRIMARY
    gens = [stream(model, msgs)]
    tasks = {asyncio.create_task(anext(gens[0])): 0}
    done, _ = await asyncio.wait(tasks, timeout=hedge_s)
    if model != BACKUP and not (done and next(iter(done)).exception() is None):
        log.info("hedge: starting %s", BACKUP)
        gens.append(stream(BACKUP, msgs))
        tasks[asyncio.create_task(anext(gens[1]))] = 1

    winner, first, pending, errors = None, "", set(tasks), []
    while pending and winner is None:
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            if t.exception() is None:
                winner, first = tasks[t], t.result()
                break
            errors.append(t.exception())
    for t in pending:
        t.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    for i, g in enumerate(gens):
        if i != winner:
            await g.aclose()
    if winner is None:
        raise RuntimeError(f"all models failed: {errors}")
    if winner == 1:
        log.info("hedge: backup won (primary slow or failed)")
    try:
        yield first
        async for chunk in gens[winner]:
            yield chunk
    finally:
        await gens[winner].aclose()


def parse_json(text):
    """First {...} block in a model reply, or None."""
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        return json.loads(m.group(0)) if m else None
    except ValueError:
        return None


if __name__ == "__main__":
    async def fake(model, msgs, max_tokens=0):
        if model == "p:slow":
            await asyncio.sleep(0.3)
        if model == "p:fail":
            raise RuntimeError("429")
        for c in (model, " done"):
            yield c

    async def run(primary):
        return "".join([c async for c in hedged_stream([], model=primary, hedge_s=0.1)])

    stream = fake  # noqa: F811 - swap the network out for the check
    BACKUP = "b:fast"
    assert asyncio.run(run("p:fast")) == "p:fast done"
    assert asyncio.run(run("p:slow")) == "b:fast done"
    assert asyncio.run(run("p:fail")) == "b:fast done"
    assert asyncio.run(chat([], model="p:fail")) == ("b:fast done", "b:fast")
    assert parse_json('sure! {"urgency": 3} ok') == {"urgency": 3} and parse_json("nope") is None
    assert parse("xai:grok-4.7@low") == ("xai", "grok-4.7", "low")
    assert parse("openrouter:google/gemini-3.5-flash-lite") == ("openrouter", "google/gemini-3.5-flash-lite", "")
    b = request_body("xai:grok-4.7@low", [])
    assert b["temperature"] == 0.2 and b["max_tokens"] == 1500 and b["reasoning_effort"] == "low"
    b = request_body("openai:gpt-6-luna", [])
    assert "temperature" not in b and "max_tokens" not in b and b["max_completion_tokens"] == 1500 and b["reasoning_effort"] == "none"
    assert request_body("openai:gpt-6-sol@low", [])["reasoning_effort"] == "low"
    b = request_body("openai:gpt-5.4-mini", [])
    assert b["temperature"] == 0.2 and "reasoning_effort" not in b
    assert "temperature" not in request_body("anthropic:claude-sonnet-5-5", [])
    assert request_body("anthropic:claude-haiku-4-5", [])["temperature"] == 0.2
    assert _cost({"cost_in_usd_ticks": 25_000_000}) == 0.0025 and _cost({"cost": 0.01}) == 0.01 and _cost({}) == 0
    big, small = io.BytesIO(), io.BytesIO()
    Image.new("RGB", (2560, 1920), "white").save(big, "JPEG")
    Image.new("RGB", (640, 480), "white").save(small, "JPEG")
    assert Image.open(io.BytesIO(shrink(big.getvalue()))).size == (MAX_SIDE, MAX_SIDE * 3 // 4)
    assert shrink(small.getvalue()) == small.getvalue() and shrink(b"not a jpeg") == b"not a jpeg"
    assert messages("s", "q")[1] == {"role": "user", "content": "q"}
    print("llm ok")
