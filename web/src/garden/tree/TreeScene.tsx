// The memory garden: one great tree in a dark clearing. Every leaf is a
// moment Iris lived. The view circles slowly; pointing at a leaf shows what
// Iris saw and decided, and when a question finds a memory the view flies to
// its blossom.

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { XROrigin, useXR } from "@react-three/xr";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Canopy, Leaf } from "../canopy";
import { Clearing, ClearingReflection } from "./Clearing";
import { Leaves } from "./Leaves";
import { Threads } from "./Threads";
import { Wood } from "./Wood";
import { leafCenter } from "./places";

/** Where the view rests: low, across the pool, looking up into the crown. */
export const HOME = { target: [0, 9.3, 0] as const, distance: 40, height: 4.2, fov: 42 };

const ORBIT_SPEED = 0.28; // one turn of the tree takes about three and a half minutes
const REACH_PX = 20; // how close the pointer has to be to a leaf to point at it
const GAZE_TARGETS = 80;

type Props = {
  canopy: Canopy;
  /** The leaf to fly to and hold on, or null to circle the tree. */
  focusId: string | null;
  /** The blossom a question found. It pulses. */
  foundId: string | null;
  /** Cardboard drives the camera and the rendering itself. */
  cardboard: boolean;
  /** Draw the tree's standing foliage as well as the real moments. */
  standing: boolean;
  /** The leaf under the pointer changed. x and y are where it is on the page. */
  onHover: (leaf: Leaf | null, x: number, y: number) => void;
  onPick: (leaf: Leaf) => void;
};

/** Sets the view for the tree, circles it, and glides to whatever is in focus. */
function Rig({ focus, holding }: { focus: THREE.Vector3 | null; holding: React.RefObject<boolean> }) {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const goal = useRef<{ target: THREE.Vector3; eye: THREE.Vector3 } | null>(null);
  const hadFocus = useRef(false);

  // The same camera shows an opened moment, so put its lens back on the way out.
  useLayoutEffect(() => {
    const before = { fov: camera.fov, far: camera.far };
    camera.fov = HOME.fov;
    camera.far = 600;
    camera.position.set(0, HOME.height, HOME.distance);
    camera.lookAt(...HOME.target);
    camera.updateProjectionMatrix();
    return () => {
      camera.fov = before.fov;
      camera.far = before.far;
      camera.updateProjectionMatrix();
    };
  }, [camera]);

  useEffect(() => {
    if (focus) {
      // Stand a little way out from the leaf, on the side away from the trunk.
      const out = new THREE.Vector3(focus.x, 0, focus.z);
      if (out.lengthSq() < 4) out.set(camera.position.x, 0, camera.position.z);
      out.normalize();
      const eye = focus.clone().addScaledVector(out, 9).add(new THREE.Vector3(0, 0.8, 0));
      eye.y = Math.max(eye.y, 2);
      goal.current = { target: focus.clone(), eye };
      hadFocus.current = true;
    } else if (hadFocus.current) {
      // Back out to the resting distance on whichever side the view is already on.
      const side = new THREE.Vector3(camera.position.x, 0, camera.position.z).normalize();
      goal.current = { target: new THREE.Vector3(...HOME.target), eye: side.multiplyScalar(HOME.distance).setY(HOME.height) };
      hadFocus.current = false;
    }
  }, [focus, camera]);

  useFrame((_, dt) => {
    if (!controls) return;
    controls.autoRotate = !goal.current && !focus && !holding.current;
    if (!goal.current) return;
    const k = 1 - Math.exp(-2.2 * Math.min(dt, 0.1));
    controls.target.lerp(goal.current.target, k);
    camera.position.lerp(goal.current.eye, k);
    controls.update();
    if (camera.position.distanceTo(goal.current.eye) < 0.05) goal.current = null; // hand control back
  });

  return null;
}

