"""What every Iris agent on Agentverse shares: a stable identity, the Agent Chat Protocol,
registration, and ASI:One as the model that reasons for it.

An agent is one process. It speaks the chat protocol, registers an Agentverse mailbox when
AGENTVERSE_KEY is set, and goes quiet when the process stops, so leave it running.
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

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")
log = logging.getLogger("iris.agent")

# ASI:One reasons for the agents. Without ASI_API_KEY, or if it fails, the brain's question model steps in,
# and every agent still answers from its rules if no model does.
AGENT_MODEL = os.getenv("AGENT_MODEL") or "asi:asi1-mini"
BADGES = ("![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)\n"
          "![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)")


def load_seed(env, file):
    """The same seed every run, so the Agentverse identity does not change."""
    seed = (os.getenv(env) or "").strip()
    if seed:
        return seed
    try:
        saved = file.read_text().strip()
    except OSError:
        saved = ""
    if saved:
        return saved
    seed = secrets.token_urlsafe(32)
    try:
        file.write_text(seed)
        log.warning("saved a new agent seed to %s", file.name)
    except OSError as e:
        log.warning("could not save the agent seed (%s); the address will change next run", e)
    return seed


async def think(system, text, timeout=4.0, max_tokens=400):
    """One reply from the reasoning model. -> (text, model). Raises if no model answered in time."""
    import llm
    last = None
    for model in dict.fromkeys([AGENT_MODEL, llm.PRIMARY]):
        try:
            async with asyncio.timeout(timeout):
                msgs = llm.messages(system, text or "")
                return "".join([chunk async for chunk in llm.stream(model, msgs, max_tokens)]).strip(), model
        except Exception as e:  # noqa: BLE001 - the next model, then the caller's rules
            last = e
            log.info("%s did not answer: %s", model, e)
    raise RuntimeError(f"no model answered: {last}")


def engine(model):
    """How a reply names the model that reasoned for it."""
    return "ASI:One" if (model or "").startswith("asi:") else (model or "").split(":")[-1]


def text_of(msg):
    return "".join(item.text for item in msg.content if isinstance(item, TextContent)).strip()


def build(*, name, handle, port, description, readme, categories, answer, greeting, seed_env, seed_file):
    """An agent that answers chat messages with `answer(text, sender) -> str`. Call .run() on it."""
    agent = Agent(
        name=name,
        seed=load_seed(seed_env, HERE / seed_file),
        port=port,
        mailbox=True,
        publish_agent_details=True,
        readme_path=str(HERE / readme),
        description=description,
        handle=handle[:20],                      # Agentverse allows 20 characters
        metadata={"categories": categories, "is_public": "True"},
    )
    protocol = Protocol(spec=chat_protocol_spec)

    @protocol.on_message(ChatMessage)
    async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
        await ctx.send(sender, ChatAcknowledgement(
            timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
        text = text_of(msg)
        if not text:
            reply = greeting
        else:
            ctx.logger.info("from %s: %s", sender, text[:160])
            try:
                reply = await answer(text, sender)
            except Exception as e:  # noqa: BLE001 - whoever asked always gets a reply
                ctx.logger.warning("answer failed: %s: %s", type(e).__name__, e)
                reply = "Something went wrong on my side. Try once more."
        await ctx.send(sender, ChatMessage(content=[
            TextContent(type="text", text=reply or greeting),
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
        url = f"http://127.0.0.1:{port}/connect"
        async with httpx.AsyncClient() as client:
            for attempt in range(1, 13):
                try:
                    r = await client.post(url, json={"user_token": key, "agent_type": "mailbox"}, timeout=20)
                except httpx.HTTPError as e:
                    ctx.logger.info("Agentverse registration attempt %s: %s", attempt, e)
                    await asyncio.sleep(0.5)
                    continue
                if r.status_code < 300 and '"success": false' not in r.text.lower() and '"success":false' not in r.text.lower():
                    ctx.logger.info("registered on Agentverse as %s (%s)", name, agent.address)
                    return
                ctx.logger.warning("Agentverse registration HTTP %s: %s", r.status_code, r.text[:400])
                return
        ctx.logger.warning("Agentverse did not accept the registration. The agent is still running.")

    background = set()

    @agent.on_event("startup")
    async def startup(ctx: Context):
        ctx.logger.info("%s address: %s", name, agent.address)
        ctx.logger.info("profile: %s", readme)
        task = asyncio.create_task(register(ctx))
        background.add(task)
        task.add_done_callback(background.discard)

    return agent


def main(agent):
    """`python <agent>.py` runs it; `python <agent>.py address` prints its address and stops."""
    import sys
    if sys.argv[1:2] == ["address"]:
        print(agent.address)
    else:
        agent.run()
