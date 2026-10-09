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
const LAMP_INTENSITY = 7;
const WINDOW_INTENSITY = 4;
/** How strongly each lights the herzies (see herzieMaterial). */
const LAMP_ON_HERZIES = 0.9;
const WINDOW_ON_HERZIES = 0.55;

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
 */
export function NightLights({ map }: { map: TownMap }) {
  const glows = useMemo(() => glowsOf(map), [map]);
  const lights = useRef<(THREE.PointLight | null)[]>([]);
  const shown = useRef(-1);

  useLayoutEffect(() => {
    const lamps = ambient.uLamps.value;
    for (let i = 0; i < lamps.length; i++) {
      const g = glows[i];
      if (g) lamps[i].set(...g.at, 0);
      else lamps[i].set(0, 0, 0, 0);
    }
    shown.current = -1;
    return () => {
      for (const l of lamps) l.w = 0;
    };
  }, [glows]);

  useFrame(() => {
    const level = nightLights.level;
    if (level === shown.current) return;
    shown.current = level;
    glows.forEach((g, i) => {
      const light = lights.current[i];
      if (light) light.intensity = g.intensity * level;
      ambient.uLamps.value[i].w = g.onHerzies * level;
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
    </>
  );
}
