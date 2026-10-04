// Everything around the tree: the night forest behind it, the ground and
// rocks, the shallow pool that mirrors it, the dark trunks that frame it, mist
// at the roots and motes of light in the air. The tree is the only light, so
// the two lights here sit inside it.

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import backdropUrl from "../assets/backdrop.jpg";
import { seeded } from "./grow";
import { pageSeconds } from "./places";

export const NIGHT = "#0a0918"; // the sky straight up
export const HAZE = "#13102a"; // where the ground meets the forest

// ---------------------------------------------------------------- ground

function hash(x: number, z: number) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function bumps(x: number, z: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const w = zf * zf * (3 - 2 * zf);
  return (hash(xi, zi) * (1 - u) + hash(xi + 1, zi) * u) * (1 - w) + (hash(xi, zi + 1) * (1 - u) + hash(xi + 1, zi + 1) * u) * w;
}

/** Ground height. Above 0 is land, below is under the pool: a mound at the roots, shallows around it, shore beyond. */
export function groundHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const mound = 2.0 * Math.exp(-(r * r) / 110);
  const shore = THREE.MathUtils.smoothstep(r, 42, 56) * 2.4;
  const rough = (bumps(x * 0.11, z * 0.11) - 0.5) * 1.7 + (bumps(x * 0.37, z * 0.37) - 0.5) * 0.6;
  return -0.7 + mound + shore + rough * (0.35 + 0.65 * THREE.MathUtils.smoothstep(r, 8, 26));
}

const WATERLINE = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.03)];
const UNDERWATER = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 0.03)];

/** The land. Its reflection is the same land upside down, kept only below the waterline. */
function Ground({ reflection = false }: { reflection?: boolean }) {
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(340, 340, 200, 200);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, groundHeight(pos.getX(i), pos.getZ(i)));
    g.computeVertexNormals();
    return g;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  // Nothing is drawn below the waterline, so the tree's reflection shows through the pool.
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color={reflection ? "#0c0a12" : "#1b1724"} roughness={0.95} clippingPlanes={reflection ? UNDERWATER : WATERLINE} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Rocks({ reflection = false }: { reflection?: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const count = 90;
  // A lumpy boulder: a ball pushed in and out by the same noise as the ground.
  const geometry = useMemo(() => {
    const g = new THREE.IcosahedronGeometry(1, 3);
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const k = 0.78 + 0.34 * bumps(x * 1.7 + y * 2.3 + 5, z * 1.7 - y * 1.1 + 9);
      pos.setXYZ(i, x * k, y * k, z * k);
    }
    g.computeVertexNormals();
    return g;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => {
    if (!mesh.current) return;
    const rand = seeded(31);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      // Kept clear of the ring the view circles on, so no boulder ever fills the screen.
      const r = rand() < 0.72 ? 9 + rand() * 23 : 48 + rand() * 14;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const s = 0.35 + rand() * rand() * 1.5;
      q.setFromEuler(e.set(rand() * 3, rand() * 3, rand() * 3));
      m.compose(new THREE.Vector3(x, Math.max(groundHeight(x, z), 0) - s * 0.15, z), q, new THREE.Vector3(s * (0.9 + rand() * 0.9), s * (0.35 + rand() * 0.3), s * (0.9 + rand() * 0.9)));
      mesh.current.setMatrixAt(i, m);
    }
    mesh.current.instanceMatrix.needsUpdate = true;
  }, []);
  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, count]} frustumCulled={false}>
      <meshStandardMaterial color={reflection ? "#0c0a12" : "#17131e"} roughness={0.9} clippingPlanes={reflection ? UNDERWATER : undefined} side={reflection ? THREE.DoubleSide : THREE.FrontSide} />
    </instancedMesh>
  );
}

/**
 * The shallow pool: a dark, half-clear sheet at the waterline. The scene draws
 * a second, upside-down tree beneath it, which reads as the reflection and
 * costs far less than re-rendering the scene into a mirror.
 */
