import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { useHerzieStage } from "../lib/overlayStage";
import {
  CRADLE_GEOMETRY,
  HUNT_CRYSTAL_GEOMETRY,
  HUNT_FLOAT_Y,
  type HuntUniforms,
  huntCrystalMaterial,
} from "./town/wilds/huntCrystalModel";

/** How much of the scene the box shows, top to bottom, in world units, and
 * the height it's centred on: the crystal and its cradle. */
const FRAME_HEIGHT = 3.4;
const FRAME_CENTER = 1.75;
const CAMERA_DISTANCE = 18;
const TILT = THREE.MathUtils.degToRad(9);
/** Turns a second: still when it's dull, quicker the fuller it is. */
const SPIN_FULL = 2;
const SPIN_HUNT = 5;

/**
 * The Hunt Crystal as its window shows it: the same model as on the Wilds,
 * in its cradle, drawn on the herzie stage so it has the chunky pixels
 * every NPC's portrait has. `charge` (0 to 1) is how much gold is in it,
 * `hunt` whether its cache is out (it blazes); `talking` makes it pulse as
 * its line types out.
 */
export function HuntCrystalView({
  charge,
  hunt,
  paused,
  talking,
}: {
  charge: number;
  hunt: boolean;
  paused: boolean;
  talking: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { stage: onStage } = useHerzieStage();
  const live = useRef({ charge, hunt, paused, talking });
  live.current = { charge, hunt, paused, talking };

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const uniforms: HuntUniforms = {
      uTime: { value: 0 },
      uCharge: { value: live.current.charge },
      uHunt: { value: live.current.hunt ? 1 : 0 },
      uBurst: { value: 0 },
    };
    // No glow round it: an additive one leaves a black square on the
    // stage's see-through canvas (see crystalModel's glowBlending).
    const materials = {
      crystal: huntCrystalMaterial(uniforms),
      cradle: new THREE.MeshLambertMaterial({
        vertexColors: true,
        flatShading: true,
      }),
    };
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 6, 5);
    scene.add(sun);
    scene.add(new THREE.Mesh(CRADLE_GEOMETRY, materials.cradle));
    const body = new THREE.Mesh(HUNT_CRYSTAL_GEOMETRY, materials.crystal);
    body.position.y = HUNT_FLOAT_Y;
    scene.add(body);

    const cam = new THREE.PerspectiveCamera(10, 1, 0.1, 100);
    cam.fov = THREE.MathUtils.radToDeg(
      2 * Math.atan(FRAME_HEIGHT / 2 / CAMERA_DISTANCE),
    );
    cam.position.set(
      0,
      FRAME_CENTER + CAMERA_DISTANCE * Math.sin(TILT),
      CAMERA_DISTANCE * Math.cos(TILT),
    );
    cam.lookAt(0, FRAME_CENTER, 0);

    let t = 0;
    let angle = 0;
    const remove = onStage.add({
      element,
      scene,
      camera: cam,
      idle: () => live.current.paused,
      update(dt, w, h) {
        const l = live.current;
        if (l.paused) return;
        t += dt;
        uniforms.uTime.value = t;
        const k = 1 - 0.92 ** (dt * 60);
        uniforms.uCharge.value += (l.charge - uniforms.uCharge.value) * k;
        uniforms.uHunt.value += ((l.hunt ? 1 : 0) - uniforms.uHunt.value) * k;
        const fill = Math.min(1, uniforms.uCharge.value);
        const blaze = uniforms.uHunt.value;
        angle +=
          Math.min(dt, 0.1) * (SPIN_FULL * fill * fill + SPIN_HUNT * blaze);
        body.rotation.y = angle;
        // It speaks in a hum: a throb of light while its line types out.
        uniforms.uBurst.value = l.talking ? 0.12 + 0.12 * Math.sin(t * 18) : 0;
        body.position.y =
          HUNT_FLOAT_Y + Math.sin(t * 1.3) * 0.06 * fill + blaze * 0.3;
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      },
    });
    return () => {
      remove();
      for (const m of Object.values(materials)) m.dispose();
    };
  }, [onStage]);

  return (
    <div
      ref={box}
      role="img"
      aria-label="The Hunt Crystal"
      className="relative z-[1] h-full w-full"
    />
  );
}