/** Finds the leaf nearest the pointer on screen. Leaves are too small and too many to raycast one by one. */
function Pointing({ leaves, holding, onHover, onPick }: { leaves: Leaf[]; holding: React.RefObject<boolean>; onHover: Props["onHover"]; onPick: Props["onPick"] }) {
  const gl = useThree((s) => s.gl);
  const centers = useMemo(() => {
    const out = new Float32Array(leaves.length * 3);
    leaves.forEach((leaf, i) => out.set(leafCenter(leaf), i * 3));
    return out;
  }, [leaves]);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const hovered = useRef<Leaf | null>(null);
  const shown = useRef({ x: 0, y: 0 });
  const callbacks = useRef({ onHover, onPick });
  callbacks.current = { onHover, onPick };

  useEffect(() => {
    const el = gl.domElement;
    const move = (e: PointerEvent) => (pointer.current = { x: e.clientX, y: e.clientY });
    const leave = () => (pointer.current = null);
    const press = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      down.current = { x: e.clientX, y: e.clientY };
    };
    const release = (e: PointerEvent) => {
      const d = down.current;
      down.current = null;
      // A drag turns the view; only a still click picks a leaf.
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && hovered.current) callbacks.current.onPick(hovered.current);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", press);
    el.addEventListener("pointerup", release);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", press);
      el.removeEventListener("pointerup", release);
    };
  }, [gl]);

  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    const p = pointer.current;
    let best: Leaf | null = null;
    let bestX = 0;
    let bestY = 0;
    if (p && !down.current) {
      const rect = gl.domElement.getBoundingClientRect();
      let bestD = Infinity;
      for (let i = 0; i < leaves.length; i++) {
        v.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]).project(camera);
        if (v.z > 1 || v.z < -1) continue;
        const x = rect.left + ((v.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - v.y) / 2) * rect.height;
        const reach = leaves[i].kind === "blossom" ? REACH_PX * 1.5 : leaves[i].kind === "silent" ? REACH_PX * 0.8 : REACH_PX;
        const d = Math.hypot(x - p.x, y - p.y) / reach;
        if (d < 1 && d < bestD) {
          bestD = d;
          best = leaves[i];
          bestX = x;
          bestY = y;
        }
      }
    } else if (down.current) {
      best = hovered.current; // keep what was under the pointer while the button is down
    }
    holding.current = best !== null;
    // Report a new leaf, or the same leaf moving on screen as the view glides.
    if (best?.id !== hovered.current?.id || (best && Math.hypot(bestX - shown.current.x, bestY - shown.current.y) > 2)) {
      hovered.current = best;
      shown.current = { x: bestX, y: bestY };
      callbacks.current.onHover(best, bestX, bestY);
    }
  });

  return null;
}

export function TreeScene({ canopy, focusId, foundId, cardboard, standing, onHover, onPick }: Props) {
  const inXR = useXR((s) => s.mode !== null);
  const onScreen = !inXR && !cardboard;
  const holding = useRef(false);
  const hoverSlot = useRef(-1);

  const focusLeaf = focusId ? canopy.leaves.find((l) => l.id === focusId) : undefined;
  const focusSlot = focusLeaf?.slot ?? -1;
  const focus = useMemo(() => {
    const leaf = focusSlot >= 0 ? canopy.leaves.find((l) => l.slot === focusSlot) : undefined;
    return leaf ? new THREE.Vector3(...leafCenter(leaf)) : null;
  }, [focusSlot]); // a leaf never moves, so its slot is all that matters
  const foundSlot = canopy.leaves.find((l) => l.id === foundId)?.slot ?? -1;

  // In a headset or Cardboard there's no pointer, so blossoms get something to aim at.
  const gazeTargets = useMemo(
    () => (onScreen ? [] : canopy.leaves.filter((l) => l.kind === "blossom" && l.momentId !== null).slice(-GAZE_TARGETS)),
    [onScreen, canopy.leaves],
  );

  return (
    <>
      <Clearing onScreen={onScreen} />
      <Wood />
      <Leaves leaves={canopy.leaves} hoverSlot={hoverSlot} foundSlot={foundSlot} standing={standing} />
      <Threads threads={canopy.threads} leaves={canopy.leaves} />

      {/* The tree again, upside down under the pool: its reflection. */}
      <group scale={[1, -1, 1]}>
        <ClearingReflection />
        <Wood reflection />
        <Leaves leaves={canopy.leaves} hoverSlot={hoverSlot} foundSlot={foundSlot} standing={standing} reflection />
      </group>

      {gazeTargets.map((leaf) => (
        <mesh key={leaf.id} position={leafCenter(leaf)} userData={{ gazeId: leaf.momentId }} onClick={() => onPick(leaf)}>
          <sphereGeometry args={[1.3, 12, 12]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}

      <XROrigin position={[0, 0.2, HOME.distance - 4]} />

      {onScreen && (
        <>
          <OrbitControls
            makeDefault
            target={HOME.target}
            enablePan={false}
            enableDamping
            autoRotate
            autoRotateSpeed={ORBIT_SPEED}
            minDistance={6}
            maxDistance={58}
            minPolarAngle={0.5}
            maxPolarAngle={Math.PI / 2 + 0.12}
          />
          <Rig focus={focus} holding={holding} />
          <Pointing
            leaves={canopy.leaves}
            holding={holding}
            onHover={(leaf, x, y) => {
              hoverSlot.current = leaf?.slot ?? -1;
              onHover(leaf, x, y);
            }}
            onPick={onPick}
          />
          <EffectComposer multisampling={0}>
            <Bloom mipmapBlur intensity={0.75} luminanceThreshold={0.5} luminanceSmoothing={0.3} radius={0.75} />
            <Vignette offset={0.26} darkness={0.74} />
          </EffectComposer>
        </>
      )}
    </>
  );
}
