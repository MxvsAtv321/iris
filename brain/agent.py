"""Iris on Agentverse, so ASI:One can find it and ask it to act.

Speaks the Agent Chat Protocol and registers an Agentverse mailbox when
AGENTVERSE_KEY is set. Leave this process running: chat is delivered through
the mailbox, and the agent goes quiet when the process stops.

  python agent.py          # run (needs the brain on :8000 for the glasses)
  python agent.py address  # print the agent address and stop
"""
import os

import httpx

import act
import agent_kit

DESCRIPTION = (
    "Acts on what Iris glasses just saw. Checks the weather, tonight's sky, "
    "the next SpaceX launch and the ISS, recalls a moment, and puts one line on the glasses."
)


async def answer(text, sender):
    async with httpx.AsyncClient() as http:
        return await act.run(text, http)


agent = agent_kit.build(
    name="Iris Act",
    handle=(os.getenv("AGENT_HANDLE") or "iris-act").strip() or "iris-act",
    port=int(os.getenv("AGENT_PORT") or 8001),
    description=DESCRIPTION,
    readme="agent_readme.md",
    categories="glasses,weather,night-sky,spacex,iss,memory",
    answer=answer,
    greeting=("I act on what Iris glasses just saw: whether to go outside, "
              "what is in the night sky, where you left something, or one line on the display."),
    seed_env="AGENT_SEED_PHRASE",
    seed_file=".agent_seed",
)

if __name__ == "__main__":
    agent_kit.main(agent)