function Pool() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[160, 64]} />
      <meshBasicMaterial color="#090814" transparent opacity={0.42} depthWrite={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------- glow

const glowVertex = /* glsl */ `
  attribute vec4 aGlow; // x, y, z, size
  attribute vec4 aTint; // r, g, b, strength
  varying vec2 vUv;
  varying vec4 vTint;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(aGlow.xyz, 1.0);
    // Up close the glow would only wash out the bark and leaves, so it fades as the viewer nears.
    vTint = vec4(aTint.rgb, aTint.a * smoothstep(10.0, 34.0, -mv.z));
    mv.xy += position.xy * aGlow.w;
    gl_Position = projectionMatrix * mv;
  }
`;
const glowFragment = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vTint;
  void main() {
    float soft = smoothstep(0.5, 0.0, length(vUv - 0.5));
    gl_FragColor = vec4(vTint.rgb * soft * soft * vTint.a, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// The light the tree gives off into the air around it: gold from the wood, violet from the crown.
const GLOWS: [x: number, y: number, z: number, size: number, r: number, g: number, b: number, strength: number][] = [
  [0, 7.5, 0, 24, 1.0, 0.60, 0.28, 0.08],
  [-8, 10.5, 1, 20, 1.0, 0.62, 0.32, 0.06],
  [8, 11, -1.5, 20, 1.0, 0.62, 0.32, 0.06],
  [0, 1.5, 0, 20, 1.0, 0.6, 0.32, 0.07],
  [0, 13, 0, 58, 0.5, 0.3, 1.0, 0.055],
];

function Glows() {
  const geometry = useMemo(() => {
    const card = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = card.index;
    g.setAttribute("position", card.getAttribute("position"));
    g.setAttribute("uv", card.getAttribute("uv"));
    g.setAttribute("aGlow", new THREE.InstancedBufferAttribute(new Float32Array(GLOWS.flatMap((v) => v.slice(0, 4))), 4));
    g.setAttribute("aTint", new THREE.InstancedBufferAttribute(new Float32Array(GLOWS.flatMap((v) => v.slice(4))), 4));
    g.instanceCount = GLOWS.length;
    return g;
  }, []);
  const material = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: glowVertex, fragmentShader: glowFragment, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, toneMapped: false }),
    [],
  );
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={-0.5} />;
}

// ---------------------------------------------------------------- forest

/**
 * The two dark trunks at the edges of the view. They stand between the viewer
 * and the tree and keep to the viewer's side as the view circles, so the tree
 * is always framed by forest and never hidden behind it.
 */
function FrameTrunks({ follow }: { follow: boolean }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    if (follow && group.current) group.current.rotation.y = Math.atan2(camera.position.x, camera.position.z);
  });
  return (
    <group ref={group}>
      <mesh position={[-10.9, 34, 28]} rotation={[0, 0, 0.035]}>
        <cylinderGeometry args={[0.3, 0.44, 72, 12, 1, true]} />
        <meshStandardMaterial color="#0d0b12" roughness={1} />
      </mesh>
      <mesh position={[12.0, 34, 27]} rotation={[0, 0, -0.05]}>
        <cylinderGeometry args={[0.26, 0.38, 72, 12, 1, true]} />
        <meshStandardMaterial color="#0d0b12" roughness={1} />
      </mesh>
    </group>
  );
}

