import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import { windowMaterial } from "./Buildings";
import { dayLook, type Hour, localHours, skyLights } from "./DayCycle";
import { skyUniforms } from "./Islands";
import { nightLights } from "./Lamps";
import { ISLAND_RADIUS } from "./runtime";

const LIT_WINDOW = new THREE.Color("#ffd98a");
const DAY_WINDOW = new THREE.Color("#9fb3c4");

/** The sun's shadow covers the whole island, from a fixed box: no edge
 * where shadows stop, and nothing shimmers as the player walks. A sphere
 * a bit bigger than the island (for roofs and treetops) fits in it from
 * any angle. */
const SHADOW_REACH = ISLAND_RADIUS + 4;
/** How far out the light sits, along its direction. */
const SUN_DISTANCE = 60;
/** Moonlight casts paler shadows than the sun. */
const MOON_SHADOW = 0.55;

/**
 * The time of day, applied: the sky, the fog and background, the lights,
 * the windows and the herzies' tint, from the local clock (or `hour`, to
 * look at a given time). Re-read a few times a second — the day doesn't
 * move faster than that.
 */
export function DayLight({ hour }: { hour?: Hour }) {
  const hemi = useRef<THREE.HemisphereLight>(null);
  const sun = useRef<THREE.DirectionalLight>(null);
  const scene = useThree((s) => s.scene);
  const last = useRef({ at: -1, hour: Number.NaN });

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const h = typeof hour === "function" ? hour() : (hour ?? localHours());
    if (t - last.current.at < 0.25 && h === last.current.hour) return;
    last.current = { at: t, hour: h };
    const look = dayLook(h);
    const lights = skyLights(h);

    skyUniforms.uTop.value.copy(look.skyTop);
    skyUniforms.uHorizon.value.copy(look.skyHorizon);
    skyUniforms.uBottom.value.copy(look.skyBottom);
    skyUniforms.uSunDir.value.copy(lights.sun);
    skyUniforms.uSunColor.value.copy(look.sun);
    if (scene.background instanceof THREE.Color) {
      scene.background.copy(look.skyHorizon);
    }
    scene.fog?.color.copy(look.skyHorizon);
    if (hemi.current) {
      hemi.current.color.copy(look.hemiSky);
      hemi.current.groundColor.copy(look.hemiGround);
      hemi.current.intensity = look.hemiIntensity;
    }
    if (sun.current) {
      sun.current.color.copy(look.sun);
      sun.current.intensity = look.sunIntensity * lights.strength;
      sun.current.position.copy(lights.light).multiplyScalar(SUN_DISTANCE);
      sun.current.shadow.intensity =
        lights.strength * (1 - look.night * (1 - MOON_SHADOW));
    }
    ambient.uSun.value.copy(lights.herzie);
    windowMaterial.color.lerpColors(DAY_WINDOW, LIT_WINDOW, look.windows);
    nightLights.level = look.windows;
    ambient.uNight.value = look.night;
    ambient.uLight.value.copy(look.herzieLight);
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
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.04}
        shadow-camera-left={-SHADOW_REACH}
        shadow-camera-right={SHADOW_REACH}
        shadow-camera-top={SHADOW_REACH}
        shadow-camera-bottom={-SHADOW_REACH}
        shadow-camera-near={SUN_DISTANCE - SHADOW_REACH}
        shadow-camera-far={SUN_DISTANCE + SHADOW_REACH}
      />
    </>
  );
}
