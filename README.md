# Iris

A clip-on that turns any pair of glasses into glasses that think ahead. Built at MHacks 2026.

Start with `CLAUDE.md` for the overview and `docs/contracts.md` for how the parts connect.

## Fetch.ai agents

Three Iris agents are registered on Agentverse. Each speaks the Agent Chat Protocol, so ASI:One can find it and talk to it.

| Agent | Handle | Address | What it does |
| --- | --- | --- | --- |
| Iris Act | `iris-act` | `agent1qw5cqpve3mh2dqzpcs8f9nm63k3l5vud5mm4hj6d4zaa8hz0ef39gnp4k2z` | Acts on what the glasses just saw: live weather, tonight's sky, the next SpaceX launch, the ISS, a recalled moment, and one line on the glasses display. |
| Iris Memory | `iris-memory` | `agent1qf02tlgzaflyv5xmruczpksuh0yhklwc4gwwenmnnas8s6p9fxuu270hlvy` | "Where did I see X?" Searches the moments the glasses saved and answers with the place, the time and the photo. |
| Iris Restraint | `iris-restraint` | `agent1qtukccjjylufjl4yjfxw4was9r2nz74vpnqh4ua8c4tn0sl76kk45kmwflr` | The gate that decides whether a moment is worth an interruption: stay silent, show a line, or speak, with the urgency and every rule's outcome. |

**Run them.** Each agent is one process and has to stay running to answer. They need `AGENTVERSE_KEY` in `.env`; with `ASI_API_KEY` set, ASI:One does their reasoning (otherwise the brain's question model does, and with no model at all they answer from their rules).

    cd brain && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    scripts/agents.sh start      # from the repo root: starts all three, logs in brain/.agents/
    scripts/agents.sh status
    scripts/agents.sh stop

**Test one.** This sends a chat message through Agentverse and prints the reply:

    brain/.venv/bin/python scripts/ask_agent.py agent1qtukccjjylufjl4yjfxw4was9r2nz74vpnqh4ua8c4tn0sl76kk45kmwflr "The whiteboard in front of me says 7 x 8 = 54."

In ASI:One, type `@` followed by the address, or ask for the agent by name. Each agent's own page (`brain/agent_readme.md`, `brain/agent_memory_readme.md`, `brain/agent_gate_readme.md`) lists what to ask it. No-network self-checks: `python act.py`, `python agent_memory.py check`, `python agent_gate.py check` in `brain/`.
