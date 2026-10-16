import { BACKSPIN_DISCS, BACKSPIN_SPREAD, SKILL_DEFS } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { buffOn, entityAt, SKILL_FX_MS, skills } from "../combat/skills";

/** Rings a Soothing Drones sends out, one after another. */
const DRONE_RINGS = 3;
const DRONE_RING_GAP_MS = 220;
const DISC_SPEED = 22;
/** Cymbals drawn at once at most (one per buffed herzie). */
const MAX_CYMBALS = 8;

/**
 * Class skills as they happen, for everyone in the room: Soothing Drones
 * pulses out over the ground as far as it reaches, Backspin's discs spin
 * away along the aim, and a giant cymbal hangs over whoever is under a
 * Cymbrella. Pooled meshes, moved each frame; nothing is created while
 * fighting.
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

    const cymbalGeo = new THREE.CylinderGeometry(1.1, 1.1, 0.05, 32);
    const cymbalMat = new THREE.MeshStandardMaterial({
      color: 0xe8c860,
      metalness: 0.9,
      roughness: 0.3,
      emissive: 0x5a4410,
    });
    const cymbals = Array.from({ length: MAX_CYMBALS }, () => {
      const m = new THREE.Mesh(cymbalGeo, cymbalMat);
      m.visible = false;
      m.castShadow = true;
      group.add(m);
      return m;
    });

    return {
      group,
      rings,
      discs,
      cymbals,
      ringGeo,
      discGeo,
      cymbalGeo,
      discMat,
      cymbalMat,
    };
  }, []);

  useEffect(
    () => () => {
      fx.ringGeo.dispose();
      fx.discGeo.dispose();
      fx.cymbalGeo.dispose();
      fx.discMat.dispose();
      fx.cymbalMat.dispose();
      for (const r of fx.rings) (r.material as THREE.Material).dispose();
    },
    [fx],
  );

  useFrame(() => {
    const now = performance.now();
    // Forget effects that have played out.
    skills.casts = skills.casts.filter((c) => now - c.at < SKILL_FX_MS);

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
          (m.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
        }
      } else if (c.skill === "backspin") {
        const half = (BACKSPIN_DISCS - 1) / 2;
        const travelled = (age / 1000) * DISC_SPEED;
        for (let i = 0; i < BACKSPIN_DISCS && disc < fx.discs.length; i++) {
          const yaw = c.yaw + (i - half) * BACKSPIN_SPREAD;
          const m = fx.discs[disc++];
          m.visible = travelled < 30;
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

    // A cymbal over everyone under a Cymbrella, for as long as it lasts
    // (yours from the moment you press it; see Combat).
    let cym = 0;
    for (const [id, at] of entityAt) {
      if (cym >= fx.cymbals.length) break;
      if (!buffOn(id, "cymbrella", now)) continue;
      const m = fx.cymbals[cym++];
      m.visible = true;
      m.position.set(at.x, at.top + 0.9 + Math.sin(now / 300) * 0.05, at.z);
      m.rotation.set(Math.sin(now / 500) * 0.06, now / 900, 0);
    }
    for (; cym < fx.cymbals.length; cym++) fx.cymbals[cym].visible = false;
  });

  return <primitive object={fx.group} />;
}
