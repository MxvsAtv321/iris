"""Model calls. Every provider here speaks the OpenAI chat-completions dialect, so switching
is one line in .env: PRIMARY_MODEL / BACKUP_MODEL as "provider:model".

Run `python llm.py` for the hedging self-check (no network).
"""
import asyncio
import base64
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
log = logging.getLogger("iris.llm")

PROVIDERS = {
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai/", "GEMINI_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1/", "OPENROUTER_API_KEY"),
    "asi": ("https://api.asi1.ai/v1/", "ASI_API_KEY"),   # Fetch.ai; text only until it documents image input
}
PRIMARY = os.getenv("PRIMARY_MODEL") or "gemini:gemini-3.5-flash-lite"
BACKUP = os.getenv("BACKUP_MODEL") or "openrouter:google/gemini-3.5-flash-lite"
REASONING_EFFORT = os.getenv("REASONING_EFFORT", "")  # e.g. "none"/"low" if thinking slows first token
DAILY_BUDGET = 450   # free-tier Gemini is 500/day per project; keep headroom
HEDGE_S = 1.5        # start the backup if the primary has no first chunk by then

http = httpx.AsyncClient()
usage = {"day": "", "gemini": 0}   # main.py persists this in state.json


def _pacific_day():
    # ponytail: fixed UTC-7 (PDT) avoids tzdata on Windows; quota resets midnight Pacific. Use -8 after Nov 2.
    return datetime.now(timezone(timedelta(hours=-7))).date().isoformat()


def gemini_calls_today():
    return usage["gemini"] if usage.get("day") == _pacific_day() else 0


def route(model):
    """Swap free-tier Gemini for the backup once the daily budget is spent. -> (model, why)"""
    if model.startswith("gemini:") and gemini_calls_today() >= DAILY_BUDGET:
        return BACKUP, "daily budget"
    return model, ""


def messages(system, text, jpeg):
    image = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": [{"type": "text", "text": text},
                                     {"type": "image_url", "image_url": {"url": image}}]},
    ]


async def stream(model, msgs, max_tokens=400):
    """Yield text chunks as the model writes them. Raises on HTTP errors (429 included)."""
    provider, name = model.split(":", 1)
    base, key_env = PROVIDERS[provider]
    key = os.getenv(key_env)
    if not key:
        raise RuntimeError(f"{key_env} not set")
    if provider == "gemini":
        if usage.get("day") != _pacific_day():
            usage.update(day=_pacific_day(), gemini=0)
        usage["gemini"] += 1
    body = {"model": name, "messages": msgs, "max_tokens": max_tokens, "temperature": 0.2, "stream": True}
    if REASONING_EFFORT:
        body["reasoning_effort"] = REASONING_EFFORT
    headers = {"Authorization": f"Bearer {key}"}
    async with http.stream("POST", base + "chat/completions", json=body, headers=headers,
                           timeout=httpx.Timeout(10, connect=3)) as r:
        if r.status_code >= 400:
            raise RuntimeError(f"{model} HTTP {r.status_code}: {(await r.aread())[:200]!r}")
        async for line in r.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                delta = json.loads(data)["choices"][0]["delta"].get("content")
            except (ValueError, KeyError, IndexError, TypeError):
                continue
            if delta:
                yield delta


async def chat(msgs, timeout=6.0):
    """Whole reply, primary first, backup on any failure. -> (text, model used)"""
    model, why = route(PRIMARY)
    if why:
        log.info("using %s: %s", model, why)
    last = None
    for m in dict.fromkeys([model, BACKUP]):
        try:
            async with asyncio.timeout(timeout):
                return "".join([c async for c in stream(m, msgs)]), m
        except Exception as e:  # noqa: BLE001 - any failure means "try the backup"
            last = e
            log.warning("%s failed: %s", m, e)
    raise RuntimeError(f"all models failed: {last}")


async def hedged_stream(msgs, hedge_s=HEDGE_S):
    """Stream from the primary. If it has no first chunk within hedge_s, or fails, race the
    backup and keep whichever produces a chunk first; the other is cancelled."""
    model, why = route(PRIMARY)
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
        log.info("hedge: backup won (%s)", why or "primary slow or failed")
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
        global PRIMARY
        PRIMARY = primary
        return "".join([c async for c in hedged_stream([], hedge_s=0.1)])

    stream = fake  # noqa: F811 - swap the network out for the check
    BACKUP = "b:fast"
    assert asyncio.run(run("p:fast")) == "p:fast done"
    assert asyncio.run(run("p:slow")) == "b:fast done"
    assert asyncio.run(run("p:fail")) == "b:fast done"
    assert parse_json('sure! {"urgency": 3} ok') == {"urgency": 3} and parse_json("nope") is None
    usage.update(day=_pacific_day(), gemini=DAILY_BUDGET)
    assert route("gemini:x") == (BACKUP, "daily budget") and route("openrouter:y") == ("openrouter:y", "")
    print("llm ok")
