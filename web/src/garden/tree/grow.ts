// Grows the tree. The trunk, the two great limbs and the roots are placed by
// hand so the silhouette is always the same; everything finer is grown toward
// a wide, low crown by space colonization, which is what makes the branching
// look like an old oak instead of a fractal. The result is fixed by the seed,
// so every visitor sees the same tree and a leaf's slot always means the same
// place on it.

export type Vec3 = [number, number, number];

/** One branch from where it leaves its parent to its tip, as a tapering line. */
export type Chain = {
  points: Vec3[];
  radii: number[];
  /** Distance from the ground along the wood, per point. Light flows along this. */
  along: number[];
};

/** A place a leaf can grow: where its stem sits and which way it points. */
export type Slot = { p: Vec3; dir: Vec3 };

export type Tree = {
  chains: Chain[];
  /** Shuffled, so taking slots in order scatters leaves over the whole crown. */
  slots: Slot[];
};

// The crown the branches grow into: far wider than it is tall, drooping at the edges.
export const CROWN = { center: 12.5, rx: 23, ry: 8, rz: 18, floor: 6.2, droop: 2.2 };
export const TRUNK_TOP = 5;

const STEP = 0.9; // how far a branch grows per round
const REACH = 6.5; // how far away a branch can sense empty crown
const CLOSE = 1.5; // crown this close to a branch counts as filled
const ATTRACTORS = 1500;
const MAX_ROUNDS = 140;
const MAX_NODES = 7000;
const TIP_RADIUS = 0.045;
const PIPE = 2.2; // a branch's cross-section is the sum of its children's, to this power
const TWIG_RADIUS = 0.2; // leaves only grow on wood thinner than this

type Node = { p: Vec3; parent: number; radius: number; floor: number; grows: boolean; kids: number[] };

/** Small seeded generator (mulberry32), so the tree never changes between visits. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const norm = (v: Vec3): Vec3 => {
  const l = len(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** How many places for leaves the tree has. */
export const SLOTS = 20000;

