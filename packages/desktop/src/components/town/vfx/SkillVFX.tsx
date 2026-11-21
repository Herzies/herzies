import { BACKSPIN_DISCS, BACKSPIN_SPREAD, SKILL_DEFS } from "@herzies/shared";
import { DISC_RANGE, DISC_SPEED } from "@herzies/shared/combat";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { entityAt, SKILL_FX_MS, skills } from "../combat/skills";

/** Rings a Soothing Drones sends out, one after another. */
const DRONE_RINGS = 3;
const DRONE_RING_GAP_MS = 220;
/** Resurrect beams at once. */
const MAX_BEAMS = 4;
/** How far a Taunt's shout spreads. */
const TAUNT_REACH = 6;

const PINK = new THREE.Color(0xff7eb6);
const RED = new THREE.Color(0xff3b30);
const GOLD = new THREE.Color(0xffd84a);

/**
 * Class skills as they happen, for everyone in the room: Soothing Drones
 * pulses out over the ground as far as it reaches, Backspin's discs spin
 * away along the aim, a Taunt's shout spreads red from its caster, and a
 * Resurrect is a gold beam from its Bard to the fallen while it plays.
 * (Being in tune shows only in the HUD: BossHud's MusicBonus.) Pooled
 * meshes, moved each frame; nothing is created while fighting.
 */
export function SkillVFX() {
  const fx = useMemo(() => {
    const group = new THREE.Group();

    const ringGeo = new THREE.RingGeometry(0.92, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const rings = Array.from({ length: 12 }, () => {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xff7eb6,
          transparent: true,
          depthWrite: false,
          fog: false,
        }),
      );
      m.visible = false;
      m.renderOrder = 6;
      group.add(m);
      return m;
    });

    const discGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.04, 20);
    const discMat = new THREE.MeshStandardMaterial({
      color: 0xd9d9e8,
      metalness: 0.8,
      roughness: 0.25,
    });
    const discs = Array.from({ length: 12 }, () => {
      const m = new THREE.Mesh(discGeo, discMat);
      m.visible = false;
      group.add(m);
      return m;
    });

    const beamGeo = new THREE.CylinderGeometry(0.07, 0.07, 1, 8, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    const beamMat = new THREE.MeshBasicMaterial({
      color: GOLD,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const beams = Array.from({ length: MAX_BEAMS }, () => {
      const m = new THREE.Mesh(beamGeo, beamMat);
      m.visible = false;
      group.add(m);
      return m;
    });

    return {
      group,
      rings,
      discs,
      beams,
      ringGeo,
      discGeo,
      beamGeo,
      discMat,
      beamMat,
    };
  }, []);

  useEffect(
    () => () => {
      fx.ringGeo.dispose();
      fx.discGeo.dispose();
      fx.discMat.dispose();
      fx.beamGeo.dispose();
      fx.beamMat.dispose();
      for (const r of fx.rings) (r.material as THREE.Material).dispose();
    },
    [fx],
  );

  useFrame(() => {
    const now = performance.now();
    // Forget effects that have played out.
    // (In place: no new array a frame.)
    const casts = skills.casts;
    let kept = 0;
    for (const c of casts) if (now - c.at < SKILL_FX_MS) casts[kept++] = c;
    casts.length = kept;

    let ring = 0;
    let disc = 0;
    for (const c of skills.casts) {
      const age = now - c.at;
      if (c.skill === "soothing-drones") {
        const reach = SKILL_DEFS["soothing-drones"].radius ?? 8;
        for (let i = 0; i < DRONE_RINGS && ring < fx.rings.length; i++) {
          const t = (age - i * DRONE_RING_GAP_MS) / (SKILL_FX_MS * 0.6);
          if (t < 0 || t > 1) continue;
          const m = fx.rings[ring++];
          m.visible = true;
          m.position.set(c.x, 0.08 + i * 0.01, c.z);
          m.scale.setScalar(Math.max(0.05, reach * t));
          const mat = m.material as THREE.MeshBasicMaterial;
          mat.color.copy(PINK);
          mat.opacity = 0.85 * (1 - t);
        }
      } else if (c.skill === "taunt" || c.skill === "resurrect") {
        // A Taunt's shout: one fast red ring. A Resurrect's first note: a
        // small gold one at the Bard's feet.
        const t = age / (SKILL_FX_MS * (c.skill === "taunt" ? 0.45 : 0.7));
        if (t >= 0 && t <= 1 && ring < fx.rings.length) {
          const m = fx.rings[ring++];
          m.visible = true;
          m.position.set(c.x, 0.09, c.z);
          m.scale.setScalar(
            Math.max(0.05, (c.skill === "taunt" ? TAUNT_REACH : 2) * t),
          );
          const mat = m.material as THREE.MeshBasicMaterial;
          mat.color.copy(c.skill === "taunt" ? RED : GOLD);
          mat.opacity = 0.9 * (1 - t);
        }
      } else if (c.skill === "backspin") {
        const half = (BACKSPIN_DISCS - 1) / 2;
        const travelled = (age / 1000) * DISC_SPEED;
        for (let i = 0; i < BACKSPIN_DISCS && disc < fx.discs.length; i++) {
          const yaw = c.yaw + (i - half) * BACKSPIN_SPREAD;
          const m = fx.discs[disc++];
          // Out to a disc's reach, where the server stops looking.
          m.visible = travelled < DISC_RANGE;
          m.position.set(
            c.x + Math.sin(yaw) * (0.6 + travelled),
            1.2,
            c.z + Math.cos(yaw) * (0.6 + travelled),
          );
          // Spinning flat, tipped a little toward the throw.
          m.rotation.set(0.25, age * 0.04, 0);
        }
      }
    }
    for (; ring < fx.rings.length; ring++) fx.rings[ring].visible = false;
    for (; disc < fx.discs.length; disc++) fx.discs[disc].visible = false;

    // A Cymbrella's dome is its own effect: vfx/DomeVFX.

    // A Resurrect being played: a beam from the Bard to the fallen, pulsing
    // brighter as it nears the end.
    let beam = 0;
    for (const [by, ch] of skills.channels) {
      if (beam >= fx.beams.length) break;
      const from = entityAt.get(by);
      const to = entityAt.get(ch.target);
      if (!from || !to || now > ch.until) continue;
      const m = fx.beams[beam++];
      const ax = from.x;
      const ay = from.top * 0.7;
      const az = from.z;
      const bx = to.x;
      const by_ = 0.5;
      const bz = to.z;
      const len = Math.hypot(bx - ax, by_ - ay, bz - az);
      m.visible = len > 0.05;
      m.position.set((ax + bx) / 2, (ay + by_) / 2, (az + bz) / 2);
      m.lookAt(bx, by_, bz);
      m.scale.set(1, 1, len);
    }
    const k = (() => {
      let best = 0;
      for (const ch of skills.channels.values())
        best = Math.max(
          best,
          (now - ch.from) / Math.max(1, ch.until - ch.from),
        );
      return Math.min(1, best);
    })();
    fx.beamMat.opacity = 0.35 + 0.5 * k * (0.75 + 0.25 * Math.sin(now / 60));
    for (; beam < fx.beams.length; beam++) fx.beams[beam].visible = false;
  });

  return <primitive object={fx.group} />;
}
