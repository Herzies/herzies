import { CYMBAL_TRAP } from "@herzies/shared";
import { HERZIE_BODY, WAVE_HAND_HEIGHT } from "@herzies/shared/combat";
import { MOB } from "@herzies/shared/tower";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { liveDummies } from "../combat/Dummies";
import { DUMMY } from "../combat/dummy";
import { entityAt } from "../combat/skills";
import {
  pruneTraps,
  TRAP_FADE_MS,
  TRAP_MISS_MS,
  TRAP_RELEASE_MS,
  type Trap,
  traps,
} from "../combat/traps";
import { groundY, type TownMap } from "../map";

/** Cymbals drawn at once at most (one per Percussionist throwing). */
const MAX = 8;
/** The cymbal's size: a little bigger than the one in hand, to read. */
const CYMBAL_RADIUS = 0.3;
/** How far out from its target's body it circles. */
const ORBIT_GAP = 0.3;
/** How fast it circles (radians a ms: two and a half turns a second), and
 * how fast it spins on itself. */
const ORBIT_RATE = (2.5 * Math.PI * 2) / 1000;
const SPIN_RATE = 0.045;
/** How long it takes to ease from where it caught into its circle. */
const SETTLE_MS = 200;
/** Where on its target it circles, as a share of its height: the waist. */
const WAIST = 0.45;

const GOLD = new THREE.Color("#ffd36b");

/** A cymbal's profile, turned: a domed bell in the middle, the bow out to
 * a thin edge that tips down a touch. */
function cymbalGeometry(): THREE.LatheGeometry {
  const r = CYMBAL_RADIUS;
  const profile = [
    [0, 0.07],
    [0.05 * r, 0.068],
    [0.18 * r, 0.058],
    [0.27 * r, 0.035],
    [0.34 * r, 0.022],
    [0.7 * r, 0.01],
    [r, -0.008],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 28);
}

/** Where a trap's target is now (its waist), how far round it the cymbal
 * circles, and the ground under it: filled in, not made, each frame. */
const spot = { x: 0, y: 0, z: 0, ground: 0, radius: 0 };

/** Finds trap `t`'s target into {@link spot}; false if it's gone (left,
 * fallen, out of sight). */
function findTarget(t: Trap, map: TownMap): boolean {
  const g = t.target;
  if (!g) return false;
  if (g.kind === "herzie") {
    const at = entityAt.get(g.id);
    if (!at) return false;
    const ground = groundY(map, at.x, at.z);
    spot.x = at.x;
    spot.z = at.z;
    spot.ground = ground;
    spot.y = ground + Math.max(0.4, at.top - ground) * WAIST;
    spot.radius = HERZIE_BODY.radius + ORBIT_GAP;
    return true;
  }
  for (const d of liveDummies) {
    if (g.kind === "mob" ? d.mob !== g.id : d.key !== g.key) continue;
    const size = d.size ?? 1;
    const ground = d.y ?? 0;
    const mob = g.kind === "mob";
    spot.x = d.x;
    spot.z = d.z;
    spot.ground = ground;
    spot.y = ground + (mob ? MOB.top * size : DUMMY.chest) * WAIST * 1.1;
    spot.radius = (mob ? MOB.radius : DUMMY.radius) * size + ORBIT_GAP;
    return true;
  }
  return false;
}

/**
 * Cymbal Traps, anyone's (see combat/traps): a gold cymbal spinning flat
 * out of its Percussionist's off hand along the throw, fading at the end
 * of its reach if it met nothing; or, once it's caught something, easing
 * into a circle round its waist and spinning round it for as long as the
 * hold lasts, a gold ring on the ground under it, then fading. One pooled
 * mesh (and ring) per cymbal, moved each frame; nothing is made while
 * fighting.
 */
