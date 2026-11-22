import { LAMP_REACH, MAX_LAMPS } from "@herzies/shared/gl";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient } from "./ambient";
import {
  GLASS_OUT,
  lampFlicker,
  windowLightsOf,
  windowLit,
  windowPhase,
} from "./Buildings";
import { groundY, hash01, objectAt, objectJitter, type TownMap } from "./map";
import { TOWN_MAPS_LOCAL } from "./maps";

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
/** How bright a lamp post, and a lit window, at full night. */
const LAMP_INTENSITY = 16;
/** How far a lamp post's light reaches (a window's: LAMP_REACH). */
const LAMP_POST_REACH = 10;
const WINDOW_INTENSITY = 7;
/** A window's light: a cone out of the glass, aimed down at the ground
 * this far out, this wide (half-angle) — so it lands as a pool in front
 * of the house, and the wall round the window stays dark. */
const WINDOW_AIM = 2.6;
const WINDOW_CONE = 0.8;
/** How strongly each lights the herzies (see herzieMaterial); a window
 * from just in front of it, so it's herzies out front it lights. */
const LAMP_ON_HERZIES = 0.6;
const WINDOW_ON_HERZIES = 0.3;
const WINDOW_ON_HERZIES_OUT = 1.2;
/** How many lamp posts cast shadows: the ones nearest the player. Each is
 * the scene drawn six more times a frame (a cube of shadow), so only a
 * few, and only at night. */
const SHADOW_LIGHTS = 3;
/** And how many windows: a spot light's shadow is one view, not six, so
 * cheaper — enough for the windows you're walking past. */
const WINDOW_SHADOWS = 2;
/** Each casting light's shadow map, a side (a lamp post's, per cube face). */
const LAMP_SHADOW_MAP = 512;
/** How soft their edges are, in shadow-map texels (see shadows.ts). */
const LAMP_SHADOW_SOFTNESS = 3;
/** Shadows start this far from a light: past the lantern's own frame and
 * glass, which would otherwise shade everything round it. */
const SHADOW_NEAR = 0.45;
/** A casting light's shadow fades out over this last stretch before the
 * next light along takes its place, so the hand-over doesn't pop. */
const SHADOW_FADE = 2;
/** Below this, the lights (and their shadows) are off. */
const DARK_ENOUGH = 0.05;

type Glow = {
  /** Where the light is. */
  at: [number, number, number];
  /** A window's: which way it looks out (a lamp shines every way). */
  out?: [number, number];
  /** How high the ground is where a window's cone lands. */
  floor?: number;
  intensity: number;
  reach: number;
  onHerzies: number;
  /** A window's: when it lights up at dusk (see windowPhase). */
  phase?: number;
  /** A lamp post's: sets its flicker apart (see lampFlicker). */
  seed: number;
};

/** How lit a light is right now, 0–1 (and a touch over, flickering):
 * a window in its own turn through dusk, a lamp post flickering. */
function glowLevel(g: Glow, level: number, t: number): number {
  if (g.phase !== undefined) return windowLit(g.phase, level);
  return level * lampFlicker(t, g.seed);
}

/**
 * How strongly each of the `count` nearest lights casts its shadow, given
 * every light's distance, nearest first: fully, fading to nothing as the
 * next one along (which doesn't cast) comes as near — so when the two
 * swap, neither shadow is showing.
 */
export function casterFades(
  distances: number[],
  count: number,
  fade = SHADOW_FADE,
): number[] {
  const next = distances[count];
  return distances
    .slice(0, count)
    .map((d) =>
      next === undefined ? 1 : Math.min(1, Math.max(0, (next - d) / fade)),
    );
}

/** Every little light on the map: the lamp posts first, then the windows
 * nearest the middle of town, up to MAX_LAMPS. */
export function glowsOf(map: TownMap): Glow[] {
  const lamps: Glow[] = [];
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== "L") continue;
      const { x, z, scale } = objectJitter(map, col, row);
      lamps.push({
        at: [x, groundY(map, x, z) + LANTERN_Y * scale, z],
        intensity: LAMP_INTENSITY,
        reach: LAMP_POST_REACH,
        onHerzies: LAMP_ON_HERZIES,
        // As the lantern glass works it out from where it stands.
        seed: hash01(x, z) * 100,
      });
    }
  }
  const windows = windowLightsOf(map)
    .sort((a, b) => Math.hypot(a.at[0], a.at[2]) - Math.hypot(b.at[0], b.at[2]))
    .map(
      (w): Glow => ({
        // Just off the glass, so the wall behind it is out of the cone.
        at: [w.at[0] + w.out[0] * 0.15, w.at[1], w.at[2] + w.out[1] * 0.15],
        out: w.out,
        floor: groundY(
          map,
          w.at[0] + w.out[0] * WINDOW_AIM,
          w.at[2] + w.out[1] * WINDOW_AIM,
        ),
        intensity: WINDOW_INTENSITY,
        reach: LAMP_REACH,
        onHerzies: WINDOW_ON_HERZIES,
        phase: windowPhase(
          w.at[0] + w.out[0] * GLASS_OUT,
          w.at[1],
          w.at[2] + w.out[1] * GLASS_OUT,
        ),
        seed: 0,
      }),
    );
  return [...lamps, ...windows].slice(0, MAX_LAMPS);
}

