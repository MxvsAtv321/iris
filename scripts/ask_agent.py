"""
Sends one chat message to an agent on Agentverse and prints its reply: a check that an Iris agent
is registered, reachable through its mailbox, and answering.

    brain/.venv/bin/python scripts/ask_agent.py <agent address> "where did I see the umbrella?"

It runs a throwaway agent on this machine (port 8009) that speaks the Agent Chat Protocol, sends
the message, waits up to 40 s for the answer and exits. The reply comes straight back to this
machine, so the agent being asked has to be running here too, or have a public endpoint.
"""
import os
import sys
from datetime import datetime, timezone
from uuid import uuid4

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, TextContent, chat_protocol_spec

if len(sys.argv) < 3:
    sys.exit(__doc__)
TARGET, QUESTION = sys.argv[1], sys.argv[2]
PORT = int(os.getenv("ASK_AGENT_PORT") or 8009)
client = Agent(name="iris-ask", seed=f"iris ask client {uuid4()}", port=PORT, endpoint=[f"http://127.0.0.1:{PORT}/submit"])
protocol = Protocol(spec=chat_protocol_spec)
state = {"sent": 0.0, "done": False}


@client.on_event("startup")
async def ask(ctx: Context):
    state["sent"] = datetime.now(timezone.utc).timestamp()
    await ctx.send(TARGET, ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(),
                                       content=[TextContent(type="text", text=QUESTION)]))


@protocol.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    print(f"acknowledged after {datetime.now(timezone.utc).timestamp() - state['sent']:.1f} s", flush=True)


@protocol.on_message(ChatMessage)
async def on_reply(ctx: Context, sender: str, msg: ChatMessage):
    text = "".join(item.text for item in msg.content if isinstance(item, TextContent))
    print(f"reply after {datetime.now(timezone.utc).timestamp() - state['sent']:.1f} s:\n{text}", flush=True)
    state["done"] = True
    os._exit(0)


@client.on_interval(period=40.0)
async def give_up(ctx: Context):
    if state["sent"] and datetime.now(timezone.utc).timestamp() - state["sent"] > 35 and not state["done"]:
        print("no reply in 40 s", flush=True)
        os._exit(1)


client.include(protocol)
client.run()