function ForestTrunks() {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const count = 34;
  useEffect(() => {
    if (!mesh.current) return;
    const rand = seeded(53);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const put = (i: number, angle: number, distance: number, radius: number) => {
      const x = Math.sin(angle) * distance;
      const z = Math.cos(angle) * distance;
      q.setFromEuler(e.set((rand() - 0.5) * 0.12, rand() * 6, (rand() - 0.5) * 0.12));
      m.compose(new THREE.Vector3(x, 34, z), q, new THREE.Vector3(radius, 1, radius));
      mesh.current!.setMatrixAt(i, m);
    };
    for (let i = 0; i < count; i++) put(i, rand() * Math.PI * 2, 54 + rand() * 50, 0.8 + rand() * 1.3);
    mesh.current.instanceMatrix.needsUpdate = true;
  }, []);
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} frustumCulled={false}>
      <cylinderGeometry args={[0.72, 1.1, 72, 10, 1, true]} />
      <meshStandardMaterial color="#120f18" roughness={1} />
    </instancedMesh>
  );
}

const backdropVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const backdropFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uNight;
  uniform vec3 uHaze;
  varying vec2 vUv;
  void main() {
    // The picture wraps the clearing twice, mirrored, so it has no seam.
    vec3 col = texture2D(uMap, vec2(vUv.x * 2.0, vUv.y)).rgb * 1.0;
    col = mix(col, uNight, smoothstep(0.80, 1.0, vUv.y));
    col = mix(uHaze, col, smoothstep(0.0, 0.16, vUv.y));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** The generated night forest, wrapped around the clearing as a far wall. */
function Backdrop() {
  const map = useTexture(backdropUrl, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.MirroredRepeatWrapping;
  });
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: backdropVertex,
        fragmentShader: backdropFragment,
        uniforms: { uMap: { value: map }, uNight: { value: new THREE.Color(NIGHT) }, uHaze: { value: new THREE.Color(HAZE) } },
        side: THREE.BackSide,
        depthWrite: false,
        toneMapped: false,
      }),
    [map],
  );
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh position={[0, 68, 0]} material={material} renderOrder={-1}>
      <cylinderGeometry args={[170, 170, 158, 64, 1, true]} />
    </mesh>
  );
}

// ---------------------------------------------------------------- air

const mistVertex = /* glsl */ `
  attribute vec4 aPuff; // angle, distance, height, size
  attribute vec2 aDrift; // speed, seed
  uniform float uTime;
  varying vec2 vUv;
  varying float vWarm;
  varying float vSeed;
  void main() {
    vUv = uv;
    vSeed = aDrift.y;
    float angle = aPuff.x + uTime * aDrift.x;
    float dist = aPuff.y + sin(uTime * 0.05 + aDrift.y * 20.0) * 1.5;
    vec3 center = vec3(cos(angle) * dist, aPuff.z + sin(uTime * 0.11 + aDrift.y * 9.0) * 0.3, sin(angle) * dist);
    vWarm = 1.0 - smoothstep(3.0, 16.0, dist);
    vec4 mv = modelViewMatrix * vec4(center, 1.0);
    mv.xy += position.xy * aPuff.w * vec2(1.0, 0.42);
    gl_Position = projectionMatrix * mv;
  }
`;
const mistFragment = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vWarm;
  varying float vSeed;
  void main() {
    vec2 p = vUv - 0.5;
    float soft = smoothstep(0.5, 0.0, length(p));
    soft *= soft * (0.75 + 0.25 * sin(p.x * 9.0 + uTime * 0.2 + vSeed * 30.0));
    vec3 col = mix(vec3(0.42, 0.36, 0.72), vec3(0.95, 0.72, 0.55), vWarm * 0.7);
    gl_FragColor = vec4(col * soft * 0.034, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Low mist pooling around the roots and out over the water, lit by the tree. */
function Mist() {
  const count = 70;
  const geometry = useMemo(() => {
    const card = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = card.index;
    g.setAttribute("position", card.getAttribute("position"));
    g.setAttribute("uv", card.getAttribute("uv"));
    const puff = new Float32Array(count * 4);
    const drift = new Float32Array(count * 2);
    const rand = seeded(11);
    for (let i = 0; i < count; i++) {
      const dist = 3 + rand() * rand() * 30;
      puff.set([rand() * Math.PI * 2, dist, 0.3 + rand() * 1.5, 12 + rand() * 13], i * 4);
      drift.set([(rand() - 0.5) * 0.02, rand()], i * 2);
    }
    g.setAttribute("aPuff", new THREE.InstancedBufferAttribute(puff, 4));
    g.setAttribute("aDrift", new THREE.InstancedBufferAttribute(drift, 2));
    g.instanceCount = count;
    return g;
  }, []);
  const material = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: mistVertex, fragmentShader: mistFragment, uniforms: { uTime: { value: 0 } }, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }),
    [],
  );
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  useFrame(() => {
    material.uniforms.uTime.value = pageSeconds();
  });
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={3} />;
}

