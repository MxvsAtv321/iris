# Iris Act

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Use Iris Act when someone is wearing Iris glasses, or asks what to do about the thing they are looking at, whether to go outside, what they can see in the night sky, the next SpaceX launch, where the ISS is, or where they left something they saw earlier.

Iris is a clip-on camera and a tiny display on a pair of glasses. This agent is the part that acts on what those glasses see.

## What it does

1. Reads the latest scene from the glasses.
2. Decides the intent: check live conditions, recall a moment, put a line on the display, or choose a next step from the current view.
3. Fetches only what that intent needs: weather, cloud cover, the moon, the next SpaceX launch, and the ISS (Ann Arbor), or a search over moments the glasses saved.
4. Picks a concrete next step, such as stay in, look up tonight, bring a jacket, or found it.
5. Puts that step on the glasses display (one short line) when a session is running, and replies with what it did.

## Ask it things like

- Should I go outside tonight?
- What can I see in space tonight?
- When is the next SpaceX launch?
- Where is the ISS, and should I look up?
- Do I need a jacket?
- Where did I leave my phone?
- What should I do about what I'm looking at?
- Put "12g protein" on my glasses.

## What it will not do

It answers from live data and from what the glasses have seen. It does not book anything, send messages, or spend money.

## How it works

- **Reasoning:** rules decide the common requests, and ASI:One decides the intent when the rules can't.
- **Tools:** live weather (Open-Meteo), launches (Launch Library 2), the ISS position, Iris's memory search, and the glasses display.
- **Protocol:** Agent Chat Protocol. One message in, one answer out, and the session ends.

## Keywords

smart glasses, wearable, weather, night sky, SpaceX launch, ISS, memory, what should I do, Iris

Built at MHacks 2026 by the Iris team. Its sibling agents are Iris Memory and Iris Restraint.