type GlowCounts = { lamps: number; windows: number };

function countGlows(glows: Glow[]): GlowCounts {
  const lamps = glows.filter((g) => !g.out).length;
  return { lamps, windows: glows.length - lamps };
}

/** The most lamp posts, and the most lit windows, of any island among
 * `islands` that floats in the sky (not a room, not a deck). */
function mostGlows(islands: Iterable<TownMap>): GlowCounts {
  const most = { lamps: 0, windows: 0 };
  for (const m of islands) {
    if (m.room || m.ship) continue;
    const n = countGlows(glowsOf(m));
    most.lamps = Math.max(most.lamps, n.lamps);
    most.windows = Math.max(most.windows, n.windows);
  }
  return most;
}

/** mostGlows of every island there is, worked out the first time it's
 * asked for. */
let skyMost: GlowCounts | null = null;
function skyMostGlows(): GlowCounts {
  if (!skyMost) skyMost = mostGlows(TOWN_MAPS_LOCAL.values());
  return skyMost;
}

/** How many lights of each kind NightLights keeps on `map` (with these
 * `glows`): lamp posts' (point lights) and windows' (spot lights). An
 * island in the sky keeps as many of each as the one with the most, the
 * spares dark: how many lights there are is part of every lit material's
 * shader, so a different count recompiles them all — on a sky ship, half
 * way over, where the island drawn in full changes, that was the scene
 * stopping for a second or two. A room (the cave, the Tower's hall) keeps
 * its own: going in is a fade, and its few lights are cheaper. */
export function lightPools(
  map: TownMap,
  glows: Glow[] = glowsOf(map),
  most: GlowCounts = skyMostGlows(),
): GlowCounts {
  const own = countGlows(glows);
  if (map.room || map.ship) return own;
  return {
    lamps: Math.max(own.lamps, most.lamps),
    windows: Math.max(own.windows, most.windows),
  };
}

/** Where a light lights herzies from: a lamp from its lantern, a window
 * from a little out in front of it. */
const herzieLightAt = (g: Glow): [number, number, number] =>
  g.out
    ? [
        g.at[0] + g.out[0] * WINDOW_ON_HERZIES_OUT,
        g.at[1],
        g.at[2] + g.out[1] * WINDOW_ON_HERZIES_OUT,
      ]
    : g.at;

/** Where a window's cone points: down at the ground in front. */
function aimOf(g: Glow): THREE.Object3D {
  const target = new THREE.Object3D();
  const [ox, oz] = g.out ?? [0, 0];
  target.position.set(
    g.at[0] + ox * WINDOW_AIM,
    g.floor ?? 0,
    g.at[2] + oz * WINDOW_AIM,
  );
  target.updateMatrixWorld();
  return target;
}

/** A shadow-casting light with nothing to stand at (an island with fewer
 * lamp posts or windows than the pool; see lightPools), or with somewhere
 * again. Idle, its shadow is drawn once, empty, and then left: a caster
 * with no shadow map at all breaks every lit material's draw in WebKit
 * (the island went black at night), and one drawn every frame would be
 * the scene again for nothing. */
function idleShadow(
  light: THREE.PointLight | THREE.SpotLight,
  idle: boolean,
): void {
  light.shadow.autoUpdate = !idle;
  if (idle && !light.shadow.map) light.shadow.needsUpdate = true;
}

/** Nearest first (made once: NightLights sorts with it most frames while
 * walking). */
const byDistance = (a: { d: number }, b: { d: number }) => a.d - b.d;

/**
 * The town's little lights at night: a warm point light at every lamp
 * post, and a cone of light out of every lit window onto the ground in
 * front — so the glow spills onto the ground, the walls and trees nearby,
 * and (through `ambient.uLamps`, which their own shader reads) onto
 * herzies. Off by day; as many lights at noon as at midnight, so nothing
 * recompiles as the day turns — and as many on every island in the sky
 * (see lightPools), so nothing recompiles when another is drawn in full.
 *
 * The few lamp posts and windows nearest the player cast shadows: small
 * pools of shadow-casting lights that move to them (the plain light there
 * going dark meanwhile). They only cast at night — turning that on and off
 * recompiles the materials, once at dusk and once at dawn. A caster with
 * nothing to stand at (an island with fewer) still casts, for the count,
 * an empty shadow (see idleShadow).
 */
