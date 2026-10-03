// One moment in the garden. A stem with a glowing bulb, and above it a small
// floating snapshot. The bud a search found turns pollen-gold and pulses, and
// the selected bud opens its petals.

import { Suspense, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard, useTexture } from "@react-three/drei";
import * as THREE from "three";
import type { Moment } from "./api";
import { jitter, type Vec3 } from "./layout";
import { getTheme } from "./theme";
import { SafeBoundary } from "./SafeBoundary";

const PETALS = 7;

type Props = {
  moment: Moment;
  position: Vec3;
  found: boolean;
  selected: boolean;
  showSnapshot: boolean;
  onSelect: (m: Moment) => void;
};

function Snapshot({ url, y }: { url: string; y: number }) {
  const theme = getTheme();
  const tex = useTexture(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  const img = tex.image as { width: number; height: number };
  const w = 0.46;
  const h = (w * img.height) / img.width;
  return (
    <Billboard position={[0, y + h / 2 + 0.12, 0]}>
      <mesh>
        <planeGeometry args={[w + 0.03, h + 0.03]} />
        <meshBasicMaterial color={theme.glow} transparent opacity={0.35} />
      </mesh>
      <mesh position={[0, 0, 0.002]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </Billboard>
  );
}

export function Bud({ moment, position, found, selected, showSnapshot, onSelect }: Props) {
  const theme = getTheme();
  const glow = useMemo(() => new THREE.Color(theme.glow), [theme.glow]);
  const pollen = useMemo(() => new THREE.Color(theme.pollen), [theme.pollen]);
  const j = jitter(String(moment.id));
  const stemHeight = 0.55 + j * 0.45;
  const bulb = useRef<THREE.Mesh>(null);
  const petals = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (bulb.current) {
      const pulse = found ? 1 + Math.sin(t * 3.2) * 0.18 : 1 + Math.sin(t * 1.1 + j * 6) * 0.04;
      const target = (hovered ? 1.25 : 1) * pulse * (found ? 1.5 : 1);
      bulb.current.scale.setScalar(THREE.MathUtils.damp(bulb.current.scale.x, target, 8, dt));
      const mat = bulb.current.material as THREE.MeshStandardMaterial;
      mat.emissive.lerp(found || selected ? pollen : glow, 1 - Math.exp(-6 * dt));
      mat.emissiveIntensity = found ? 2.2 : 1.2;
    }
    if (petals.current) {
      const open = selected || found ? 1 : 0;
      const s = THREE.MathUtils.damp(petals.current.scale.x, open, 4, dt);
      petals.current.scale.setScalar(Math.max(s, 0.0001));
      petals.current.rotation.y += dt * 0.3;
    }
  });

  return (
    <group position={position} rotation={[0, j * Math.PI * 2, 0]}>
      <mesh position={[0, stemHeight / 2, 0]}>
        <cylinderGeometry args={[0.012, 0.018, stemHeight, 6]} />
        <meshStandardMaterial color={theme.stem} roughness={0.9} />
      </mesh>

      <group position={[0, stemHeight, 0]}>
        <mesh
          ref={bulb}
          userData={{ gazeId: moment.id }}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(moment);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(true);
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => {
            setHovered(false);
            document.body.style.cursor = "";
          }}
        >
          <sphereGeometry args={[0.085, 20, 16]} />
          <meshStandardMaterial color={theme.duskDeep} emissive={glow} emissiveIntensity={1.2} roughness={0.4} />
        </mesh>

        <group ref={petals} scale={0.0001}>
          {Array.from({ length: PETALS }, (_, k) => (
            <mesh key={k} rotation={[0, (k / PETALS) * Math.PI * 2, 0.95]} position={[0, 0.02, 0]}>
              <sphereGeometry args={[0.07, 12, 8]} />
              <meshStandardMaterial
                color={theme.pollen}
                emissive={theme.pollen}
                emissiveIntensity={0.35}
                transparent
                opacity={0.85}
              />
            </mesh>
          ))}
        </group>
        {/* invisible larger hit area, easier to target with a controller ray */}
        <mesh
          visible={false}
          userData={{ gazeId: moment.id }}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(moment);
          }}
        >
          <sphereGeometry args={[0.2, 8, 6]} />
        </mesh>
      </group>

      {showSnapshot && (
        <SafeBoundary>
          <Suspense fallback={null}>
            <Snapshot url={moment.image_url} y={stemHeight} />
          </Suspense>
        </SafeBoundary>
      )}
    </group>
  );
}
