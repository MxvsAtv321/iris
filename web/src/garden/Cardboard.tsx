// Fallback VR for when there's no Quest. A phone in a Cardboard viewer shows
// the scene split for each eye, the phone's motion turns the view, and the
// judge selects by looking at something and holding still for a moment.
// Anything with userData.gazeId can be gazed at.

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { StereoEffect } from "three/examples/jsm/effects/StereoEffect.js";
import * as THREE from "three";
import type { Vec3 } from "./tree/grow";
import { getTheme } from "./theme";

const DWELL_S = 1.4;

/** iOS asks permission for motion data, and only from a tap. Call this from the button handler. */
export async function requestMotionPermission(): Promise<boolean> {
  const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof DOE?.requestPermission === "function") {
    try {
      return (await DOE.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  return true;
}

function orientationToQuaternion(q: THREE.Quaternion, alpha: number, beta: number, gamma: number, screenAngle: number) {
  const euler = new THREE.Euler(beta, alpha, -gamma, "YXZ");
  q.setFromEuler(euler);
  q.multiply(new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5))); // camera looks out the back of the device
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -screenAngle));
}

type Props = {
  /** Where the judge's head should be. The rig glides there. */
  eye: Vec3;
  /** Called when the judge has looked at something long enough. */
  onGaze: (gazeId: number | string) => void;
};

export function CardboardRig({ eye, onGaze }: Props) {
  const theme = getTheme();
  const { gl, scene, camera, size } = useThree();
  const effect = useMemo(() => new StereoEffect(gl), [gl]);
  const orientation = useRef<{ alpha: number; beta: number; gamma: number } | null>(null);
  const reticle = useRef<THREE.Mesh>(null);
  const dwell = useRef<{ id: number | string | null; t: number }>({ id: null, t: 0 });
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const goal = useMemo(() => new THREE.Vector3(...eye), [eye]);

  useEffect(() => {
    effect.setSize(size.width, size.height);
  }, [effect, size]);

  useEffect(() => {
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.alpha == null) return;
      orientation.current = { alpha: e.alpha, beta: e.beta ?? 0, gamma: e.gamma ?? 0 };
    };
    window.addEventListener("deviceorientation", onOrient);
    return () => window.removeEventListener("deviceorientation", onOrient);
  }, []);

  // The reticle rides on the camera, so the camera has to be in the scene.
  useEffect(() => {
    scene.add(camera);
    return () => {
      scene.remove(camera);
    };
  }, [scene, camera]);

  // Priority 1 means this frame callback takes over rendering from react-three-fiber.
  useFrame((_, dt) => {
    camera.position.lerp(goal, 1 - Math.exp(-2.5 * dt));

    const o = orientation.current;
    if (o) {
      const rad = THREE.MathUtils.DEG2RAD;
      const angle = (screen.orientation?.angle ?? 0) * rad;
      orientationToQuaternion(camera.quaternion, o.alpha * rad, o.beta * rad, o.gamma * rad, angle);
    }

    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hit = raycaster.intersectObjects(scene.children, true).find((h) => h.object.userData?.gazeId);
    const id = (hit?.object.userData.gazeId as number | string | undefined) ?? null;

    if (id && id === dwell.current.id) {
      dwell.current.t += dt;
      if (dwell.current.t >= DWELL_S) {
        onGaze(id);
        dwell.current.t = -1.5; // pause before the same thing can trigger again
      }
    } else {
      dwell.current = { id, t: 0 };
    }

    if (reticle.current) {
      const p = id ? Math.max(0, dwell.current.t) / DWELL_S : 0;
      reticle.current.scale.setScalar(1 + p * 1.6);
      (reticle.current.material as THREE.MeshBasicMaterial).color.set(id ? theme.pollen : theme.mist);
    }

    effect.render(scene, camera);
  }, 1);

  return (
    <primitive object={camera}>
      <mesh ref={reticle} position={[0, 0, -1]}>
        <ringGeometry args={[0.008, 0.013, 24]} />
        <meshBasicMaterial color={theme.mist} depthTest={false} transparent opacity={0.9} />
      </mesh>
    </primitive>
  );
}
