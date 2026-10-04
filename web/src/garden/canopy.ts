// What's on the tree. Every decision Iris makes becomes a leaf, every saved
// memory becomes a blossom, and leaves that are about the same thing are
// joined by a thread. Nothing here touches the screen or the network, so it
// can be tested on its own.

import type { IrisEvent } from "../api";
import type { Moment } from "./api";

/** Faint for a silent decision, brighter where Iris showed a line or spoke, a blossom for a saved memory. */
export type LeafKind = "silent" | "display" | "speak" | "blossom";

export type Sprout = {
  id: string;
  kind: LeafKind;
  /** When it happened, in ms since 1970. */
  at: number;
  /** What Iris showed or said, or the memory's description. Empty when it stayed silent. */
  line: string;
  /** Why it decided that. */
  reason: string;
  momentId: number | null;
};

export type Leaf = Sprout & {
  keywords: string[];
  /** Which place on the tree it grows from. */
  slot: number;
  /** ms on the page's clock when it sprouted here. 0 for leaves that were already on the tree at load. */
  born: number;
};

export type Thread = { a: string; b: string; why: string; born: number };

export type Canopy = { leaves: Leaf[]; threads: Thread[]; sprouted: number };

export const EMPTY: Canopy = { leaves: [], threads: [], sprouted: 0 };

export const MAX_THREADS = 90;
const THREADS_PER_LEAF = 2;

// Words that say nothing about what Iris was looking at, including the gate's own phrasing.
const DULL = new Set(
  `the and for with that this from into onto over under near next was were are has have had not but its it's
   you your their they them there here then than when what where which while will would could should can
   about some any all one two per very just still also only out off low high new old same
   urgency scene change changed model call calls frame error bad output question progress nothing view already
   recently described giving space possible deserves direct answer answered asked ask sample demo iris seen
   visible left right front back side top table`.split(/\s+/),
);

/** The words worth connecting on: lowercase, no filler, plurals folded together. */
export function keywordsOf(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z']{2,}/g) ?? [];
  const found: string[] = [];
  for (const raw of words) {
    if (DULL.has(raw)) continue;
    const word = raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (DULL.has(word) || found.includes(word)) continue;
    found.push(word);
    if (found.length === 6) break;
  }
  return found;
}

// The brain numbers frames and questions from 1 again every time it restarts, and the tree outlives a restart (it is
// kept in the browser). An id made of the number alone would make every moment after a restart look like one already
// on the tree, and the tree would stop growing. The event's time makes the id belong to one moment only.
/** A leaf for one event from the brain, or null for events that aren't moments (metrics, half-typed answers). */
export function sproutFromEvent(e: IrisEvent): Sprout | null {
  const at = Date.parse(e.at);
  if (e.type === "decision" && e.level) {
    return { id: `d:${e.frame_id ?? ""}@${e.at}`, kind: e.level, at, line: e.speak || e.text || "", reason: e.reason ?? "", momentId: null };
  }
  if (e.type === "answer") {
    return { id: `a:${e.ask_id ?? ""}@${e.at}`, kind: "speak", at, line: e.speak || e.display || "", reason: `You asked: ${e.question ?? ""}`, momentId: null };
  }
  if (e.type === "memory_saved" && e.moment_id != null) {
    const momentId = Number(e.moment_id);
    return { id: `m:${e.moment_id}`, kind: "blossom", at, line: e.description ?? "", reason: "Saved to memory", momentId: Number.isFinite(momentId) ? momentId : null };
  }
  return null;
}

export function sproutFromMoment(m: Moment): Sprout {
  return { id: `m:${m.id}`, kind: "blossom", at: Date.parse(m.captured_at), line: m.description, reason: "Saved to memory", momentId: m.id };
}

/**
 * Puts new sprouts on the tree. Each takes the next slot, so when the tree is
 * full the oldest leaf gives its place to the newest. A sprout already on the
 * tree is skipped. Each new leaf is tied to the most recent leaf sharing a
 * word with it, unless both stayed silent.
 */
export function grow(canopy: Canopy, sprouts: Sprout[], now: number, capacity: number): Canopy {
  const have = new Set(canopy.leaves.map((l) => l.id));
  const fresh = sprouts.filter((s) => !have.has(s.id) && have.add(s.id));
  if (fresh.length === 0) return canopy;

  let leaves = canopy.leaves;
  let threads = canopy.threads;
  let sprouted = canopy.sprouted;

  for (const s of fresh) {
    const slot = sprouted++ % capacity;
    const leaf: Leaf = { ...s, keywords: keywordsOf(`${s.line} ${s.reason}`), slot, born: now };
    const replaced = leaves.find((l) => l.slot === slot);
    if (replaced) {
      leaves = leaves.filter((l) => l !== replaced);
      threads = threads.filter((t) => t.a !== replaced.id && t.b !== replaced.id);
    }

    let tied = 0;
    for (const word of leaf.keywords) {
      if (tied === THREADS_PER_LEAF) break;
      for (let i = leaves.length - 1; i >= 0; i--) {
        const other = leaves[i];
        if (!other.keywords.includes(word)) continue;
        if (leaf.kind === "silent" && other.kind === "silent") continue;
        if (threads.some((t) => (t.a === other.id && t.b === leaf.id) || (t.a === leaf.id && t.b === other.id))) break;
        threads = [...threads, { a: other.id, b: leaf.id, why: word, born: now }];
        tied++;
        break;
      }
    }
    leaves = [...leaves, leaf];
  }

  return { leaves, threads: threads.slice(-MAX_THREADS), sprouted };
}

/** Threads from one memory to the memories closest to it in meaning, as memory search ranks them. */
export function tieByMeaning(canopy: Canopy, momentId: number, closest: number[], now: number): Canopy {
  const from = canopy.leaves.find((l) => l.momentId === momentId);
  if (!from) return canopy;
  let threads = canopy.threads;
  for (const id of closest) {
    const to = canopy.leaves.find((l) => l.momentId === id);
    if (!to || to === from) continue;
    if (threads.some((t) => (t.a === from.id && t.b === to.id) || (t.a === to.id && t.b === from.id))) continue;
    threads = [...threads, { a: from.id, b: to.id, why: "close in meaning", born: now }];
  }
  return threads === canopy.threads ? canopy : { ...canopy, threads: threads.slice(-MAX_THREADS) };
}

/** The blossom whose words best match a question, newest first on a tie. Used when memory search can't be reached. */
export function blossomFor(canopy: Canopy, question: string): Leaf | null {
  const asked = keywordsOf(question);
  let best: Leaf | null = null;
  let bestScore = 0;
  for (const leaf of canopy.leaves) {
    if (leaf.kind !== "blossom") continue;
    const score = asked.filter((w) => leaf.keywords.includes(w)).length;
    if (score > 0 && (score > bestScore || (score === bestScore && best && leaf.at >= best.at))) {
      best = leaf;
      bestScore = score;
    }
  }
  return best;
}
