import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ambient, seasonNow } from "./ambient";
import { windowGlow } from "./Buildings";
import {
  type DayLook,
  dayLook,
  type Hour,
  localHours,
  skyLights,
} from "./DayCycle";
import { CLOUD_SHADE, townLook } from "./depth";
import { skyUniforms } from "./Islands";
import { nightLights } from "./Lamps";
import { hash01, type RoomKind } from "./map";
import { ISLAND_RADIUS } from "./runtime";
import { dayOfYear, type Season, seasonLook } from "./Seasons";
import { lightning } from "./weather";

/** The sun's shadow covers the whole island, from a fixed box: no edge
 * where shadows stop, and nothing shimmers as the player walks. A sphere
 * a bit bigger than the island (for roofs and treetops) fits in it from
 * any angle. */
function shadowReach(radius: number): number {
  return radius + 4;
}
/** How far out the light sits, along its direction: far enough that the
 * whole shadow box is in front of it. */
const SUN_DISTANCE = 60;
function sunDistance(reach: number): number {
  return Math.max(SUN_DISTANCE, reach + 13);
}
/** The shadow map's texels per side: as sharp on a big island as on home. */
function shadowMapSize(reach: number): number {
  return reach > shadowReach(ISLAND_RADIUS) * 1.4 ? 4096 : 2048;
}
/** How soft the sun's shadow edges are, in shadow-map texels (see
 * shadows.ts). */
const SUN_SHADOW_SOFTNESS = 2;
/** Moonlight casts paler shadows than the sun. */
const MOON_SHADOW = 0.7;
/** Scratch for following a focus (see DayLight's `focus`). */
const UP = new THREE.Vector3(0, 1, 0);
const axisX = new THREE.Vector3();
const axisY = new THREE.Vector3();
const centre = new THREE.Vector3();

/** A dark room: no sun, a faint cool glow from nowhere, and the lamps
 * (which come on in the dark) doing the real lighting. Applied after the
 * midnight look, overriding what makes it the open sky. */
function applyRoomLook(
  night: number,
  scene: THREE.Scene,
  hemi: THREE.HemisphereLight | null,
  sun: THREE.DirectionalLight | null,
) {
  if (scene.background instanceof THREE.Color) {
    scene.background.set(ROOM_AIR);
  }
  if (scene.fog instanceof THREE.Fog) {
    scene.fog.color.set(ROOM_AIR);
    scene.fog.far = 0.9;
  }
  if (hemi) {
    hemi.color.set("#6f5f96");
    hemi.groundColor.set("#1a1426");
    hemi.intensity = 0.7;
  }
  if (sun) {
    sun.intensity = 0;
    sun.shadow.intensity = 0;
  }
  townLook.w = 0;
  nightLights.level = 1;
  ambient.uNight.value = Math.max(night, 1);
  ambient.uLight.value.set(0.62, 0.58, 0.8);
}

const ROOM_AIR = "#09070e";

/**
 * The Tower's hall inside: warm at any hour. A soft gold light falls from
 * high up (the windows' light, gathered: one shadow-casting light, aimed
 * the same way always), the bounce off the pale stone fills the rest, and
 * the air up in the vault is a dim warm brown. Only the windows show the
 * sky as the clock has it (see TowerHall); the torches are the hall's
 * own. Applied after the day's look, overriding what makes it the open sky.
 */
function applyTowerLook(
  scene: THREE.Scene,
  hemi: THREE.HemisphereLight | null,
  sun: THREE.DirectionalLight | null,
  distance: number,
) {
  if (scene.background instanceof THREE.Color) {
    scene.background.set(TOWER_AIR);
  }
  if (scene.fog instanceof THREE.Fog) {
    scene.fog.color.set(TOWER_AIR);
    scene.fog.far = 0.45;
  }
  if (hemi) {
    hemi.color.set("#ffe9cc");
    hemi.groundColor.set("#6e4f38");
    hemi.intensity = 1.35;
  }
  if (sun) {
    sun.color.set("#ffd9a6");
    sun.intensity = 0.85;
    sun.position.copy(TOWER_LIGHT).multiplyScalar(distance);
    sun.shadow.intensity = 0.55;
  }
  townLook.w = 0;
  nightLights.level = 0;
  ambient.uNight.value = 0;
  ambient.uSun.value.copy(TOWER_LIGHT);
  ambient.uLight.value.set(1, 0.88, 0.74);
}