const moteVertex = /* glsl */ `
  attribute vec4 aMote; // rise speed, seed, size, warmth
  uniform float uTime;
  uniform float uScale;
  varying float vWarm;
  varying float vTwinkle;
  void main() {
    float seed = aMote.y;
    vec3 p = position;
    p.y = mod(p.y + uTime * aMote.x, 26.0);
    p.x += sin(uTime * 0.21 + seed * 40.0) * 1.2;
    p.z += cos(uTime * 0.17 + seed * 23.0) * 1.2;
    vWarm = aMote.w;
    vTwinkle = (0.55 + 0.45 * sin(uTime * (0.8 + seed) + seed * 70.0)) * smoothstep(0.0, 2.0, p.y) * (1.0 - smoothstep(21.0, 26.0, p.y));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = min(aMote.z * uScale / -mv.z, 26.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const moteFragment = /* glsl */ `
  varying float vWarm;
  varying float vTwinkle;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    vec3 col = mix(vec3(0.70, 0.55, 1.0), vec3(1.0, 0.76, 0.40), vWarm);
    gl_FragColor = vec4(col * smoothstep(0.5, 0.0, d) * vTwinkle * 1.5, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Motes of light drifting slowly up through the clearing. */
function Motes() {
  const count = 650;
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const mote = new Float32Array(count * 4);
    const rand = seeded(97);
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * 38;
      pos.set([Math.cos(a) * r, rand() * 26, Math.sin(a) * r], i * 3);
      mote.set([0.12 + rand() * 0.3, rand(), 0.1 + rand() * 0.16, rand() < 0.55 ? 1 : 0], i * 4);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aMote", new THREE.BufferAttribute(mote, 4));
    return g;
  }, []);
  const material = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: moteVertex, fragmentShader: moteFragment, uniforms: { uTime: { value: 0 }, uScale: { value: 800 } }, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }),
    [],
  );
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  useFrame((state) => {
    material.uniforms.uTime.value = pageSeconds();
    const cam = state.camera as THREE.PerspectiveCamera;
    material.uniforms.uScale.value = (state.size.height * state.viewport.dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360));
  });
  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={3} />;
}

/** The land and rocks as the pool reflects them. Goes inside the upside-down copy of the tree. */
export function ClearingReflection() {
  return (
    <>
      <Ground reflection />
      <Rocks reflection />
    </>
  );
}

// ---------------------------------------------------------------- all of it

/** `onScreen` is false in a headset or Cardboard, where the framing trunks stay put instead of following the view. */
export function Clearing({ onScreen }: { onScreen: boolean }) {
  return (
    <>
      <color attach="background" args={[NIGHT]} />
      <fog attach="fog" args={[HAZE, 60, 210]} />
      <ambientLight intensity={0.05} color="#8f86c8" />
      <pointLight position={[0, 13, 0]} color="#b79cff" intensity={900} distance={160} decay={2} />
      <pointLight position={[0, 3.2, 0]} color="#ffb362" intensity={420} distance={70} decay={2} />

      <Backdrop />
      <Ground />
      <Pool />
      <Glows />
      <Rocks />
      <ForestTrunks />
      <FrameTrunks follow={onScreen} />
      <Mist />
      <Motes />
    </>
  );
}
