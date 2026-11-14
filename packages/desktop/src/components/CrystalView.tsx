import { CRYSTAL_MAX_TIER } from "@herzies/shared";
import { useEffect, useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { useHerzieStage } from "../lib/overlayStage";
import {
  crystalFaceUniforms,
  crystalMaterial,
  FACING_CRYSTAL_GEOMETRY,
  FLOAT_Y,
  HALO_GEOMETRY,
  haloMaterial,
  MOTE_GEOMETRY,
  motesMaterial,
  PLINTH_GEOMETRY,
  SHARD_GEOMETRY,
  SHARD_SPOTS,
} from "./town/crystalModel";

/** How much of the scene the box shows, top to bottom, in world units, and
 * the height it's centred on: the crystal and the top of its plinth. */
const FRAME_HEIGHT = 2.2;
const FRAME_CENTER = 1.62;
const CAMERA_DISTANCE = 14;
const TILT = THREE.MathUtils.degToRad(9);
/** The crystal's size at the smallest tier and the largest. */
const SCALE_MIN = 0.78;
const SCALE_MAX = 1.08;
/** How long the flash lasts, seconds. */
const BURST_SECONDS = 1.1;
/** Below this fill, it dozes: eyes shut, slow breathing. */
const SLEEPY = 0.04;

function tierScale(tier: number): number {
  return SCALE_MIN + (SCALE_MAX - SCALE_MIN) * (tier / CRYSTAL_MAX_TIER);
}

/** A damped spring, stepped by `dt`: x chases `target`. */
function spring(
  s: { x: number; v: number },
  target: number,
  dt: number,
  stiffness: number,
  damping: number,
) {
  // Sub-steps keep a long frame (coming back to the page) stable.
  dt = Math.min(dt, 0.1);
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += ((target - s.x) * stiffness - s.v * damping) * h;
    s.x += s.v * h;
  }
}

/**
 * The Crystal as its window shows it: the same model as in Town, drawn on
 * the herzie stage, so it has the chunky pixels every NPC's portrait has.
 * It faces you, with a little face: dozing when empty, blinking as it fills,
 * beaming when full. `tier` is how big it's grown; bump `grownAt` to play
 * the growing moment, `boopAt` when it's clicked.
 */
