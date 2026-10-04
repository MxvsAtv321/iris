// Every leaf and blossom, drawn in two draw calls: one for the tree's standing
// foliage and one for the moments Iris lived. Each leaf is a small textured
// card whose glow adds to whatever is behind it, so thousands can overlap
// without sorting. Growth, sway, the gold-to-violet cooling of a new leaf and
// the pulse of a blossom all happen in the shader, so nothing per-leaf runs
// on the CPU each frame.

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import type { Leaf, LeafKind } from "../canopy";
import leafUrl from "../assets/leaf.jpg";
import blossomUrl from "../assets/blossom.jpg";
import { theTree } from "./grow";
import { LEAF_SIZE, REAL_SLOTS, TOTAL_SLOTS, pageSeconds, slotNoise } from "./places";

const KIND_CODE: Record<LeafKind, number> = { silent: 1, display: 2, speak: 3, blossom: 4 };
const STANDING = 0; // the tree's own foliage
const LIVE = 8; // added to the kind when a leaf sprouted while the page was open
const INTRO_S = 3.5; // leaves already on the tree unfurl over this long when the page opens

const vertexShader = /* glsl */ `
  attribute vec3 aPos;
  attribute vec4 aQuat;
  attribute vec4 aLeaf; // size, kind, born, seed
  uniform float uTime;
  uniform float uRipple;
  uniform vec2 uHot;
  varying vec2 vUv;
  varying float vKind;
  varying float vWarm;
  varying float vSeed;
  varying float vHot;
  varying float vInner;

  vec3 turn(vec3 v, vec4 q) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

  void main() {
    float kind = mod(aLeaf.y, 8.0);
    float live = step(7.5, aLeaf.y);
    float seed = aLeaf.w;
    float age = uTime - aLeaf.z;

    // Unfurl with a little overshoot, like the bud popping open.
    float t = clamp(age / 1.8, 0.0, 1.0);
    float grown = (1.0 - pow(1.0 - t, 3.0)) * (1.0 + 0.22 * sin(t * 3.14159));
    float id = float(gl_InstanceID);
    vHot = max(step(abs(id - uHot.x), 0.5), step(abs(id - uHot.y), 0.5) * (0.6 + 0.4 * sin(uTime * 4.0)));
    float size = aLeaf.x * grown * (1.0 + 0.35 * vHot);

    // How deep inside the crown this leaf is: 1 by the limbs, 0 at the outer edge.
    vInner = 1.0 - smoothstep(0.45, 0.95, length((aPos - vec3(0.0, 12.5, 0.0)) / vec3(23.0, 8.0, 18.0)));
    vUv = uv;
    vKind = kind;
    vSeed = seed;
    vWarm = live * exp(-max(age - 1.2, 0.0) / 5.0); // a new leaf starts gold and cools

    // In the pool's reflection the whole tree wavers a little.
    vec3 at = aPos + vec3(sin(aPos.y * 2.3 + uTime * 1.1 + aPos.z) * 0.22 * uRipple, 0.0, 0.0);
    vec4 mv;
    if (kind > 3.5) {
      // Blossoms always face the viewer and breathe.
      mv = modelViewMatrix * vec4(at, 1.0);
      float breathe = 1.0 + 0.07 * sin(uTime * 1.2 + seed * 40.0);
      float c = cos(seed * 6.283), s = sin(seed * 6.283);
      vec2 p = (position.xy - vec2(0.0, 0.5)) * vec2(1.5, 1.0);
      mv.xy += vec2(p.x * c - p.y * s, p.x * s + p.y * c) * size * breathe;
    } else {
      vec3 p = vec3(position.xy, 0.0);
      p.x += sin(uTime * 0.9 + seed * 50.0) * 0.10 * p.y;
      p.z += cos(uTime * 0.7 + seed * 31.0) * 0.16 * p.y;
      mv = modelViewMatrix * vec4(at + turn(p * size, aQuat), 1.0);
    }
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uLeaf;
  uniform sampler2D uBlossom;
  uniform float uTime;
  uniform float uDim;
  varying vec2 vUv;
  varying float vKind;
  varying float vWarm;
  varying float vSeed;
  varying float vHot;
  varying float vInner;

  void main() {
    vec3 col;
    if (vKind > 3.5) {
      vec3 tex = texture2D(uBlossom, vUv).rgb;
      float d = distance(vUv, vec2(0.5));
      col = tex * 1.2 + vec3(1.0, 0.70, 0.34) * exp(-d * d * 14.0) * 0.28;
      col *= 1.0 + vWarm * 1.5;
    } else {
      vec3 tex = texture2D(uLeaf, vUv).rgb;
      float body = max(tex.r, max(tex.g, tex.b));
      // 0 standing foliage, 1 stayed silent, 2 showed a line, 3 spoke
      float bright = vKind < 0.5 ? 0.46 : vKind < 1.5 ? 0.62 : vKind < 2.5 ? 1.25 : 2.1;
      vec3 violet = mix(vec3(0.34, 0.16, 1.0), vec3(0.62, 0.26, 0.95), vSeed);
      // Deep in the crown the leaves catch the gold light of the wood and the blossoms.
      if (vKind < 1.5) {
        violet = mix(violet, vec3(1.0, 0.62, 0.36), vInner * 0.5);
        bright *= 1.0 + vInner * 0.9;
      }
      if (vKind < 1.5) violet = mix(violet, vec3(0.72, 0.70, 0.95), 0.45); // faint leaves are frosted, not vivid
      vec3 cool = mix(violet * body * body, tex, vKind > 1.5 ? 0.55 : 0.12) * bright;
      vec3 gold = vec3(1.0, 0.70, 0.30) * body * 3.2;
      col = mix(cool, gold, vWarm);
      // Shimmer: every leaf breathes a little, and now and then one catches the light.
      float glint = pow(max(0.0, sin(uTime * (0.35 + vSeed * 0.9) + vSeed * 90.0)), 14.0);
      col *= 0.72 + 0.16 * sin(uTime * (0.6 + vSeed * 1.6) + vSeed * 50.0) + 3.2 * glint;
    }
    col *= 1.0 + vHot * (vKind > 3.5 ? 0.6 : 1.6);
    gl_FragColor = vec4(col * uDim, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** One card, stem at the origin, as wide as the leaf picture is. */
function leafGeometry(count: number) {
  const card = new THREE.PlaneGeometry(0.667, 1);
  card.translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = card.index;
  g.setAttribute("position", card.getAttribute("position"));
  g.setAttribute("uv", card.getAttribute("uv"));
  g.setAttribute("aPos", new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute("aQuat", new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4));
  g.setAttribute("aLeaf", new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4));
  g.instanceCount = count;
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);
const q = new THREE.Quaternion();
const spin = new THREE.Quaternion();
const v = new THREE.Vector3();

/** Writes one leaf into instance `i`: it grows from `slot`, pointing the way the slot points. */
function place(g: THREE.InstancedBufferGeometry, i: number, slot: number, size: number, kind: number, born: number) {
  const { p, dir } = theTree().slots[slot];
  const seed = slotNoise(slot);
  q.setFromUnitVectors(UP, v.set(dir[0], dir[1], dir[2]));
  q.multiply(spin.setFromAxisAngle(UP, seed * Math.PI * 2));
  (g.getAttribute("aPos") as THREE.InstancedBufferAttribute).setXYZ(i, p[0], p[1], p[2]);
  (g.getAttribute("aQuat") as THREE.InstancedBufferAttribute).setXYZW(i, q.x, q.y, q.z, q.w);
  (g.getAttribute("aLeaf") as THREE.InstancedBufferAttribute).setXYZW(i, size, kind, born, seed);
}

function leafMaterial(leaf: THREE.Texture, blossom: THREE.Texture) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { uLeaf: { value: leaf }, uBlossom: { value: blossom }, uTime: { value: 0 }, uHot: { value: new THREE.Vector2(-1, -1) }, uDim: { value: 1 }, uRipple: { value: 0 } },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    transparent: true,
    toneMapped: false,
  });
}

// The page's first look at the tree: everything already on it unfurls once.
let introAt: number | null = null;

type Props = {
  leaves: Leaf[];
  /** Slot under the pointer, or -1. A ref, so pointing at a leaf doesn't re-render the scene. */
  hoverSlot: React.RefObject<number>;
  /** Slot of the blossom a question found, or -1. It pulses. */
  foundSlot: number;
  /** Draw the tree's standing foliage. Off, only real moments have leaves. */
  standing: boolean;
  /** This copy is the tree's reflection in the pool: dimmer, wavering, and no sparks. */
  reflection?: boolean;
};

export function Leaves({ leaves, hoverSlot, foundSlot, standing, reflection = false }: Props) {
  const [leafTex, blossomTex] = useTexture([leafUrl, blossomUrl], (loaded) => {
    for (const t of loaded) t.colorSpace = THREE.SRGBColorSpace;
  });
  introAt ??= pageSeconds();
  const intro = introAt;

  const standingMat = useMemo(() => leafMaterial(leafTex, blossomTex), [leafTex, blossomTex]);
  const realMat = useMemo(() => leafMaterial(leafTex, blossomTex), [leafTex, blossomTex]);

  const standingGeo = useMemo(() => {
    const count = TOTAL_SLOTS - REAL_SLOTS;
    const g = leafGeometry(count);
    for (let i = 0; i < count; i++) {
      const slot = REAL_SLOTS + i;
      place(g, i, slot, 0.36 + slotNoise(slot, 1) * 0.44, STANDING, intro + slotNoise(slot, 2) * INTRO_S);
    }
    return g;
  }, [intro]);

  const realGeo = useMemo(() => leafGeometry(REAL_SLOTS), []);
  useEffect(() => {
    const attr = realGeo.getAttribute("aLeaf") as THREE.InstancedBufferAttribute;
    (attr.array as Float32Array).fill(0);
    for (const leaf of leaves) {
      const live = leaf.born > 0;
      const born = live ? leaf.born / 1000 : intro + slotNoise(leaf.slot, 2) * INTRO_S;
      const size = LEAF_SIZE[leaf.kind] * (0.9 + slotNoise(leaf.slot, 1) * 0.25);
      place(realGeo, leaf.slot, leaf.slot, size, KIND_CODE[leaf.kind] + (live ? LIVE : 0), born);
    }
    for (const name of ["aPos", "aQuat", "aLeaf"]) realGeo.getAttribute(name).needsUpdate = true;
  }, [leaves, realGeo, intro]);

  useEffect(() => () => { standingGeo.dispose(); realGeo.dispose(); }, [standingGeo, realGeo]);
  useEffect(() => () => { standingMat.dispose(); realMat.dispose(); }, [standingMat, realMat]);

  useFrame(() => {
    const now = pageSeconds();
    for (const m of [standingMat, realMat]) {
      m.uniforms.uTime.value = now;
      m.uniforms.uDim.value = reflection ? 0.6 : 1;
      m.uniforms.uRipple.value = reflection ? 1 : 0;
    }
    realMat.uniforms.uHot.value.set(hoverSlot.current, foundSlot);
  });

  return (
    <>
      {standing && <mesh geometry={standingGeo} material={standingMat} frustumCulled={false} />}
      <mesh geometry={realGeo} material={realMat} frustumCulled={false} renderOrder={1} />
      {!reflection && <Sparks leaves={leaves} />}
    </>
  );
}

// ---------------------------------------------------------------- sparks

const SPARKS = 480;
const PER_SPROUT = 12;

const sparkVertex = /* glsl */ `
  attribute vec3 aDrift;
  attribute float aBorn;
  attribute float aSize;
  uniform float uTime;
  uniform float uScale;
  varying float vLife;
  void main() {
    float age = uTime - aBorn;
    vLife = 1.0 - clamp(age / 2.2, 0.0, 1.0);
    vec3 p = position + aDrift * (1.0 - exp(-age * 1.6)) + vec3(0.0, 0.25 * age, 0.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = step(0.0, age) * vLife * aSize * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const sparkFragment = /* glsl */ `
  varying float vLife;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    gl_FragColor = vec4(vec3(1.0, 0.74, 0.34) * smoothstep(0.5, 0.0, d) * vLife * 3.0, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** A small burst of gold motes each time a leaf sprouts. */
function Sparks({ leaves }: { leaves: Leaf[] }) {
  const next = useRef(0);
  const seen = useRef<Set<string> | null>(null);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    g.setAttribute("aDrift", new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    g.setAttribute("aBorn", new THREE.BufferAttribute(new Float32Array(SPARKS).fill(-100), 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(SPARKS), 1));
    return g;
  }, []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: sparkVertex,
        fragmentShader: sparkFragment,
        uniforms: { uTime: { value: 0 }, uScale: { value: 800 } },
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        toneMapped: false,
      }),
    [],
  );
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);

  useEffect(() => {
    const first = seen.current === null;
    seen.current ??= new Set();
    const now = pageSeconds();
    let wrote = false;
    for (const leaf of leaves) {
      if (seen.current.has(leaf.id)) continue;
      seen.current.add(leaf.id);
      // Only leaves that just sprouted, not the ones already there when the scene appeared.
      if (first || leaf.born === 0 || now - leaf.born / 1000 > 2) continue;
      const { p } = theTree().slots[leaf.slot];
      for (let k = 0; k < PER_SPROUT; k++) {
        const i = next.current++ % SPARKS;
        const a = Math.random() * Math.PI * 2;
        const up = Math.random() * 2 - 0.6;
        // The first mote stays put and is large: the flare of the bud opening. The rest scatter.
        const far = k === 0 ? 0 : 0.5 + Math.random() * 1.1;
        (geo.getAttribute("position") as THREE.BufferAttribute).setXYZ(i, p[0], p[1], p[2]);
        (geo.getAttribute("aDrift") as THREE.BufferAttribute).setXYZ(i, Math.cos(a) * far, up * far, Math.sin(a) * far);
        (geo.getAttribute("aBorn") as THREE.BufferAttribute).setX(i, k === 0 ? now : now + 0.5 + Math.random() * 0.6);
        (geo.getAttribute("aSize") as THREE.BufferAttribute).setX(i, k === 0 ? 1.5 : 0.22);
        wrote = true;
      }
    }
    if (wrote) for (const name of ["position", "aDrift", "aBorn", "aSize"]) geo.getAttribute(name).needsUpdate = true;
  }, [leaves, geo]);

  useFrame((state) => {
    mat.uniforms.uTime.value = pageSeconds();
    const cam = state.camera as THREE.PerspectiveCamera;
    mat.uniforms.uScale.value = (state.size.height * state.viewport.dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360));
  });

  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={2} />;
}