export function CymbalTrapVFX({ map }: { map: TownMap }) {
  const fx = useMemo(() => {
    const group = new THREE.Group();
    const cymbalGeo = cymbalGeometry();
    const ringGeo = new THREE.RingGeometry(0.86, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const cymbals = Array.from({ length: MAX }, () => {
      const m = new THREE.Mesh(
        cymbalGeo,
        new THREE.MeshStandardMaterial({
          color: 0xe2b443,
          metalness: 0.85,
          roughness: 0.28,
          emissive: 0x7a5208,
          emissiveIntensity: 0.7,
          side: THREE.DoubleSide,
          transparent: true,
        }),
      );
      m.visible = false;
      group.add(m);
      return m;
    });
    const rings = Array.from({ length: MAX }, () => {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: GOLD,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
        }),
      );
      m.visible = false;
      m.renderOrder = 8;
      group.add(m);
      return m;
    });
    return { group, cymbalGeo, ringGeo, cymbals, rings };
  }, []);

  useEffect(
    () => () => {
      fx.cymbalGeo.dispose();
      fx.ringGeo.dispose();
      for (const m of [...fx.cymbals, ...fx.rings])
        (m.material as THREE.Material).dispose();
    },
    [fx],
  );

  useFrame((_, frameDt) => {
    const now = performance.now();
    const dtMs = Math.min(frameDt, 0.1) * 1000;
    pruneTraps(now);
    let n = 0;
    for (const t of traps) {
      if (n >= MAX) break;
      const p = t.pos;
      const caught = t.target !== null && now >= t.caughtAt;
      const found = t.target !== null && findTarget(t, map);
      const flyFrom = t.at + TRAP_RELEASE_MS;
      if (!t.out) {
        if (caught && found) {
          // Caught before it was seen to leave the hand (thrown from out
          // of sight, or up close): it starts in its circle.
          p[0] = spot.x;
          p[1] = spot.y;
          p[2] = spot.z + spot.radius;
        } else if (now >= flyFrom) {
          // Out of the hand: the thrower's, or over where it stood.
          if (t.hand) t.hand(p);
          else {
            p[0] = t.x + Math.sin(t.yaw) * 0.4;
            p[1] = groundY(map, t.x, t.z) + WAVE_HAND_HEIGHT;
            p[2] = t.z + Math.cos(t.yaw) * 0.4;
          }
        } else continue;
        t.out = true;
      }
      const m = fx.cymbals[n];
      const ring = fx.rings[n];
      n++;
      let alpha = 1;
      let ringK = 0;
      if (caught && found) {
        // Circling its target, eased in from where it caught it.
        const a = (now - t.caughtAt) * ORBIT_RATE + t.yaw;
        if (!t.orbitFrom) t.orbitFrom = [p[0], p[1], p[2]];
        const from = t.orbitFrom;
        const u = Math.min(1, (now - t.caughtAt) / SETTLE_MS);
        const k = u * u * (3 - 2 * u);
        const ox = spot.x + Math.sin(a) * spot.radius;
        const oy = spot.y + Math.sin(a * 2) * 0.05;
        const oz = spot.z + Math.cos(a) * spot.radius;
        p[0] = from[0] + (ox - from[0]) * k;
        p[1] = from[1] + (oy - from[1]) * k;
        p[2] = from[2] + (oz - from[2]) * k;
        alpha = Math.min(
          1,
          Math.max(0, (t.until + TRAP_FADE_MS - now) / TRAP_FADE_MS),
        );
        // Banked into its circle, wobbling as it goes.
        m.rotation.set(Math.cos(a) * 0.3, now * SPIN_RATE, -Math.sin(a) * 0.3);
        ringK = k * alpha;
        ring.position.set(spot.x, spot.ground + 0.04, spot.z);
        ring.scale.setScalar(spot.radius * (1 + 0.04 * Math.sin(now / 90)));
      } else if (t.target !== null && found) {
        // In practice, on its way to the dummy it'll catch: there as it
        // lands.
        const left = Math.max(dtMs, t.caughtAt - now);
        const k = Math.min(1, dtMs / left);
        p[0] += (spot.x - p[0]) * k;
        p[1] += (spot.y - p[1]) * k;
        p[2] += (spot.z - p[2]) * k;
        m.rotation.set(0.18, now * SPIN_RATE, 0);
      } else if (t.target !== null) {
        // What it caught is gone: it fades where it is.
        if (t.until > now) t.until = now;
        alpha = Math.max(0, (t.until + TRAP_FADE_MS - now) / TRAP_FADE_MS);
        m.rotation.y = now * SPIN_RATE;
      } else {
        // Flying free, out to its reach, then fading: a miss (or the
        // server's word on a catch still to come).
        const flown = now - flyFrom;
        if (flown < TRAP_MISS_MS) {
          const step = (CYMBAL_TRAP.speed * dtMs) / 1000;
          p[0] += Math.sin(t.yaw) * step;
          p[2] += Math.cos(t.yaw) * step;
        }
        alpha = Math.max(
          0,
          1 - Math.max(0, flown - TRAP_MISS_MS) / TRAP_FADE_MS,
        );
        m.rotation.set(0.18, now * SPIN_RATE, 0);
      }
      m.visible = alpha > 0;
      m.position.set(p[0], p[1], p[2]);
      m.scale.setScalar(0.85 + 0.15 * alpha);
      (m.material as THREE.MeshStandardMaterial).opacity = alpha;
      ring.visible = ringK > 0;
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * ringK;
    }
    for (; n < MAX; n++) {
      fx.cymbals[n].visible = false;
      fx.rings[n].visible = false;
    }
  });

  return <primitive object={fx.group} />;
}
