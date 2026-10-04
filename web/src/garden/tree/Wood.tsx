// The trunk, limbs, branches and roots as one mesh. The bark is a generated
// texture whose cracks glow gold; the shader finds those cracks and sends a
// slow pulse of light up through them, strongest in the thick wood, so the
// tree looks lit from inside.

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import barkUrl from "../assets/bark.jpg";
import { theTree, type Chain, type Vec3 } from "./grow";
import { pageSeconds } from "./places";

const BARK_TILE = 7; // meters of wood one copy of the bark picture covers

const vertexShader = /* glsl */ `
  attribute float aAlong;
  attribute float aRadius;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying float vAlong;
  varying float vRadius;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vAlong = aAlong;
    vRadius = aRadius;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uBark;
  uniform float uTime;
  uniform float uReflection;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying float vAlong;
  varying float vRadius;
  #include <fog_pars_fragment>
  void main() {
    // A reflection only exists below the waterline.
    if (uReflection > 0.5 && vPosW.y > 0.0) discard;
    vec3 bark = texture2D(uBark, vUv).rgb;
    float lum = dot(bark, vec3(0.299, 0.587, 0.114));
    // Warm, bright parts of the bark picture are the cracks where light gets out.
    float vein = smoothstep(0.06, 0.36, bark.r - bark.b) * smoothstep(0.18, 0.5, lum);

    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5);
    float thick = smoothstep(0.08, 1.4, vRadius);

    // The crown lights the wood from above in violet, the blossoms from all around in gold.
    vec3 wood = mix(bark, vec3(lum), 0.15) * (0.55 + 0.9 * lum); // deepen the furrows
    vec3 lit = wood * (vec3(0.55, 0.45, 0.85) * (0.12 + 0.4 * (N.y * 0.5 + 0.5)) + vec3(1.0, 0.72, 0.42) * 0.3);
    lit += vec3(0.60, 0.45, 0.95) * rim * 0.16;
    lit += vec3(1.0, 0.66, 0.34) * (1.0 - thick) * 0.05; // thin branches sit among the leaves

    float flow = 0.62 + 0.38 * sin(vAlong * 0.7 - uTime * 0.9 + sin(vPosW.x * 0.7 + vPosW.z * 0.9) * 1.5);
    // A blurred copy of the bark spreads each crack's light onto the wood around it.
    vec3 soft = texture2D(uBark, vUv, 3.5).rgb;
    float halo = smoothstep(0.15, 0.36, soft.r - soft.b);
    vec3 glow = vec3(1.0, 0.64, 0.24) * (vein * (0.6 + 6.0 * thick) + halo * 0.6 * thick) * flow;

    gl_FragColor = vec4((lit + glow) * (1.0 - 0.45 * uReflection), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Thick wood is smoothed so the trunk and limbs curve instead of bending at each joint. */
function smooth(chain: Chain): Chain {
  if (chain.radii[1] < 0.45 || chain.points.length < 3) return chain;
  const curve = new THREE.CatmullRomCurve3(chain.points.map((p) => new THREE.Vector3(...p)), false, "centripetal");
  const n = (chain.points.length - 1) * 3;
  const out: Chain = { points: [], radii: [], along: [] };
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const at = t * (chain.points.length - 1);
    const lo = Math.min(Math.floor(at), chain.points.length - 2);
    const f = at - lo;
    const p = curve.getPoint(t);
    out.points.push([p.x, p.y, p.z]);
    out.radii.push(chain.radii[lo] * (1 - f) + chain.radii[lo + 1] * f);
    out.along.push(chain.along[lo] * (1 - f) + chain.along[lo + 1] * f);
  }
  return out;
}

function woodGeometry(chains: Chain[]): THREE.BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const aAlong: number[] = [];
  const aRadius: number[] = [];
  const index: number[] = [];

  const t = new THREE.Vector3();
  const n = new THREE.Vector3();
  const b = new THREE.Vector3();
  const o = new THREE.Vector3();

  for (const raw of chains) {
    const chain = smooth(raw);
    const widest = Math.max(...chain.radii);
    const sides = widest > 1.2 ? 28 : widest > 0.45 ? 12 : widest > 0.14 ? 6 : 4;
    const wraps = Math.max(1, Math.round((2 * Math.PI * widest) / BARK_TILE));
    const base = position.length / 3;
    const last = chain.points.length - 1;

    for (let i = 0; i <= last; i++) {
      t.set(...sub(chain.points[Math.min(i + 1, last)], chain.points[Math.max(i - 1, 0)])).normalize();
      if (i === 0) n.set(Math.abs(t.y) < 0.9 ? 0 : 1, Math.abs(t.y) < 0.9 ? 1 : 0, 0);
      n.addScaledVector(t, -n.dot(t)).normalize(); // carry the frame along so the tube doesn't twist
      b.crossVectors(t, n);

      const r = chain.radii[i];
      const along = chain.along[i];
      const gnarl = THREE.MathUtils.smoothstep(r, 0.4, 1.8);
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        // Ridges and buttresses: big wood is lumpy, and the trunk flares into the roots.
        const ridges = 0.15 * Math.sin(5 * a + along * 0.35) + 0.09 * Math.sin(9 * a - along * 0.6 + 1.3) + 0.05 * Math.sin(17 * a + along * 1.1);
        const flare = raw === chains[0] ? 0.4 * Math.exp(-along / 1.1) * (0.55 + 0.45 * Math.sin(9 * a)) : 0;
        const rr = r * (1 + gnarl * ridges + flare);
        o.copy(n).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
        const p = chain.points[i];
        position.push(p[0] + o.x * rr, p[1] + o.y * rr, p[2] + o.z * rr);
        normal.push(o.x, o.y, o.z);
        uv.push((j / sides) * wraps, along / BARK_TILE);
        aAlong.push(along);
        aRadius.push(r);
      }
    }
    for (let i = 0; i < last; i++) {
      for (let j = 0; j < sides; j++) {
        const a = base + i * (sides + 1) + j;
        const c = a + sides + 1;
        index.push(a, a + 1, c, a + 1, c + 1, c);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aAlong", new THREE.Float32BufferAttribute(aAlong, 1));
  g.setAttribute("aRadius", new THREE.Float32BufferAttribute(aRadius, 1));
  g.setIndex(index);
  return g;
}

/** `reflection` marks the upside-down copy that sits under the pool. */
export function Wood({ reflection = false }: { reflection?: boolean }) {
  const bark = useTexture(barkUrl, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
    t.anisotropy = 8;
  });
  const geometry = useMemo(() => woodGeometry(theTree().chains), []);
  const material = useMemo(() => {
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uReflection: { value: reflection ? 1 : 0 } }]);
    uniforms.uBark = { value: bark }; // set after the merge, which would copy the texture
    return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, fog: true, toneMapped: false, side: THREE.DoubleSide });
  }, [bark, reflection]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    material.uniforms.uTime.value = pageSeconds();
  });

  return <mesh geometry={geometry} material={material} />;
}
