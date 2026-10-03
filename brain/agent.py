"""Iris on Agentverse, so ASI:One can find it and ask it to act.

Speaks the Agent Chat Protocol and registers an Agentverse mailbox when
AGENTVERSE_KEY is set. Leave this process running: chat is delivered through
the mailbox, and the agent goes quiet when the process stops.

  python agent.py          # run (needs the brain on :8000 for the glasses)
  python agent.py address  # print the agent address and stop
"""
import asyncio
import logging
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)

import act

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
log = logging.getLogger("iris.agent")

HERE = Path(__file__).resolve().parent
README = HERE / "agent_readme.md"
SEED_FILE = HERE / ".agent_seed"
PORT = int(os.getenv("AGENT_PORT") or 8001)
DESCRIPTION = (
    "Acts on what Iris glasses just saw. Checks the weather, tonight's sky, "
    "the next SpaceX launch and the ISS, recalls a moment, and puts one line on the glasses."
)


def load_seed():
    """The same seed every run, so the Agentverse identity does not change."""
    seed = (os.getenv("AGENT_SEED_PHRASE") or "").strip()
    if seed:
        return seed
    try:
        saved = SEED_FILE.read_text().strip()
    except OSError:
        saved = ""
    if saved:
        return saved
    seed = secrets.token_urlsafe(32)
    try:
        SEED_FILE.write_text(seed)
        log.warning("saved a new agent seed to %s", SEED_FILE.name)
    except OSError as e:
        log.warning("could not save the agent seed (%s); the address will change next run", e)
    return seed


agent = Agent(
    name="Iris Act",
    seed=load_seed(),
    port=PORT,
    mailbox=True,
    publish_agent_details=True,
    readme_path=str(README),
    description=DESCRIPTION,
    handle=(os.getenv("AGENT_HANDLE") or "iris-act").strip() or "iris-act",
    metadata={"categories": "glasses,weather,night-sky,spacex,iss,memory", "is_public": "True"},
)
protocol = Protocol(spec=chat_protocol_spec)


def _text(msg):
    return "".join(item.text for item in msg.content if isinstance(item, TextContent)).strip()


@protocol.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(
        timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    text = _text(msg)
    if not text:
        reply = ("I act on what Iris glasses just saw: whether to go outside, "
                 "what is in the night sky, where you left something, or one line on the display.")
    else:
        ctx.logger.info("from %s: %s", sender, text[:160])
        async with httpx.AsyncClient() as http:
            reply = await act.run(text, http)
    await ctx.send(sender, ChatMessage(content=[
        TextContent(type="text", text=reply),
        EndSessionContent(type="end-session"),
    ]))


@protocol.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    ctx.logger.debug("ack %s from %s", msg.acknowledged_msg_id, sender)


agent.include(protocol, publish_manifest=True)


async def register(ctx):
    """Prove this identity to Agentverse and publish the mailbox plus the profile."""
    key = (os.getenv("AGENTVERSE_KEY") or "").strip()
    if not key:
        ctx.logger.warning(
            "AGENTVERSE_KEY is not set, so ASI:One cannot find this agent yet. "
            "Add it to .env and restart. Inspector: the URL logged above, then Connect, then Mailbox.")
        return
    url = f"http://127.0.0.1:{PORT}/connect"
    async with httpx.AsyncClient() as client:
        for attempt in range(1, 13):
            try:
                r = await client.post(url, json={"user_token": key, "agent_type": "mailbox"}, timeout=20)
            except httpx.HTTPError as e:
                ctx.logger.info("Agentverse registration attempt %s: %s", attempt, e)
                await asyncio.sleep(0.5)
                continue
            if r.status_code < 300 and '"success": false' not in r.text.lower() and '"success":false' not in r.text.lower():
                ctx.logger.info("registered on Agentverse as %s (%s)", agent.name, agent.address)
                return
            ctx.logger.warning("Agentverse registration HTTP %s: %s", r.status_code, r.text[:400])
            return
    ctx.logger.warning("Agentverse did not accept the registration. The agent is still running.")


_background = set()


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info("Iris Act address: %s", agent.address)
    ctx.logger.info("profile: %s", README.name)
    task = asyncio.create_task(register(ctx))
    _background.add(task)
    task.add_done_callback(_background.discard)


if __name__ == "__main__":
    import sys
    if sys.argv[1:2] == ["address"]:
        print(agent.address)
    else:
        agent.run()
