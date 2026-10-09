import { LAMP_REACH, MAX_LAMPS } from "@herzies/shared/gl";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient } from "./ambient";
import { windowLightsOf } from "./Buildings";
import { MAP_SIZE, objectAt, objectJitter, type TownMap } from "./map";

// Old-school lamp posts — an iron pole, a lantern on top — and the light
// the town gives off at night: from the lamps, and from lit windows.

/** Where the lantern's light comes from, on a lamp post of scale 1. */
export const LANTERN_Y = 3.3;

/** An iron lamp post: a flared foot, a slim pole with a collar, and a
 * lantern frame — four corner posts under a pyramid cap. */
export function lampPostGeometry(): THREE.BufferGeometry {
  const parts = [
    new THREE.CylinderGeometry(0.12, 0.2, 0.32, 8).translate(0, 0.16, 0),
    new THREE.CylinderGeometry(0.055, 0.07, 2.7, 6).translate(0, 1.6, 0),
    new THREE.CylinderGeometry(0.1, 0.1, 0.1, 8).translate(0, 0.9, 0),
    new THREE.CylinderGeometry(0.09, 0.06, 0.1, 8).translate(0, 2.95, 0),
    // The lantern's floor, its corner posts and its cap.
    new THREE.BoxGeometry(0.4, 0.05, 0.4).translate(0, 3.03, 0),
    ...[
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ].map(([x, z]) =>
      new THREE.BoxGeometry(0.04, 0.5, 0.04).translate(x * 0.18, 3.3, z * 0.18),
    ),
    new THREE.ConeGeometry(0.34, 0.28, 4)
      .rotateY(Math.PI / 4)
      .translate(0, 3.69, 0),
    new THREE.SphereGeometry(0.05, 6, 4).translate(0, 3.86, 0),
  ].map((g) => {
    const out = g.index ? g.toNonIndexed() : g;
    out.deleteAttribute("uv");
    return out;
  });
  return mergeGeometries(parts) as THREE.BufferGeometry;
}

/** The lantern's glass, lit like the windows (see DayLight). */
export const lanternGlassGeometry = new THREE.BoxGeometry(0.32, 0.46, 0.32);

/** How lit the town's little lights are: 0 by day, 1 at night. Written by
 * DayLight, read by NightLights. */
export const nightLights = { level: 0 };

const LAMP_COLOR = new THREE.Color("#ffc47a");
/** How bright a lamp post, and a lit window's spill, at full night. */
const LAMP_INTENSITY = 10;
const WINDOW_INTENSITY = 12;
/** How strongly each lights the herzies (see herzieMaterial). */
const LAMP_ON_HERZIES = 1;
const WINDOW_ON_HERZIES = 0.9;
/** How many of the little lights cast shadows: the ones nearest the
 * player. Each is the scene drawn six more times a frame (a cube of
 * shadow), so only a few, and only at night. */
const SHADOW_LIGHTS = 3;
/** Shadows start this far from a light: past the lantern's own frame and
 * glass, which would otherwise shade everything round it. */
const SHADOW_NEAR = 0.45;
/** Below this, the lights (and their shadows) are off. */
const DARK_ENOUGH = 0.05;

type Glow = {
  at: [number, number, number];
  intensity: number;
  onHerzies: number;
};

/** Every little light on the map: the lamp posts first, then the windows
 * nearest the middle of town, up to MAX_LAMPS. */
export function glowsOf(map: TownMap): Glow[] {
  const lamps: Glow[] = [];
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let col = 0; col < MAP_SIZE; col++) {
      if (objectAt(map, col, row) !== "L") continue;
      const { x, z, scale } = objectJitter(col, row);
      lamps.push({
        at: [x, LANTERN_Y * scale, z],
        intensity: LAMP_INTENSITY,
        onHerzies: LAMP_ON_HERZIES,
      });
    }
  }
  const windows = windowLightsOf(map)
    .sort((a, b) => Math.hypot(a[0], a[2]) - Math.hypot(b[0], b[2]))
    .map(
      (at): Glow => ({
        at,
        intensity: WINDOW_INTENSITY,
        onHerzies: WINDOW_ON_HERZIES,
      }),
    );
  return [...lamps, ...windows].slice(0, MAX_LAMPS);
}

/**
 * The town's little lights at night: a warm point light at every lamp
 * post and outside each lit stretch of windows, so their glow spills onto
 * the ground, the walls and the trees — and onto herzies, whose own shader
 * reads them from `ambient.uLamps`. Off by day; as many lights at noon as
 * at midnight, so nothing recompiles as the day turns.
 *
 * The few nearest the player cast shadows: a small pool of shadow-casting
 * lights that move to them (the plain light there going dark meanwhile).
 * They only cast at night — turning that on and off recompiles the
 * materials, once at dusk and once at dawn.
 */
export function NightLights({ map }: { map: TownMap }) {
  const glows = useMemo(() => glowsOf(map), [map]);
  const lights = useRef<(THREE.PointLight | null)[]>([]);
  const casters = useRef<(THREE.PointLight | null)[]>([]);
  const shown = useRef({ level: -1, x: Number.NaN, z: Number.NaN });

  useLayoutEffect(() => {
    const lamps = ambient.uLamps.value;
    for (let i = 0; i < lamps.length; i++) {
      const g = glows[i];
      if (g) lamps[i].set(...g.at, 0);
      else lamps[i].set(0, 0, 0, 0);
    }
    shown.current.level = -1;
    return () => {
      for (const l of lamps) l.w = 0;
    };
  }, [glows]);

  useFrame(() => {
    const level = nightLights.level < DARK_ENOUGH ? 0 : nightLights.level;
    const { x, z } = ambient.uPlayer.value;
    const s = shown.current;
    // Re-placed when the light changes or the player has moved a bit.
    if (level === s.level && Math.hypot(x - s.x, z - s.z) < 0.5) return;
    Object.assign(s, { level, x, z });

    const nearest = glows
      .map((g, i) => ({ i, d: Math.hypot(g.at[0] - x, g.at[2] - z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, SHADOW_LIGHTS)
      .map((n) => n.i);
    glows.forEach((g, i) => {
      const light = lights.current[i];
      const cast = level > 0 && nearest.includes(i);
      if (light) light.intensity = cast ? 0 : g.intensity * level;
      ambient.uLamps.value[i].w = g.onHerzies * level;
    });
    casters.current.forEach((light, k) => {
      if (!light) return;
      const g = glows[nearest[k]];
      light.castShadow = level > 0;
      if (!g || level === 0) {
        light.intensity = 0;
        return;
      }
      light.position.set(...g.at);
      light.intensity = g.intensity * level;
    });
  });

  return (
    <>
      {glows.map((g, i) => (
        <pointLight
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed per map
          key={i}
          ref={(l) => {
            lights.current[i] = l;
          }}
          position={g.at}
          color={LAMP_COLOR}
          intensity={0}
          distance={LAMP_REACH}
          decay={2}
        />
      ))}
      {Array.from({ length: Math.min(SHADOW_LIGHTS, glows.length) }, (_, k) => (
        <pointLight
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed pool
          key={`cast${k}`}
          ref={(l) => {
            casters.current[k] = l;
          }}
          color={LAMP_COLOR}
          intensity={0}
          distance={LAMP_REACH}
          decay={2}
          shadow-mapSize={[256, 256]}
          shadow-bias={-0.002}
          shadow-camera-near={SHADOW_NEAR}
          shadow-camera-far={LAMP_REACH}
        />
      ))}
    </>
  );
}