export function NightLights({ map }: { map: TownMap }) {
  const glows = useMemo(() => glowsOf(map), [map]);
  const aims = useMemo(
    () => glows.map((g) => (g.out ? aimOf(g) : null)),
    [glows],
  );
  const lights = useRef<(THREE.Light | null)[]>([]);
  const casters = useRef<(THREE.PointLight | null)[]>([]);
  const windowCasters = useRef<(THREE.SpotLight | null)[]>([]);
  // Where each window caster aims (moved with it).
  const windowAims = useMemo(
    () => Array.from({ length: WINDOW_SHADOWS }, () => new THREE.Object3D()),
    [],
  );
  const shown = useRef({ level: -1, x: Number.NaN, z: Number.NaN });
  const lampCount = glows.filter((g) => !g.out).length;
  const windowCount = glows.length - lampCount;
  const pool = useMemo(() => lightPools(map, glows), [map, glows]);

  useLayoutEffect(() => {
    const lamps = ambient.uLamps.value;
    for (let i = 0; i < lamps.length; i++) {
      const g = glows[i];
      if (g) lamps[i].set(...herzieLightAt(g), 0);
      else lamps[i].set(0, 0, 0, 0);
    }
    shown.current.level = -1;
    return () => {
      for (const l of lamps) l.w = 0;
    };
  }, [glows]);

  /** Which lights cast right now (the rest are plain): kept between
   * frames, so the flicker can be written every frame without sorting. */
  const casting = useRef<{ lamps: number[]; windows: number[] }>({
    lamps: [],
    windows: [],
  });
  /** Scratch for the re-placing, kept so walking about allocates nothing:
   * every glow with its distance (`order` re-sorted from `byIndex` each
   * time, so ties go as ever), and the lamps' and windows' distances. */
  const near = useMemo(() => {
    const byIndex = glows.map((g, i) => ({ i, g, d: 0 }));
    return {
      byIndex,
      order: byIndex.slice(),
      lamps: [] as number[],
      windows: [] as number[],
    };
  }, [glows]);

  useFrame(() => {
    const level = nightLights.level < DARK_ENOUGH ? 0 : nightLights.level;
    const t = ambient.uTime.value;
    const { x, z } = ambient.uPlayer.value;
    const s = shown.current;
    const moved = level !== s.level || Math.hypot(x - s.x, z - s.z) >= 0.05;
    // Every frame: the lamps flicker, and the windows come on in turn.
    if (level > 0 || s.level !== 0) {
      const { lamps: nearest, windows: nearestWindows } = casting.current;
      glows.forEach((g, i) => {
        const light = lights.current[i];
        const lit = glowLevel(g, level, t);
        const cast =
          level > 0 && (nearest.includes(i) || nearestWindows.includes(i));
        if (light) light.intensity = cast ? 0 : g.intensity * lit;
        ambient.uLamps.value[i].w = g.onHerzies * lit;
      });
      casters.current.forEach((light, k) => {
        const g = glows[nearest[k]];
        if (light && g && level > 0)
          light.intensity = g.intensity * glowLevel(g, level, t);
      });
      windowCasters.current.forEach((light, k) => {
        const g = glows[nearestWindows[k]];
        if (light && g && level > 0)
          light.intensity = g.intensity * glowLevel(g, level, t);
      });
    }
    // Re-placed when the light changes or the player has moved a little
    // (little enough that the shadows' fades move smoothly).
    if (!moved) return;
    // Dark, and dark already: nothing to move till dusk (which re-places
    // everything).
    if (level === 0 && s.level === 0) {
      s.x = x;
      s.z = z;
      return;
    }
    s.level = level;
    s.x = x;
    s.z = z;

    // The lamp posts and windows nearest the player cast shadows.
    const { byIndex, order } = near;
    for (let i = 0; i < byIndex.length; i++) {
      const n = byIndex[i];
      n.d = Math.hypot(n.g.at[0] - x, n.g.at[2] - z);
      order[i] = n;
    }
    order.sort(byDistance);
    const nearest = casting.current.lamps;
    const nearestWindows = casting.current.windows;
    nearest.length = nearestWindows.length = 0;
    near.lamps.length = near.windows.length = 0;
    for (const n of order) {
      if (n.g.out) {
        near.windows.push(n.d);
        if (nearestWindows.length < WINDOW_SHADOWS) nearestWindows.push(n.i);
      } else {
        near.lamps.push(n.d);
        if (nearest.length < SHADOW_LIGHTS) nearest.push(n.i);
      }
    }
    const fades = casterFades(near.lamps, SHADOW_LIGHTS);
    const windowFades = casterFades(near.windows, WINDOW_SHADOWS);
    glows.forEach((g, i) => {
      const light = lights.current[i];
      const lit = glowLevel(g, level, t);
      const cast =
        level > 0 && (nearest.includes(i) || nearestWindows.includes(i));
      if (light) light.intensity = cast ? 0 : g.intensity * lit;
      ambient.uLamps.value[i].w = g.onHerzies * lit;
    });
    casters.current.forEach((light, k) => {
      if (!light) return;
      const g = glows[nearest[k]];
      light.castShadow = level > 0;
      idleShadow(light, !g);
      if (!g || level === 0) {
        light.intensity = 0;
        return;
      }
      light.position.set(...g.at);
      light.intensity = g.intensity * glowLevel(g, level, t);
      light.shadow.intensity = fades[k];
    });
    windowCasters.current.forEach((light, k) => {
      if (!light) return;
      const g = glows[nearestWindows[k]];
      light.castShadow = level > 0;
      idleShadow(light, !g);
      if (!g || level === 0) {
        light.intensity = 0;
        return;
      }
      light.position.set(...g.at);
      // Its own aim, made once (this runs most frames while walking).
      const aim = aims[nearestWindows[k]];
      if (aim) windowAims[k].position.copy(aim.position);
      windowAims[k].updateMatrixWorld();
      light.intensity = g.intensity * glowLevel(g, level, t);
      light.shadow.intensity = windowFades[k];
    });
  });

  return (
    <>
      {glows.map((g, i) => {
        const keep = (l: THREE.Light | null) => {
          lights.current[i] = l;
        };
        const aim = aims[i];
        return aim ? (
          <group
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed per map
            key={i}
          >
            <primitive object={aim} />
            <spotLight
              ref={keep}
              position={g.at}
              target={aim}
              color={LAMP_COLOR}
              intensity={0}
              distance={g.reach}
              decay={2}
              angle={WINDOW_CONE}
              penumbra={0.75}
            />
          </group>
        ) : (
          <pointLight
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed per map
            key={i}
            ref={keep}
            position={g.at}
            color={LAMP_COLOR}
            intensity={0}
            distance={g.reach}
            decay={2}
          />
        );
      })}
      {/* The spares, dark (see lightPools). */}
      {Array.from({ length: pool.lamps - lampCount }, (_, k) => (
        <pointLight
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed pool
          key={`spare${k}`}
          intensity={0}
        />
      ))}
      {Array.from({ length: pool.windows - windowCount }, (_, k) => (
        <spotLight
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed pool
          key={`wspare${k}`}
          intensity={0}
        />
      ))}
      {Array.from({ length: Math.min(SHADOW_LIGHTS, pool.lamps) }, (_, k) => (
        <pointLight
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed pool
          key={`cast${k}`}
          ref={(l) => {
            casters.current[k] = l;
          }}
          color={LAMP_COLOR}
          intensity={0}
          distance={LAMP_POST_REACH}
          decay={2}
          shadow-mapSize={[LAMP_SHADOW_MAP, LAMP_SHADOW_MAP]}
          shadow-bias={-0.002}
          shadow-normalBias={0.03}
          shadow-radius={LAMP_SHADOW_SOFTNESS}
          shadow-camera-near={SHADOW_NEAR}
          shadow-camera-far={LAMP_POST_REACH}
        />
      ))}
      {windowAims
        .slice(0, Math.min(WINDOW_SHADOWS, pool.windows))
        .map((aim, k) => (
          <group
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed pool
            key={`wcast${k}`}
          >
            <primitive object={aim} />
            <spotLight
              ref={(l) => {
                windowCasters.current[k] = l;
              }}
              target={aim}
              color={LAMP_COLOR}
              intensity={0}
              distance={LAMP_REACH}
              decay={2}
              angle={WINDOW_CONE}
              penumbra={0.75}
              shadow-mapSize={[LAMP_SHADOW_MAP, LAMP_SHADOW_MAP]}
              shadow-bias={-0.002}
              shadow-normalBias={0.03}
              shadow-radius={LAMP_SHADOW_SOFTNESS}
              shadow-camera-near={0.1}
              shadow-camera-far={LAMP_REACH}
            />
          </group>
        ))}
    </>
  );
}
