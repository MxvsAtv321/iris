// Threads of light between related leaves. Each hangs like a strand of silk
// between two branches, strung with small glowing beads, and a pulse of light
// runs along it. A new thread draws itself from one leaf to the other.

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Leaf, Thread } from "../canopy";
import { leafCenter, pageSeconds, slotNoise } from "./places";

const STEPS = 26; // straight pieces per thread
const BEAD_EVERY = 1.3; // meters between beads
const SHOWN = 32; // only the newest threads are drawn, so the crown never turns into a web

const lineVertex = /* glsl */ `
  attribute float aT;
  attribute float aBorn;
  uniform float uTime;
  varying float vShow;
  void main() {
    vShow = smoothstep(aT, aT + 0.04, (uTime - aBorn) / 1.6);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const lineFragment = /* glsl */ `
  varying float vShow;
  void main() {
    gl_FragColor = vec4(vec3(1.0, 0.80, 0.55) * 0.2 * vShow, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const beadVertex = /* glsl */ `
  attribute float aT;
  attribute float aBorn;
  attribute float aSeed;
  uniform float uTime;
  uniform float uScale;
  varying float vGlow;
  void main() {
    float show = smoothstep(aT, aT + 0.04, (uTime - aBorn) / 1.6);
    // A pulse of light travels the thread every few seconds.
    float pulse = smoothstep(0.08, 0.0, abs(fract(uTime * 0.13 + aSeed) - aT));
    vGlow = show * (0.7 + 2.0 * pulse);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = show * (0.11 + 0.10 * pulse) * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const beadFragment = /* glsl */ `
  varying float vGlow;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    gl_FragColor = vec4(vec3(1.0, 0.84, 0.58) * smoothstep(0.5, 0.05, d) * vGlow, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const shared = { blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false } as const;

export function Threads({ threads, leaves }: { threads: Thread[]; leaves: Leaf[] }) {
  const [lines, beads] = useMemo(() => {
    const byId = new Map(leaves.map((l) => [l.id, l]));
    const linePos: number[] = [];
    const lineT: number[] = [];
    const lineBorn: number[] = [];
    const beadPos: number[] = [];
    const beadT: number[] = [];
    const beadBorn: number[] = [];
    const beadSeed: number[] = [];

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const p = new THREE.Vector3();
    const prev = new THREE.Vector3();

    for (const thread of threads.slice(-SHOWN)) {
      const from = byId.get(thread.a);
      const to = byId.get(thread.b);
      if (!from || !to) continue;
      a.set(...leafCenter(from));
      b.set(...leafCenter(to));
      const span = a.distanceTo(b);
      if (span < 0.5) continue;
      // Leaves that were already on the tree show their threads at once.
      const born = thread.born > 0 ? thread.born / 1000 : -100;
      const seed = slotNoise(from.slot, to.slot);
      mid.addVectors(a, b).multiplyScalar(0.5);
      mid.y -= 0.6 + span * 0.16; // sag

      const at = (t: number) => p.copy(a).multiplyScalar((1 - t) * (1 - t)).addScaledVector(mid, 2 * t * (1 - t)).addScaledVector(b, t * t);
      prev.copy(a);
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        at(t);
        linePos.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        lineT.push((i - 1) / STEPS, t);
        lineBorn.push(born, born);
        prev.copy(p);
      }
      const count = Math.max(3, Math.round(span / BEAD_EVERY));
      for (let i = 1; i < count; i++) {
        const t = i / count;
        at(t);
        beadPos.push(p.x, p.y, p.z);
        beadT.push(t);
        beadBorn.push(born);
        beadSeed.push(seed);
      }
    }

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(linePos, 3));
    lineGeo.setAttribute("aT", new THREE.Float32BufferAttribute(lineT, 1));
    lineGeo.setAttribute("aBorn", new THREE.Float32BufferAttribute(lineBorn, 1));
    const beadGeo = new THREE.BufferGeometry();
    beadGeo.setAttribute("position", new THREE.Float32BufferAttribute(beadPos, 3));
    beadGeo.setAttribute("aT", new THREE.Float32BufferAttribute(beadT, 1));
    beadGeo.setAttribute("aBorn", new THREE.Float32BufferAttribute(beadBorn, 1));
    beadGeo.setAttribute("aSeed", new THREE.Float32BufferAttribute(beadSeed, 1));
    return [lineGeo, beadGeo];
  }, [threads, leaves]);

  const lineMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: lineVertex, fragmentShader: lineFragment, uniforms: { uTime: { value: 0 } }, ...shared }), []);
  const beadMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: beadVertex, fragmentShader: beadFragment, uniforms: { uTime: { value: 0 }, uScale: { value: 800 } }, ...shared }), []);

  useEffect(() => () => { lines.dispose(); beads.dispose(); }, [lines, beads]);
  useEffect(() => () => { lineMat.dispose(); beadMat.dispose(); }, [lineMat, beadMat]);

  useFrame((state) => {
    const now = pageSeconds();
    lineMat.uniforms.uTime.value = now;
    beadMat.uniforms.uTime.value = now;
    const cam = state.camera as THREE.PerspectiveCamera;
    beadMat.uniforms.uScale.value = (state.size.height * state.viewport.dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360));
  });

  return (
    <>
      <lineSegments geometry={lines} material={lineMat} frustumCulled={false} renderOrder={2} />
      <points geometry={beads} material={beadMat} frustumCulled={false} renderOrder={2} />
    </>
  );
}
