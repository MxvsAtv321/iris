// Where things are on the tree. The first REAL_SLOTS places belong to real
// moments (decisions and memories); the rest hold the tree's own standing
// foliage, which is there from the start so the crown is never bare.

import type { Leaf, LeafKind } from "../canopy";
import { SLOTS, theTree, type Vec3 } from "./grow";

export const TOTAL_SLOTS = SLOTS;
export const REAL_SLOTS = 3000;

/** How long a leaf is, in meters, when fully grown. Blossoms are the largest thing on a branch. */
export const LEAF_SIZE: Record<LeafKind, number> = { silent: 0.6, display: 0.8, speak: 1.0, blossom: 1.3 };

/** The middle of a leaf, for pointing at it, flying to it, or tying a thread to it. */
export function leafCenter(leaf: Pick<Leaf, "slot" | "kind">): Vec3 {
  const { p, dir } = theTree().slots[leaf.slot];
  if (leaf.kind === "blossom") return p;
  const half = LEAF_SIZE[leaf.kind] / 2;
  return [p[0] + dir[0] * half, p[1] + dir[1] * half, p[2] + dir[2] * half];
}

/** Stable 0 to 1 number per slot, for sizes, tints and timing that shouldn't change between frames. */
export function slotNoise(slot: number, salt = 0): number {
  let h = Math.imul(slot + 1, 2654435761) ^ Math.imul(salt + 1, 40503);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Seconds on the page's clock. Leaves record when they sprouted on this clock, and the shaders run on it. */
export const pageSeconds = () => performance.now() / 1000;
