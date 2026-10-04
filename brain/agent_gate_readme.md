# Iris Restraint

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Use Iris Restraint when an assistant, an agent or a wearable has something it could tell a person and needs to decide whether to interrupt them: stay silent, show one line, or speak.

Most moments are not worth an interruption. Iris glasses use this gate on every frame they see, and it stays silent through most of them. This agent offers the same gate to anyone.

## What it does

1. Reads the moment you describe, or the JSON you send.
2. Scores how urgent it is, from 0 to 10. A mistake in visible writing, a hazard or something about to be missed scores 8 to 10. Useful but not urgent scores 5 to 7. Ordinary life scores 0 to 3.
3. Applies four rules, in order, and remembers what it has already told you:
   - **Cooldown:** one nudge per topic every two minutes.
   - **Repeat:** never says the same thing twice in five minutes.
   - **Quiet after an answer:** nothing on top of a conversation.
   - **Rate limit:** at most one spoken line every 15 seconds; a second one is shown instead.
4. Answers with the verdict, the line it would show or say, and every rule's outcome.

## Ask it things like

- The whiteboard in front of me says 7 x 8 = 54.
- I'm looking at a coffee cup on my desk.
- There is a pan on the stove with the burner on and nobody in the kitchen.
- The sign says my train leaves from platform 4, and I'm standing on platform 9.

Send the same moment twice and the second answer is silence: that is the cooldown.

## For other agents: send JSON

    {"description": "a whiteboard, line 2 reads 7 x 8 = 54", "urgency": 9,
     "topic": "whiteboard-math", "text": "Line 2: 7x8 is 56",
     "say": "Line 2 says seven times eight is fifty-four. It's fifty-six."}

With `urgency` given, no model is called: the rules alone decide, in a few milliseconds. Leave `urgency` out and the agent scores the description first.

## What you get back

    Speak: "Line 2 says seven times eight is fifty-four. It's fifty-six."
    Urgency 9 of 10: arithmetic error on a whiteboard. Speaks at 8, shows at 5.
    Rules: cooldown passed, repeat passed, quiet after an answer passed, rate limit passed.
    Scored by ASI:One.

## How it works

- **Reasoning:** ASI:One scores the urgency and writes the line. The four rules are plain code, so the same input always gets the same verdict.
- **Memory:** cooldowns and what was already said are kept per sender, so each conversation has its own gate.
- **Protocol:** Agent Chat Protocol. One message in, one verdict out, and the session ends.

## Keywords

interruption, notification gate, restraint, proactive assistant, attention, smart glasses, wearable, Iris, do not disturb

## Limits

It judges only what you describe. It does not see your camera and does not notify anyone.

Built at MHacks 2026 by the Iris team. Its sibling agents are Iris Act and Iris Memory.
