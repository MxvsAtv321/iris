// Where each moment grows. Moments line a winding path in the order they
// happened. The newest sit by the entrance where the judge starts, and walking
// down the path walks back in time.

export type Vec3 = [number, number, number];

const SPACING = 0.9; // meters between moments along the path
const SIDE = 1.05; // how far from the path's center moments are planted

/** The path's centerline at distance d from the entrance. */
export function pathPoint(d: number): Vec3 {
  return [Math.sin(d * 0.28) * 2.2, 0, -d];
}

/** Position for moment i of n, where n - 1 is the newest. */
export function budPosition(i: number, n: number): Vec3 {
  const d = 2 + (n - 1 - i) * SPACING;
  const [x, , z] = pathPoint(d);
  const side = i % 2 === 0 ? 1 : -1;
  return [x + side * SIDE, 0, z];
}

/** Total path length for n moments, used to size the ground and stones. */
export function pathLength(n: number): number {
  return 2 + Math.max(n, 1) * SPACING + 4;
}

/** Small stable per-moment variation so the garden doesn't look gridded. */
export function jitter(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((h >>> 0) % 1000) / 1000;
}