const TOWER_AIR = "#2b2119";
/** Where the hall's light comes from (unit, toward it). */
const TOWER_LIGHT = new THREE.Vector3(0.35, 0.85, 0.4).normalize();

/** The herzies lit by a lightning stroke: white, a touch of blue. */
const FLASH_LIGHT = new THREE.Color("#e8ecff");
/** An overcast sky by day and by night: what the sky's colours go to
 * as the rain comes. */
const OVERCAST_DAY = {
  top: new THREE.Color("#5f6a78"),
  horizon: new THREE.Color("#8d949c"),
  bottom: new THREE.Color("#6a7280"),
};
const OVERCAST_NIGHT = {
  top: new THREE.Color("#0a0d14"),
  horizon: new THREE.Color("#1b2029"),
  bottom: new THREE.Color("#0c0f16"),
};
const GREY_LIGHT = new THREE.Color("#b9c0c8");

/** The rain's weather on the day's look: the sky grey, the sun lost
 * behind the clouds, the light flat and cool, the haze thick. */
function overcast(look: DayLook, rain: number) {
  if (rain <= 0) return;
  const k = Math.min(1, rain * 1.2);
  const night = look.night;
  const sky = {
    top: OVERCAST_DAY.top.clone().lerp(OVERCAST_NIGHT.top, night),
    horizon: OVERCAST_DAY.horizon.clone().lerp(OVERCAST_NIGHT.horizon, night),
    bottom: OVERCAST_DAY.bottom.clone().lerp(OVERCAST_NIGHT.bottom, night),
  };
  look.skyTop.lerp(sky.top, k * 0.9);
  look.skyHorizon.lerp(sky.horizon, k * 0.9);
  look.skyBottom.lerp(sky.bottom, k * 0.9);
  look.sun.lerp(GREY_LIGHT, k * 0.8);
  look.sunIntensity *= 1 - k * 0.7;
  look.hemiSky.lerp(GREY_LIGHT, k * 0.6);
  look.hemiIntensity *= 1 - k * 0.2;
  look.herzieLight.lerp(
    GREY_LIGHT.clone().multiplyScalar(look.herzieLight.r * 0.5 + 0.4),
    k * 0.6,
  );
  look.haze = Math.max(look.haze, k * 0.9);
}

/** Whether the northern lights show tonight, and how strongly (0: not at
 * all): about one winter night in three, the same for everyone, each
 * night (dusk to the next dawn) taken as one. */
export function auroraTonight(dayOfYear: number): number {
  // Nights span midnight: 18:00 of one day and 06:00 of the next are
  // the same night.
  const night = Math.floor(dayOfYear + 0.25);
  const h = hash01(night, 1);
  return h < 0.35 ? 0.6 + (h / 0.35) * 0.4 : 0;
}

/** The time of year, onto the shared uniforms (see `inSeason`) and for
 * the particles. */
function applySeason(year: ReturnType<typeof seasonLook>) {
  seasonNow.look = year;
  ambient.uGrassTint.value.copy(year.grass);
  ambient.uLeafTint.value.copy(year.leaf);
  ambient.uNeedleTint.value.copy(year.needles);
  ambient.uFall.value = year.fall;
  ambient.uBare.value = year.bare;
  ambient.uBlossom.value = year.blossom;
  ambient.uSnow.value = year.snow;
  ambient.uIce.value = year.ice;
}

/** Where the sun's shadow box should be this frame: its middle on the
 * ground (x, z, in the scene) and how far it reaches round that. */
