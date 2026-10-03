// The memory garden. Night-blue air, a moss floor, a winding stepping-stone
// path, and one bud per moment along it. On a screen the view glides to
// whichever bud is selected. In VR the judge points a controller at the
// ground to teleport, and selecting a bud carries them to it.

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Sparkles } from "@react-three/drei";
import { TeleportTarget, XROrigin, useXR } from "@react-three/xr";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Moment } from "./api";
import { Bud } from "./Bud";
import { budPosition, pathLength, pathPoint, jitter, type Vec3 } from "./layout";
import { getTheme } from "./theme";

const SNAPSHOT_LIMIT = 40; // floating photos are drawn for the newest moments plus any found one

type Props = {
  moments: Moment[];
  foundId: number | null;
  selectedId: number | null;
  onSelect: (m: Moment) => void;
  /** Cardboard drives the camera itself, so orbit controls stay off. */
  cardboard: boolean;
};

function Stones({ length }: { length: number }) {
  const theme = getTheme();
  const mesh = useRef<THREE.InstancedMesh>(null);
  const count = Math.floor(length / 0.45);

  useEffect(() => {
    if (!mesh.current) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
      const d = i * 0.45;
      const [x, , z] = pathPoint(d);
      const r = jitter(String(i));
      q.setFromEuler(new THREE.Euler(0, r * Math.PI, 0));
      m.compose(new THREE.Vector3(x + (r - 0.5) * 0.2, 0.01, z), q, new THREE.Vector3(0.2 + r * 0.07, 1, 0.15 + r * 0.06));
      mesh.current.setMatrixAt(i, m);
    }
    mesh.current.instanceMatrix.needsUpdate = true;
  }, [count]);

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]}>
      <cylinderGeometry args={[1, 1, 0.03, 9]} />
      <meshStandardMaterial color={theme.stone} roughness={1} />
    </instancedMesh>
  );
}

/** Screen mode. Smoothly re-aims the orbit camera at whatever is in focus. */
function ScreenCamera({ focus }: { focus: Vec3 | null }) {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera);
  const goal = useRef<{ target: THREE.Vector3; eye: THREE.Vector3 } | null>(null);

  const first = useRef(true);
  useEffect(() => {
    if (!focus) {
      if (first.current) goal.current = { target: new THREE.Vector3(0, 0.8, -3), eye: new THREE.Vector3(0, 1.5, 1.1) };
      first.current = false;
      return;
    }
    first.current = false;
    const target = new THREE.Vector3(focus[0], 0.9, focus[2]);
    goal.current = { target, eye: target.clone().add(new THREE.Vector3(0.6, 0.9, 2.4)) };
  }, [focus]);

  useFrame((_, dt) => {
    if (!controls || !goal.current) return;
    const k = 1 - Math.exp(-2.5 * dt);
    controls.target.lerp(goal.current.target, k);
    camera.position.lerp(goal.current.eye, k);
    controls.update();
    if (camera.position.distanceTo(goal.current.eye) < 0.02) goal.current = null; // hand control back
  });

  return null;
}

export function GardenScene({ moments, foundId, selectedId, onSelect, cardboard }: Props) {
  const theme = getTheme();
  const inXR = useXR((s) => s.mode !== null);
  const n = moments.length;
  const length = pathLength(n);

  const positions = useMemo(() => moments.map((_, i) => budPosition(i, n)), [moments, n]);
  const focusIndex = moments.findIndex((m) => m.id === (selectedId ?? foundId));
  const focus = focusIndex >= 0 ? positions[focusIndex] : null;

  // In VR, moving the origin moves the judge. Stand just in front of the focused bud.
  const origin = useRef<THREE.Group>(null);
  useEffect(() => {
    if (!inXR || !focus || !origin.current) return;
    origin.current.position.set(focus[0] * 0.6, 0, focus[2] + 1.4);
  }, [inXR, focus]);

  return (
    <>
      <color attach="background" args={[theme.dusk]} />
      <fog attach="fog" args={[theme.dusk, 5, 24]} />
      <hemisphereLight args={[theme.skyLight, theme.ground, 1.4]} />
      <directionalLight position={[3, 6, 2]} intensity={0.5} color={theme.mist} />

      <TeleportTarget onTeleport={(p) => origin.current?.position.set(p.x, 0, p.z)}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -length / 2 + 3]}>
          <circleGeometry args={[Math.max(60, length + 30), 48]} />
          <meshStandardMaterial color={theme.ground} roughness={1} />
        </mesh>
      </TeleportTarget>

      <Stones length={length} />

      {moments.map((m, i) => (
        <Bud
          key={m.id}
          moment={m}
          position={positions[i]}
          found={m.id === foundId}
          selected={m.id === selectedId}
          showSnapshot={i >= n - SNAPSHOT_LIMIT || m.id === foundId || m.id === selectedId}
          onSelect={onSelect}
        />
      ))}

      <Sparkles count={120} scale={[12, 3, length]} position={[0, 1.4, -length / 2 + 2]} size={2.2} speed={0.25} color={theme.glow} opacity={0.5} />

      <XROrigin ref={origin} position={[0, 0, 1.5]} />

      {!inXR && !cardboard && (
        <>
          <OrbitControls makeDefault target={[0, 0.8, -3]} maxPolarAngle={Math.PI / 2.05} minDistance={1} maxDistance={18} />
          <ScreenCamera focus={focus} />
        </>
      )}
    </>
  );
}
