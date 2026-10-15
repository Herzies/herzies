import type { HerzieModel } from "@herzies/shared/gl";
import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import {
  DISC_SIDE,
  type Disc,
  discField,
  SPARK_SECONDS,
} from "../combat/discs";
import type { Vec3 } from "../combat/waves";
import { distortionScene } from "./distortion";
import {
  FxLayer,
  GLOW,
  NOTE,
  NOTES,
  SPARK,
  scatter,
  useMotes,
  WHITE,
} from "./SonicVFX";

/**
 * How a thrown disc looks: the very disc that was in the hand — a CD,
 * its rainbow sheen sweeping round as it spins — banked into its curve,
 * with only a little of what a sonic wave has about it: a faint ring of
 * bent light round its rim, a thin streak of sparks behind, a note now and
 * then. A puff as it leaves the hand, a glint where it turns, a clink off a
 * wall, a small ring as it's caught. Hits are the waves' own bursts (see
 * Combat).
 *
 * Pooled and instanced, like SonicVFX: three draw calls for the discs,
 * two layers of glow, and the motes.
 */

const MAX = 16;
/** Without gear to measure (a Class Preview on a herzie without it), a
 * disc is this big (world units). */
const DEFAULT_RADIUS = 0.22;
/** In flight it's drawn this much bigger than in the hand, and never
 * smaller than MIN_RADIUS. */
const FLIGHT_SCALE = 1.6;
const MIN_RADIUS = 0.3;
/** How fast it spins (turns a second), and how far it banks into its
 * curve (radians): a little on the way out, more coming round. */
const SPIN = 11;
const BANK_OUT = 0.22;
const BANK_BACK = 0.45;
/** Its nose, lifted like a frisbee's. */
const NOSE = 0.08;

const SHEEN = new THREE.Color("#c9f3ff");

const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _up = new THREE.Vector3();
const _normal: Vec3 = [0, 1, 0];
const _v: Vec3 = [0, 0, 0];
const _at: Vec3 = [0, 0, 0];
const Y = new THREE.Vector3(0, 1, 0);

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** How it's turned: heading the way it's going, banked, nose up, spun. */
function orient(d: Disc, out: THREE.Quaternion): THREE.Quaternion {
  let hx = d.pos[0] - d.prev[0];
  let hz = d.pos[2] - d.prev[2];
  if (d.phase === "out" || Math.hypot(hx, hz) < 1e-4) {
    hx = d.dir[0];
    hz = d.dir[2];
  }
  const side = DISC_SIDE[d.hand];
  const bank =
    d.phase === "back"
      ? BANK_BACK
      : d.phase === "turn"
        ? BANK_OUT + (BANK_BACK - BANK_OUT) * Math.min(1, d.t / 0.1)
        : BANK_OUT;
  // Rolled toward the side its way back bows to (its right is −z×… see
  // discs.curve): a positive roll about its heading dips its left.
  _euler.set(-NOSE, Math.atan2(hx, hz), -side * bank);
  out.setFromEuler(_euler);
  _qa.setFromAxisAngle(Y, d.age * SPIN * Math.PI * 2 * -side);
  return out.multiply(_qa);
}

