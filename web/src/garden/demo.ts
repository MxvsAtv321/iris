// Scripted moments for /garden?demo, so the tree can be shown with no brain,
// camera or memory running. They read like the real thing, and the page says
// plainly that they are scripted.

import type { LeafKind, Sprout } from "./canopy";

type Line = [kind: LeafKind, line: string, reason: string];

const SCRIPT: Line[] = [
  ["silent", "", "no change"],
  ["silent", "", "urgency 2: a laptop on a desk, nothing worth saying"],
  ["blossom", "keys, laptop, notebook. A desk with a lamp.", "Saved to memory"],
  ["silent", "", "scene changed; next model call in 3s"],
  ["display", "Keys are by the laptop", "urgency 6: keys left beside the laptop"],
  ["silent", "", "no change"],
  ["silent", "", "urgency 3: the whiteboard, already read"],
  ["blossom", "whiteboard, marker. Sums written in blue.", "Saved to memory"],
  ["speak", "Line 2 says seven times eight is fifty-four. It's fifty-six.", "urgency 9: arithmetic error on the whiteboard"],
  ["silent", "", "no change"],
  ["silent", "", "urgency 1: an empty corridor"],
  ["blossom", "phone, mug. A desk by the window.", "Saved to memory"],
  ["silent", "", "urgency 2: the same mug as before"],
  ["display", "Mug is still on the stove", "urgency 7: a mug left on a hot stove"],
  ["silent", "", "question in progress"],
  ["speak", "That bar has about twelve grams of protein.", "You asked: how much protein is in this?"],
  ["blossom", "protein bar, backpack. A wooden bench.", "Saved to memory"],
  ["silent", "", "no change"],
  ["silent", "", "urgency 2: a bus stop, timetable too far to read"],
  ["display", "Bus 23 in 4 min", "urgency 6: the bus timetable on a phone screen"],
  ["blossom", "phone, charger. The arm of the sofa.", "Saved to memory"],
  ["silent", "", "urgency 1: a ceiling"],
  ["speak", "Your phone is on the arm of the sofa.", "You asked: where did I leave my phone?"],
  ["silent", "", "no change"],
  ["blossom", "kettle, mug, stove. The kitchen counter.", "Saved to memory"],
  ["silent", "", "urgency 3: a notebook, nothing new written"],
];

/** The nth scripted moment. Ids never repeat, so the script can loop for as long as the page is open. */
export function demoSprout(n: number, at: number): Sprout {
  const [kind, line, reason] = SCRIPT[n % SCRIPT.length];
  const momentId = kind === "blossom" ? -(n + 1) : null; // negative: there's no photo behind a scripted memory
  return { id: momentId === null ? `demo:${n}` : `m:${momentId}`, kind, at, line, reason, momentId };
}

/** How many moments the demo tree starts with, and how often one more sprouts. */
export const DEMO_START = 260;
export const DEMO_EVERY_MS = 2600;