export function growTree(seed = 7, slotCount = SLOTS): Tree {
  const rand = seeded(seed);
  const nodes: Node[] = [];
  const add = (p: Vec3, parent: number, floor = 0, grows = true) => {
    nodes.push({ p, parent, radius: 0, floor, grows, kids: [] });
    const i = nodes.length - 1;
    if (parent >= 0) nodes[parent].kids.push(i);
    return i;
  };
  const wobble = (amount: number) => (rand() - 0.5) * 2 * amount;

  // ---------------------------------------------------------------- by hand

  // The trunk: short, massive, flaring at the base and swelling where it splits.
  const trunkRadii = [4.3, 3.5, 3.05, 2.85, 2.85, 3.0];
  let top = -1;
  for (let y = 0; y <= TRUNK_TOP; y++) top = add([wobble(0.15), y, wobble(0.15)], top, trunkRadii[y]);

  // A limb leaves `from`, heads out along `heading`, rises fast, then levels off.
  const limb = (from: number, heading: Vec3, steps: number, reach: number, rise: number, r0: number, r1: number) => {
    const h = norm(heading);
    const start = nodes[from].p;
    let at = from;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      at = add(
        [
          start[0] + h[0] * reach * t + wobble(0.35),
          start[1] + rise * (1 - Math.exp(-2.4 * t)) + wobble(0.3),
          start[2] + h[2] * reach * t + wobble(0.35),
        ],
        at,
        r0 + (r1 - r0) * t,
      );
    }
    return at;
  };
  const along = (from: number, back: number) => {
    let at = from;
    for (let i = 0; i < back; i++) at = nodes[at].parent;
    return at;
  };

  // The two great limbs, then two lesser ones off each so the crown has depth.
  const left = limb(top, [-1, 0, 0.18], 8, 10.5, 5.2, 2.3, 1.2);
  const right = limb(top, [1, 0, -0.26], 8, 10, 5.6, 2.2, 1.2);
  limb(along(left, 5), [-0.45, 0, 1], 6, 8, 4.2, 1.35, 0.75);
  limb(along(left, 4), [-0.35, 0, -1], 6, 8.5, 3.6, 1.3, 0.7);
  limb(along(right, 5), [0.4, 0, -1], 6, 8, 4.4, 1.35, 0.75);
  limb(along(right, 4), [0.5, 0, 1], 6, 8.5, 3.8, 1.3, 0.7);

  // Roots: they leave the flare, dive, and run out along the ground.
  const ROOTS = 9;
  for (let i = 0; i < ROOTS; i++) {
    let angle = (i / ROOTS) * Math.PI * 2 + wobble(0.25);
    const reach = 6 + rand() * 3.5;
    let at = 1;
    for (let s = 1; s <= 7; s++) {
      const t = s / 7;
      angle += wobble(0.12);
      const d = 2.2 + reach * t;
      at = add([Math.cos(angle) * d, 1.9 * Math.exp(-2.6 * t) - 0.9 * t * t + wobble(0.08), Math.sin(angle) * d], at, 1.5 * (1 - t) + 0.2 * t, false);
    }
  }

  // ---------------------------------------------------------------- grown

  // Empty crown for the branches to reach for, denser toward the outside.
  const targets: Vec3[] = [];
  while (targets.length < ATTRACTORS) {
    const v: Vec3 = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
    const l = len(v);
    if (l > 1 || l < 0.05) continue;
    const push = Math.pow(l, -0.35); // move points outward, toward the shell
    const x = v[0] * push * CROWN.rx;
    const z = v[2] * push * CROWN.rz;
    if (Math.hypot(x / CROWN.rx, v[1] * push, z / CROWN.rz) > 1) continue;
    const edge = Math.hypot(x / CROWN.rx, z / CROWN.rz);
    const y = CROWN.center + v[1] * push * CROWN.ry - CROWN.droop * edge * edge;
    if (y < CROWN.floor) continue;
    targets.push([x, y, z]);
  }

  // Each target remembers its nearest branch, so a round only checks new wood.
  const nearest = new Int32Array(targets.length).fill(-1);
  const nearestD = new Float32Array(targets.length).fill(Infinity);
  const alive = new Uint8Array(targets.length).fill(1);
  let checked = 0;

  for (let round = 0; round < MAX_ROUNDS && nodes.length < MAX_NODES; round++) {
    for (let t = 0; t < targets.length; t++) {
      if (!alive[t]) continue;
      const a = targets[t];
      for (let n = checked; n < nodes.length; n++) {
        if (!nodes[n].grows) continue;
        const p = nodes[n].p;
        const d = Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]);
        if (d < nearestD[t]) {
          nearestD[t] = d;
          nearest[t] = n;
        }
      }
      if (nearestD[t] < CLOSE) alive[t] = 0;
    }
    checked = nodes.length;

    const pull = new Map<number, Vec3>();
    for (let t = 0; t < targets.length; t++) {
      if (!alive[t] || nearestD[t] > REACH) continue;
      const p = nodes[nearest[t]].p;
      const d = norm([targets[t][0] - p[0], targets[t][1] - p[1], targets[t][2] - p[2]]);
      const sum = pull.get(nearest[t]) ?? [0, 0, 0];
      pull.set(nearest[t], [sum[0] + d[0], sum[1] + d[1], sum[2] + d[2]]);
    }
    if (pull.size === 0) break;

    let grew = false;
    for (const [n, sum] of pull) {
      if (len(sum) < 0.15 || nodes[n].kids.length >= 3) continue;
      // A little randomness keeps the wood gnarled instead of ruler-straight.
      const d = norm([sum[0] + wobble(0.9), sum[1] + wobble(0.9), sum[2] + wobble(0.9)]);
      const p = nodes[n].p;
      const next: Vec3 = [p[0] + d[0] * STEP, p[1] + d[1] * STEP, p[2] + d[2] * STEP];
      if (nodes[n].kids.some((k) => Math.hypot(nodes[k].p[0] - next[0], nodes[k].p[1] - next[1], nodes[k].p[2] - next[2]) < STEP * 0.4)) continue;
      add(next, n);
      grew = true;
    }
    if (!grew) break;
  }

  // ---------------------------------------------------------------- thickness

  // Children always come after their parent, so one backward pass sizes every branch.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const fromKids = n.kids.length ? Math.pow(n.kids.reduce((s, k) => s + Math.pow(nodes[k].radius, PIPE), 0), 1 / PIPE) : TIP_RADIUS;
    n.radius = Math.max(n.floor, fromKids);
  }

  // ---------------------------------------------------------------- chains

  const distance = new Float32Array(nodes.length);
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    const q = nodes[n.parent].p;
    distance[i] = distance[n.parent] + Math.hypot(n.p[0] - q[0], n.p[1] - q[1], n.p[2] - q[2]);
  }
  const mainKid = (i: number) => nodes[i].kids.reduce((best, k) => (best < 0 || nodes[k].radius > nodes[best].radius ? k : best), -1);

  const chains: Chain[] = [];
  const starts: number[] = [0];
  while (starts.length) {
    let at = starts.pop()!;
    const chain: Chain = { points: [], radii: [], along: [] };
    const parent = nodes[at].parent;
    if (parent >= 0) {
      // Start inside the parent so the joint has no gap.
      chain.points.push(nodes[parent].p);
      chain.radii.push(nodes[at].radius);
      chain.along.push(distance[parent]);
    }
    while (at >= 0) {
      chain.points.push(nodes[at].p);
      chain.radii.push(nodes[at].radius);
      chain.along.push(distance[at]);
      const main = mainKid(at);
      for (const k of nodes[at].kids) if (k !== main) starts.push(k);
      at = main;
    }
    if (chain.points.length > 1) chains.push(chain);
  }

  // ---------------------------------------------------------------- leaf slots

  // Leaves sit on the outside and top of the crown, so the limbs show through from below.
  const shell = (p: Vec3) => Math.hypot(p[0] / CROWN.rx, (p[1] - CROWN.center) / CROWN.ry, p[2] / CROWN.rz);
  const twigs = nodes.filter((n) => n.grows && n.radius < TWIG_RADIUS && n.p[1] > CROWN.floor - 1 && (shell(n.p) > 0.5 || n.p[1] > CROWN.center + 1.5));
  const slots: Slot[] = [];
  for (let i = 0; slots.length < slotCount && twigs.length > 0; i++) {
    const n = twigs[i % twigs.length];
    const q = nodes[n.parent].p;
    const t = rand();
    const out = norm([n.p[0], (n.p[1] - CROWN.center) * 0.6, n.p[2]]); // away from the heart of the crown
    const dir = norm([out[0] + wobble(1.1), out[1] + wobble(1.1) - 0.25, out[2] + wobble(1.1)]);
    const off = 0.15 + rand() * 0.75;
    slots.push({
      p: [q[0] + (n.p[0] - q[0]) * t + dir[0] * off, q[1] + (n.p[1] - q[1]) * t + dir[1] * off, q[2] + (n.p[2] - q[2]) * t + dir[2] * off],
      dir,
    });
  }
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }

  return { chains, slots };
}

let grown: Tree | null = null;
/** The one tree, grown the first time it's needed. */
export function theTree(): Tree {
  grown ??= growTree();
  return grown;
}
