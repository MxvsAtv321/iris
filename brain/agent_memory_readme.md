# Iris Memory

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Use Iris Memory when someone asks where or when they last saw something: keys, a phone, a water bottle, an umbrella, a sign, a whiteboard.

Iris is a clip-on camera and a tiny display on a pair of glasses. Everything the glasses see is described and saved as a moment. This agent searches those moments and answers with the place, the time and the photo.

## What it does

1. Takes the object out of the question ("my keys" from "where did I leave my keys?").
2. Searches the saved moments by meaning and by the object's name, in Neon Postgres with pgvector.
3. Picks the most recent moment that shows the object.
4. Answers in one or two sentences: where it was and when, with a link to the photo.

If the glasses never saw the thing, it says so. It does not guess.

## Ask it things like

- Where did I leave my keys?
- Where did I see the red umbrella?
- When did I last see my phone?
- Where was the smoke detector?
- Where did I see the brick wall? session memtest-2229

Add `session <id>` at the end to search one wearer's session. Without it, the agent searches the session running on the glasses now.

## What you get back

    Your umbrella is on the coat rack by the door, seen at 9:12 PM.
    Photo: https://…/api/memory/moments/15/image?session_id=…
    Searched session memtest-2229 for "umbrella"; phrased by ASI:One.

## How it works

- **Reasoning:** ASI:One phrases the answer from the moments memory returns. If no model is reachable, the agent replies with the saved description and time as they are.
- **Memory:** one embedding call and one database query, usually under a second.
- **Protocol:** Agent Chat Protocol. One message in, one answer out, and the session ends.

## Keywords

memory, recall, lost and found, where did I leave, smart glasses, wearable, Iris, vector search

## Limits

It only knows what the Iris glasses saved. It reads; it never changes or deletes a memory.

Built at MHacks 2026 by the Iris team. Its sibling agents are Iris Act and Iris Restraint.
