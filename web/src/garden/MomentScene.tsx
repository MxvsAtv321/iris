// A single moment as a shallow 3D scene. The photo is laid on a dense plane,
// and each vertex is pushed toward the viewer by the depth map, so near things
// stand out and far things sit back. It's deliberately shallow, more diorama
// than reconstruction, because a single photo can't show what's behind things.
//
// Two tricks hide the usual artifacts. Where depth jumps sharply (the edge of
// a phone against a far wall) the stretched triangles fade out instead of
// smearing, and the frame's border feathers into the dark.

import { useMemo } from "react";
import { useTexture, Text } from "@react-three/drei";
import * as THREE from "three";
import type { Moment } from "./api";
import { timeAgo } from "./time";
import { FONT_BOLD, FONT_REGULAR, getTheme } from "./theme";

const vertexShader = /* glsl */ `
  uniform sampler2D depthMap;
  uniform float strength;
  uniform vec2 texel;
  varying vec2 vUv;
  varying float vEdge;

  void main() {
    vUv = uv;
    float d = texture2D(depthMap, uv).r;

    // How sharply depth changes around this vertex. High means a stretch seam.
    float dx = abs(texture2D(depthMap, uv + vec2(texel.x, 0.0)).r - texture2D(depthMap, uv - vec2(texel.x, 0.0)).r);
    float dy = abs(texture2D(depthMap, uv + vec2(0.0, texel.y)).r - texture2D(depthMap, uv - vec2(0.0, texel.y)).r);
    vEdge = max(dx, dy);

    vec3 p = position;
    p.z += d * strength;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform float seamCutoff;
  varying vec2 vUv;
  varying float vEdge;

  void main() {
    vec4 color = texture2D(map, vUv);

    // Feather the frame so the photo dissolves into the garden's dark.
    vec2 fromEdge = min(vUv, 1.0 - vUv);
    float border = smoothstep(0.0, 0.06, min(fromEdge.x, fromEdge.y));

    // Fade the stretched triangles at depth jumps.
    float seam = 1.0 - smoothstep(seamCutoff * 0.5, seamCutoff, vEdge);

    float alpha = border * seam;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(color.rgb, alpha);
    #include <colorspace_fragment>
  }
`;

type Props = {
  moment: Moment;
  depthUrl: string;
  /** Width of the diorama in meters. */
  width?: number;
  /** How far the nearest point comes forward, in meters. */
  strength?: number;
  position?: [number, number, number];
};

export function MomentScene({ moment, depthUrl, width = 2.4, strength = 0.55, position = [0, 1.5, -2.2] }: Props) {
  const theme = getTheme();
  const [photo, depth] = useTexture([moment.image_url, depthUrl]);
  photo.colorSpace = THREE.SRGBColorSpace;
  depth.colorSpace = THREE.NoColorSpace;

  const image = photo.image as { width: number; height: number };
  const aspect = image.height / image.width;
  const height = width * aspect;

  const geometry = useMemo(() => {
    const segX = 256;
    return new THREE.PlaneGeometry(width, height, segX, Math.round(segX * aspect));
  }, [width, height, aspect]);

  const material = useMemo(() => {
    const d = depth.image as { width: number; height: number };
    return new THREE.ShaderMaterial({
      uniforms: {
        map: { value: photo },
        depthMap: { value: depth },
        strength: { value: strength },
        texel: { value: new THREE.Vector2(1 / d.width, 1 / d.height) },
        seamCutoff: { value: 0.09 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
    });
  }, [photo, depth, strength]);

  return (
    <group position={position}>
      <mesh geometry={geometry} material={material} />
      <Text
        position={[0, height / 2 + 0.34, 0.05]}
        font={FONT_BOLD}
        fontSize={0.09}
        maxWidth={width}
        color={theme.pollen}
        anchorX="center"
        anchorY="bottom"
      >
        {`Seen ${timeAgo(moment.captured_at)}`}
      </Text>
      <Text
        position={[0, height / 2 + 0.1, 0.05]}
        font={FONT_REGULAR}
        fontSize={0.06}
        maxWidth={width}
        lineHeight={1.4}
        color={theme.mist}
        anchorX="center"
        anchorY="bottom"
      >
        {moment.description}
      </Text>
    </group>
  );
}