export type ShadowFocus = (out: {
  x: number;
  z: number;
  reach: number;
}) => void;

/**
 * The time of day, applied: the sky, the fog and background, the haze
 * and cloud shadows, the lights, the windows and the herzies' tint, from
 * the local clock (or `hour`, to look at a given time). Re-read a few
 * times a second — the day doesn't move faster than that.
 */
export function DayLight({
  hour,
  season,
  room,
  radius = ISLAND_RADIUS,
  focus,
}: {
  hour?: Hour;
  /** The time of year to show (default: the local calendar). */
  season?: Season;
  /** Inside, not under the sky: "dark", the cave's lamp-lit night;
   * "tower", the Tower hall's warm light. */
  room?: RoomKind;
  /** The island's radius, for the shadow box (default: home's). Fixed for
   * the light's life: remount it (a `key`) for another island. */
  radius?: number;
  /** Where the shadows fall, asked every frame (a sky ship flying, the
   * island beside it while it's moored). The box follows it, snapped to
   * whole shadow-map texels so its edges don't crawl as it moves. */
  focus?: ShadowFocus;
}) {
  const reach = shadowReach(radius);
  const distance = sunDistance(reach);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const sun = useRef<THREE.DirectionalLight>(null);
  const scene = useThree((s) => s.scene);
  const last = useRef({ at: -1, hour: Number.NaN, day: Number.NaN });
  // The cloud shadows are shared with every lit material: none once the
  // Town is gone.
  useEffect(
    () => () => {
      townLook.w = 0;
    },
    [],
  );
  /** Which way the light comes from (unit, toward the sun), as last read. */
  const sunDir = useRef(new THREE.Vector3(0, 1, 0));
  /** `applied`: the box's reach its shadow camera was last fitted to, in
   * hundredths. */
  const box = useRef({ x: 0, z: 0, reach, applied: Number.NaN });

  /** What the lights were set to, before the lightning's flash. */
  const base = useRef({ hemi: 0, light: new THREE.Color(), flash: 0 });

  // Following a focus: the box and the light moved there, every frame.
  useFrame(() => {
    const light = sun.current;
    if (!focus || !light || room) return;
    const b = box.current;
    focus(b);
    const cam = light.shadow.camera;
    // As sharp on a big island as on home (the light isn't remounted for
    // another island when it's following a focus).
    const size = shadowMapSize(reach);
    if (light.shadow.mapSize.x !== size) {
      light.shadow.mapSize.set(size, size);
      light.shadow.map?.dispose();
      light.shadow.map = null;
    }
    const r = Math.max(4, b.reach);
    // Snap the middle to whole texels, across the light's view.
    const texel = (2 * r) / light.shadow.mapSize.x;
    const dir = sunDir.current;
    axisX.crossVectors(UP, dir);
    if (axisX.lengthSq() < 1e-6) axisX.set(1, 0, 0);
    axisX.normalize();
    axisY.crossVectors(dir, axisX);
    centre.set(b.x, 0, b.z);
    const sx = centre.dot(axisX);
    const sy = centre.dot(axisY);
    centre
      .addScaledVector(axisX, Math.round(sx / texel) * texel - sx)
      .addScaledVector(axisY, Math.round(sy / texel) * texel - sy);
    const d = sunDistance(r);
    light.target.position.copy(centre);
    light.target.updateMatrixWorld();
    light.position.copy(centre).addScaledVector(dir, d);
    const key = Math.round(r * 100);
    if (key !== b.applied) {
      b.applied = key;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = d - r;
      cam.far = d + r;
      cam.updateProjectionMatrix();
    }
  });

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    // The cave is always the dead of night, whatever the clock says. (The
    // Tower's windows show the hour; its own light doesn't follow it.)
    const h =
      room === "dark"
        ? 0
        : typeof hour === "function"
          ? hour()
          : (hour ?? localHours());
    const d = typeof season === "function" ? season() : (season ?? dayOfYear());
    // Lightning, every frame: the sky's light and the herzies' jump with
    // each stroke.
    const flash = room ? 0 : lightning.flash;
    if (flash > 0 || base.current.flash > 0) {
      base.current.flash = flash;
      if (hemi.current)
        hemi.current.intensity = base.current.hemi * (1 + 5 * flash);
      ambient.uLight.value
        .copy(base.current.light)
        .lerp(FLASH_LIGHT, Math.min(1, flash * 1.5));
    }
    if (
      t - last.current.at < 0.25 &&
      h === last.current.hour &&
      d === last.current.day
    )
      return;
    last.current = { at: t, hour: h, day: d };
    const look = dayLook(h);
    const year = seasonLook(d);
    // No snow lies indoors.
    if (room === "tower") {
      year.snow = 0;
      year.ice = 0;
      year.snowfall = 0;
    }
    applySeason(year);
    look.sun.multiply(year.light);
    look.hemiSky.multiply(year.light);
    overcast(look, ambient.uRain.value);
    const lights = skyLights(h);

    skyUniforms.uTop.value.copy(look.skyTop);
    skyUniforms.uHorizon.value.copy(look.skyHorizon);
    skyUniforms.uBottom.value.copy(look.skyBottom);
    skyUniforms.uSunDir.value.copy(lights.sun);
    skyUniforms.uMoonDir.value.copy(lights.moon);
    skyUniforms.uSunColor.value.copy(look.sun);
    skyUniforms.uNight.value = look.night;
    skyUniforms.uAurora.value = auroraTonight(d) * year.snow * look.night;
    if (scene.background instanceof THREE.Color) {
      scene.background.copy(look.skyHorizon);
    }
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.copy(look.skyHorizon);
      // Not a distance: how thick the haze is (see fog.ts).
      scene.fog.far = look.haze;
    }
    // Under an overcast sky there's no sun to cast them.
    townLook.w = CLOUD_SHADE * (1 - look.night) * (1 - ambient.uRain.value);
    if (hemi.current) {
      hemi.current.color.copy(look.hemiSky);
      hemi.current.groundColor.copy(look.hemiGround);
      hemi.current.intensity = look.hemiIntensity;
    }
    base.current.hemi = look.hemiIntensity;
    base.current.light.copy(look.herzieLight);
    if (sun.current) {
      sun.current.color.copy(look.sun);
      sun.current.intensity = look.sunIntensity * lights.strength;
      sunDir.current.copy(lights.light).normalize();
      if (!focus)
        sun.current.position.copy(lights.light).multiplyScalar(distance);
      sun.current.shadow.intensity =
        lights.strength * (1 - look.night * (1 - MOON_SHADOW));
    }
    ambient.uSun.value.copy(lights.herzie);
    windowGlow.uWindows.value = look.windows;
    nightLights.level = look.windows;
    ambient.uNight.value = look.night;
    ambient.uLight.value.copy(look.herzieLight);
    if (room === "dark")
      applyRoomLook(look.night, scene, hemi.current, sun.current);
    else if (room === "tower")
      applyTowerLook(scene, hemi.current, sun.current, distance);
  });

  return (
    <>
      {/* The ground colour is the sky below bouncing up: it lights the
          islands' undersides. */}
      <hemisphereLight ref={hemi} args={["#bcd7ff", "#5a6684", 1.6]} />
      {/* The sun by day, the moon by night (see skyLights); aimed at the
          island's middle, its default target. */}
      <directionalLight
        ref={sun}
        intensity={1.4}
        castShadow
        shadow-mapSize={[shadowMapSize(reach), shadowMapSize(reach)]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.04}
        shadow-radius={SUN_SHADOW_SOFTNESS}
        shadow-camera-left={-reach}
        shadow-camera-right={reach}
        shadow-camera-top={reach}
        shadow-camera-bottom={-reach}
        shadow-camera-near={distance - reach}
        shadow-camera-far={distance + reach}
      />
    </>
  );
}