/** The thrown discs, as the eye sees them. Mount once in the Town. */
export function DiscVFX() {
  const scene = useThree((s) => s.scene);
  const parts = useMemo(() => {
    const disc = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 0.07, 36),
      new THREE.MeshPhysicalMaterial({
        color: "#d9d9e8",
        metalness: 0.85,
        roughness: 0.22,
        iridescence: 1,
        iridescenceIOR: 1.7,
        iridescenceThicknessRange: [180, 820],
        clearcoat: 0.6,
        clearcoatRoughness: 0.15,
      }),
      MAX,
    );
    const hub = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.24, 0.24, 0.1, 18),
      new THREE.MeshStandardMaterial({ color: "#3a3a4a", roughness: 0.6 }),
      MAX,
    );
    // A streak of light across it, out toward the rim: what shows it
    // spinning.
    const glintGeometry = new THREE.BoxGeometry(0.5, 0.08, 0.07);
    glintGeometry.translate(0.6, 0, 0);
    const glint = new THREE.InstancedMesh(
      glintGeometry,
      new THREE.MeshBasicMaterial({
        color: SHEEN,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      MAX,
    );
    for (const m of [disc, hub, glint]) {
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    disc.castShadow = true;
    return {
      disc,
      hub,
      glint,
      halo: new FxLayer(new THREE.TorusGeometry(1, 0.1, 6, 36), MAX, false),
      puffs: new FxLayer(new THREE.SphereGeometry(1, 14, 8), 24, false),
      rings: new FxLayer(new THREE.TorusGeometry(1, 0.12, 6, 28), 24, false),
    };
  }, []);
  const motes = useMotes();

  useLayoutEffect(() => {
    const { disc, hub, glint, halo, puffs, rings } = parts;
    const layers = [halo, puffs, rings];
    scene.add(disc, hub, glint);
    for (const l of layers) {
      distortionScene.add(l.bend);
      scene.add(l.glow);
    }
    scene.add(motes.points);
    return () => {
      scene.remove(disc, hub, glint);
      for (const m of [disc, hub, glint]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
        m.dispose();
      }
      for (const l of layers) {
        distortionScene.remove(l.bend);
        scene.remove(l.glow);
        l.dispose();
      }
      scene.remove(motes.points);
      motes.dispose();
      discField.clear();
    };
  }, [parts, scene, motes]);

  useFrame(({ clock }, dt) => {
    const time = clock.elapsedTime;
    const { disc, hub, glint, halo, puffs, rings } = parts;
    halo.begin();
    puffs.begin();
    rings.begin();
    let n = 0;

    for (const d of discField.discs) {
      if (!d.alive || n >= MAX) continue;
      const owner = d.owner as HerzieModel | null;
      // Bigger in flight than in the hand, as thrown things in games are:
      // at a distance, and pixelated, the real size is lost.
      const r = Math.max(
        MIN_RADIUS,
        (owner?.heldRadius(d.hand) || DEFAULT_RADIUS) * FLIGHT_SCALE,
      );
      orient(d, _q);
      _pos.set(d.pos[0], d.pos[1], d.pos[2]);
      _scale.setScalar(r);
      _m.compose(_pos, _q, _scale);
      disc.setMatrixAt(n, _m);
      hub.setMatrixAt(n, _m);
      glint.setMatrixAt(n, _m);
      n++;

      // A faint ring of bent light round its rim, breathing.
      _up.set(0, 1, 0).applyQuaternion(_q);
      _normal[0] = _up.x;
      _normal[1] = _up.y;
      _normal[2] = _up.z;
      const pulse = 1 + Math.sin(time * 26 + d.age * 3) * 0.06;
      const fadeIn = Math.min(1, d.age / 0.06);
      halo.add(d.pos, _normal, r * 1.4 * pulse, 0.22 * fadeIn, GLOW);

      // A thin streak of sparks behind it, evenly spaced however fast.
      const dx = d.pos[0] - d.prev[0];
      const dy = d.pos[1] - d.prev[1];
      const dz = d.pos[2] - d.prev[2];
      const moved = Math.hypot(dx, dy, dz);
      const dots = Math.min(6, Math.ceil(moved / 0.22));
      for (let i = 0; i < dots; i++) {
        const k = (i + Math.random()) / dots;
        _at[0] = d.prev[0] + dx * k;
        _at[1] = d.prev[1] + dy * k;
        _at[2] = d.prev[2] + dz * k;
        scatter([0, 1, 0], 1, _v);
        motes.spawn(_at, [_v[0] * 0.3, _v[1] * 0.3, _v[2] * 0.3], {
          life: 0.16,
          size: r * 0.75,
          kind: SPARK,
          color: GLOW,
          drag: 4,
        });
      }
      // Now and then a note.
      if (Math.random() < dt * 3.5) {
        scatter([0, 1, 0], 0.6, _v);
        motes.spawn(
          d.pos,
          [_v[0] * 0.5, 0.9 + Math.random() * 0.5, _v[2] * 0.5],
          {
            life: 0.8,
            size: 0.3,
            kind: Math.random() < 0.5 ? NOTE : NOTES,
            color: GLOW,
            drag: 1.5,
          },
        );
      }
    }
    for (const m of [disc, hub, glint]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }

    for (const s of discField.sparks) {
      if (!s.alive) continue;
      const t = s.age / SPARK_SECONDS;
      if (s.kind === "throw") {
        puffs.add(
          s.pos,
          [0, 1, 0],
          0.06 + easeOut(t) * 0.3,
          (1 - t) ** 2 * 0.5,
          GLOW,
        );
      } else if (s.kind === "catch") {
        rings.add(
          s.pos,
          [0, 1, 0],
          0.12 + easeOut(t) * 0.38,
          (1 - t) ** 2 * 0.55,
          GLOW,
        );
      } else if (s.kind === "clink") {
        puffs.add(
          s.pos,
          [0, 1, 0],
          0.08 + easeOut(t) * 0.45,
          (1 - t) ** 2 * 0.6,
          WHITE,
        );
      }
      if (!s.fresh) continue;
      s.fresh = false;
      if (s.kind === "turn") {
        // A glint: one bright star, and a few specks round it.
        motes.spawn(s.pos, [0, 0, 0], {
          life: 0.14,
          size: 0.65,
          kind: SPARK,
          color: WHITE,
        });
        for (let i = 0; i < 3; i++) {
          scatter([0, 1, 0], 1, _v);
          motes.spawn(s.pos, [_v[0] * 1.5, _v[1] * 1.5, _v[2] * 1.5], {
            life: 0.2,
            size: 0.1,
            kind: SPARK,
            color: GLOW,
            drag: 5,
          });
        }
        continue;
      }
      const count = s.kind === "clink" ? 10 : s.kind === "catch" ? 5 : 6;
      const speed = s.kind === "clink" ? 4 : 2.2;
      for (let i = 0; i < count; i++) {
        scatter([0, 1, 0], 1.2, _v);
        const v = speed * (0.6 + Math.random() * 0.6);
        motes.spawn(s.pos, [_v[0] * v, _v[1] * v, _v[2] * v], {
          life: 0.2 + Math.random() * 0.12,
          size: 0.08 + Math.random() * 0.06,
          kind: SPARK,
          color: Math.random() < 0.5 ? WHITE : GLOW,
          gravity: s.kind === "clink" ? 9 : 0,
          drag: 5,
        });
      }
    }

    halo.end();
    puffs.end();
    rings.end();
    motes.update(dt);
  });

  return null;
}