export function CrystalView({
  charge,
  tier,
  paused,
  grownAt,
  boopAt,
  talking,
}: {
  /** Fill over capacity: above 1 when overcharged. */
  charge: number;
  tier: number;
  paused: boolean;
  grownAt: number;
  boopAt: number;
  /** Its line is being typed out: the mouth moves. */
  talking: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { stage: onStage } = useHerzieStage();

  const live = useRef({ charge, tier, paused, talking });
  live.current = { charge, tier, paused, talking };

  // Moments, read by the frame loop: when they happened (stage seconds).
  // Set here, taken up by the next frame.
  const moments = useRef({ grow: false, boop: false });
  const firstGrow = useRef(grownAt);
  useEffect(() => {
    if (grownAt !== firstGrow.current) moments.current.grow = true;
  }, [grownAt]);
  const firstBoop = useRef(boopAt);
  useEffect(() => {
    if (boopAt !== firstBoop.current) moments.current.boop = true;
  }, [boopAt]);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;

    const uniforms = {
      uTime: { value: 0 },
      uCharge: { value: live.current.charge },
      uBurst: { value: 0 },
    };
    const face = crystalFaceUniforms();
    const materials = {
      crystal: crystalMaterial(uniforms, face),
      shard: crystalMaterial(uniforms),
      halo: haloMaterial(uniforms, true),
      motes: motesMaterial(uniforms, true),
      plinth: new THREE.MeshLambertMaterial({
        vertexColors: true,
        flatShading: true,
      }),
    };

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 6, 5);
    scene.add(sun);
    // The crystal glows down onto the plinth's top.
    const glow = new THREE.PointLight(0x7fe8ff, 0, 3, 1.5);
    glow.position.set(0, FLOAT_Y - 0.6, 0.3);
    scene.add(glow);

    scene.add(new THREE.Mesh(PLINTH_GEOMETRY, materials.plinth));
    const halo = new THREE.Mesh(HALO_GEOMETRY, materials.halo);
    halo.position.set(0, FLOAT_Y, -0.7);
    halo.frustumCulled = false;
    halo.renderOrder = -1;
    scene.add(halo);
    const body = new THREE.Group();
    body.position.y = FLOAT_Y;
    const crystal = new THREE.Mesh(FACING_CRYSTAL_GEOMETRY, materials.crystal);
    body.add(crystal);
    scene.add(body);
    const shards = new THREE.Group();
    shards.position.y = FLOAT_Y;
    for (const s of SHARD_SPOTS) {
      const m = new THREE.Mesh(SHARD_GEOMETRY, materials.shard);
      m.position.set(...s.position);
      m.rotation.z = s.tilt;
      shards.add(m);
    }
    scene.add(shards);
    const motes = new THREE.Points(MOTE_GEOMETRY, materials.motes);
    motes.position.y = FLOAT_Y;
    motes.frustumCulled = false;
    scene.add(motes);

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

    const size = { x: tierScale(live.current.tier), v: 0 };
    const squash = { x: 0, v: 0 };
    const joy = { x: 0, v: 0 };
    const blink = { x: 0, v: 0 };
    let nextBlink = 1.5;
    let blinkUntil = -1;
    let t = 0;
    /** Real time, running even while paused, for the moments (a grow, a
     * boop): they play out rather than freezing half done. */
    let real = 0;
    let lastTier = live.current.tier;
    let grownAt = -100;
    let boopedAt = -100;

    const settled = () =>
      Math.abs(size.v) < 1e-3 &&
      Math.abs(squash.v) < 1e-3 &&
      Math.abs(squash.x) < 1e-3 &&
      Math.abs(joy.v) < 1e-3 &&
      Math.abs(blink.v) < 1e-3 &&
      uniforms.uBurst.value === 0;

    const remove = onStage.add({
      element,
      scene,
      camera: cam,
      idle: () =>
        live.current.paused &&
        !moments.current.grow &&
        !moments.current.boop &&
        settled(),
      update(dt, w, h) {
        const l = live.current;
        const m = moments.current;
        if (!l.paused) t += dt;
        real += dt;
        uniforms.uTime.value = t;
        if (m.grow) {
          m.grow = false;
          grownAt = real;
        }
        if (m.boop) {
          m.boop = false;
          boopedAt = real;
          squash.v += 3.2;
        }

        // The fill glides to a new value rather than jumping.
        uniforms.uCharge.value +=
          (l.charge - uniforms.uCharge.value) * (1 - 0.92 ** (dt * 60));
        const fill = Math.min(1, uniforms.uCharge.value);
        const asleep = l.charge < SLEEPY;

        // Grown: a squash down, then it springs up past its new size and
        // settles, flashing white.
        if (l.tier !== lastTier) {
          if (l.tier > lastTier) squash.v -= 4;
          lastTier = l.tier;
        }
        spring(size, tierScale(l.tier), dt, 120, 9);
        const sinceGrow = real - grownAt;
        const sinceBoop = real - boopedAt;
        uniforms.uBurst.value =
          sinceGrow >= 0 && sinceGrow < BURST_SECONDS
            ? (1 - sinceGrow / BURST_SECONDS) ** 2.5
            : 0;
        // Booped (above): a jelly wobble.
        spring(squash, 0, dt, 260, 7);

        const s = size.x;
        body.scale.set(
          s * (1 + squash.x),
          s * (1 - squash.x),
          s * (1 + squash.x),
        );
        // Bob (a slow breath asleep), sway to keep its face to you, and a
        // little hop when it grows.
        const hop =
          sinceGrow >= 0 && sinceGrow < 0.6
            ? Math.sin((sinceGrow / 0.6) * Math.PI) * 0.22
            : 0;
        body.position.y =
          FLOAT_Y +
          (asleep ? Math.sin(t * 0.9) * 0.03 : Math.sin(t * 1.6) * 0.07) +
          hop;
        body.rotation.y = Math.sin(t * 0.55) * (asleep ? 0.1 : 0.22);
        body.rotation.z = Math.sin(t * 0.8) * 0.04;
        shards.rotation.y = -t * (0.4 + fill * 0.9);
        shards.position.y = FLOAT_Y + Math.sin(t * 1.1) * 0.05;
        shards.scale.setScalar(s);
        halo.scale.setScalar(s);
        glow.intensity = 0.4 + fill * 2 + uniforms.uBurst.value * 6;

        // The face. Happy when full, booped or just grown.
        const delighted =
          fill >= 1 ||
          (sinceBoop >= 0 && sinceBoop < 0.9) ||
          (sinceGrow >= 0 && sinceGrow < 1.6);
        spring(joy, delighted ? 1 : 0, dt, 200, 22);
        face.uJoy.value = Math.min(1, Math.max(0, joy.x));
        face.uBlush.value = face.uJoy.value * 0.9;
        if (!l.paused && t > nextBlink) {
          blinkUntil = t + 0.13;
          // Now and then, a double blink.
          nextBlink = t + (Math.random() < 0.2 ? 0.3 : 2 + Math.random() * 3);
        }
        spring(blink, asleep || t < blinkUntil ? 1 : 0, dt, 900, 50);
        face.uBlink.value = Math.min(1, Math.max(0, blink.x));
        face.uMouth.value =
          sinceGrow >= 0 && sinceGrow < 0.5
            ? 1
            : l.talking && !l.paused
              ? 0.5 + 0.5 * Math.sin(t * 22)
              : 0;

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
      aria-label="The Crystal"
      className="relative z-[1] h-full w-full"
    />
  );
}
