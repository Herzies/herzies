import { SILENCIO } from "@herzies/shared";
import { DOME, domeRadiusAt } from "@herzies/shared/combat";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { DOME_SHOW_DELAY_MS } from "../combat/domes";
import { drawDelayMs } from "../combat/drawDelay";
import { prune, type Slam, slams } from "../combat/slams";
import type { Vec3 } from "../combat/waves";
import { easeOutClamped as easeOut } from "../easing";
import { groundY, type TownMap } from "../map";
import { distortionScene } from "./distortion";
import { GroundRing } from "./SlamVFX";
import { FxLayer, NOTE, SPARK, scatter, useMotes } from "./SonicVFX";

/** Silencios drawn at once at most. */
const MAX = 4;
/** The Bard's velvet, and the pale edge of the hush. */
const VELVET = new THREE.Color("#7b5cff");
const PALE = new THREE.Color("#d9ccff");
const UP: Vec3 = [0, 1, 0];
/** How long the wave lingers at its full reach once it's gone, fading. */
const FADE_MS = 320;
/** Notes flung out on the burst, and how long they live. */
const NOTES_OUT = 14;

/**
 * Silencio, anyone's: the wind-up, a breath drawn in (pale motes pulled
 * into the lute, the reach marked faintly on the ground), then the burst,
 * a wave of silence rolling out to SILENCIO.radius. The wave grows on the
 * server's numbers (domeRadiusAt, as a Cymbrella's dome does) and a beat
 * late, as a dome's (combat/domes.ts), so its edge reaches each mob just
 * as that mob's shove is drawn; notes are flung out with it and snuffed.
 * The server judges the shove and the bleeds; this only draws them.
 */
export function SilencioVFX({ map }: { map: TownMap }) {
  const scene = useThree((s) => s.scene);
  const parts = useMemo(() => {
    const ring = () => new GroundRing(VELVET, PALE);
    return {
      edges: Array.from({ length: MAX }, ring),
      fronts: Array.from({ length: MAX }, ring),
      trails: Array.from({ length: MAX }, ring),
      bends: new FxLayer(new THREE.TorusGeometry(1, 0.12, 6, 48), MAX, false),
      orbs: new FxLayer(new THREE.SphereGeometry(1, 14, 8), MAX, false),
      burst: new WeakSet<Slam>(),
    };
  }, []);
  const motes = useMotes();

  useEffect(() => {
    const rings = [...parts.edges, ...parts.fronts, ...parts.trails];
    for (const r of rings) scene.add(r.mesh);
    scene.add(motes.points);
    for (const l of [parts.bends, parts.orbs]) {
      distortionScene.add(l.bend);
      scene.add(l.glow);
    }
    return () => {
      for (const r of rings) {
        scene.remove(r.mesh);
        r.dispose();
      }
      scene.remove(motes.points);
      for (const l of [parts.bends, parts.orbs]) {
        distortionScene.remove(l.bend);
        scene.remove(l.glow);
        l.dispose();
      }
      motes.dispose();
    };
  }, [parts, scene, motes]);

  const tip = useMemo<Vec3>(() => [0, 0, 0], []);
  const v = useMemo<Vec3>(() => [0, 0, 0], []);
  /** The wave as the server grows it, re-aimed each frame (made once). */
  const wave = useMemo(
    () => ({ x: 0, z: 0, from: 0, until: 0, radius: SILENCIO.radius }),
    [],
  );

  /** The burst's first frame: notes flung out from the lute, low and wide,
   * that fall silent as they go. */
  const burst = (s: Slam) => {
    const [hx, hy, hz] = s.hit;
    for (let i = 0; i < NOTES_OUT; i++) {
      const a = (i / NOTES_OUT) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 5 + Math.random() * 2.5;
      motes.spawn(
        [hx, hy, hz],
        [Math.sin(a) * speed, 0.6 + Math.random() * 0.8, Math.cos(a) * speed],
        {
          life: 0.55 + Math.random() * 0.2,
          size: 0.3 + Math.random() * 0.12,
          kind: NOTE + (i & 1),
          color: i % 3 === 0 ? PALE : VELVET,
          drag: 3,
        },
      );
    }
  };

  useFrame((_, frameDt) => {
    const now = performance.now();
    const dt = Math.min(frameDt, 0.05);
    prune(now);
    parts.bends.begin();
    parts.orbs.begin();
    const R = SILENCIO.radius;
    let i = 0;
    for (const s of slams) {
      if (s.skill !== "silencio") continue;
      if (i >= MAX) break;
      const k = i++;
      const gy = groundY(map, s.x, s.z);
      if (s.landedAt === null) {
        // The breath drawn in: the reach marked faintly, and pale motes
        // pulled into the lute.
        const u = Math.min(
          1,
          (now - s.castAt) / Math.max(1, s.dueAt - s.castAt),
        );
        parts.edges[k].show(map, s.x, s.z, R, 0.08, 0.15 + 0.35 * u);
        parts.fronts[k].mesh.visible = false;
        parts.trails[k].mesh.visible = false;
        if (s.tip) {
          s.tip(tip);
          parts.orbs.add(tip, UP, 0.06 + 0.14 * u, 0.2 + 0.5 * u, VELVET);
          if (Math.random() < dt * 50) {
            scatter(UP, 2, v);
            const d = 1 + Math.random() * 0.6;
            const life = 0.3;
            motes.spawn(
              [tip[0] + v[0] * d, tip[1] + v[1] * d * 0.5, tip[2] + v[2] * d],
              [
                (-v[0] * d) / life,
                (-v[1] * d * 0.5) / life,
                (-v[2] * d) / life,
              ],
              { life, size: 0.1, kind: SPARK, color: PALE },
            );
          }
        }
        continue;
      }
      if (!parts.burst.has(s)) {
        parts.burst.add(s);
        burst(s);
      }
      // The wave, on the server's timeline a beat late (as mobs are drawn).
      const from = s.landedAt + Math.max(DOME_SHOW_DELAY_MS, drawDelayMs());
      wave.x = s.x;
      wave.z = s.z;
      wave.from = from;
      wave.until = from + SILENCIO.standMs;
      const gone = now - wave.until;
      const r =
        now < from
          ? DOME.startRadius * easeOut((now - s.landedAt) / (from - s.landedAt))
          : gone >= 0
            ? R
            : domeRadiusAt(wave, now);
      const fade = gone >= 0 ? Math.max(0, 1 - gone / FADE_MS) : 1;
      // Its front, bright and narrow; a soft wake behind it; the reach's
      // own edge flaring as the front meets it, then going.
      parts.fronts[k].show(map, s.x, s.z, r, 0.28, 1.1 * fade);
      parts.trails[k].show(map, s.x, s.z, r * 0.8, r * 0.5, 0.25 * fade);
      parts.edges[k].show(map, s.x, s.z, R, 0.1, 0.5 * fade * (r / R) ** 4);
      if (fade > 0.01)
        parts.bends.add(
          [s.x, gy + 0.3, s.z],
          UP,
          Math.max(0.2, r),
          0.8 * fade,
          VELVET,
        );
      // A soft flash at the lute.
      const t = now - s.landedAt;
      if (t < 160)
        parts.orbs.add(s.hit, UP, 0.3 + t * 0.004, 1 - t / 160, PALE);
    }
    for (; i < MAX; i++)
      for (const r of [parts.edges[i], parts.fronts[i], parts.trails[i]])
        r.mesh.visible = false;
    parts.bends.end();
    parts.orbs.end();
    motes.update(dt);
  });

  return null;
}
