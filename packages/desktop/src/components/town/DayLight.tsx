import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import { windowMaterial } from "./Buildings";
import { dayLook, type Hour, localHours } from "./DayCycle";
import { skyUniforms } from "./Islands";
import { SUN_POSITION } from "./runtime";

const LIT_WINDOW = new THREE.Color("#ffd98a");
const DAY_WINDOW = new THREE.Color("#9fb3c4");

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

    skyUniforms.uTop.value.copy(look.skyTop);
    skyUniforms.uHorizon.value.copy(look.skyHorizon);
    skyUniforms.uBottom.value.copy(look.skyBottom);
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
      sun.current.intensity = look.sunIntensity;
    }
    windowMaterial.color.lerpColors(DAY_WINDOW, LIT_WINDOW, look.windows);
    ambient.uNight.value = look.night;
    ambient.uLight.value.copy(look.herzieLight);
  });

  return (
    <>
      {/* The ground colour is the sky below bouncing up: it lights the
          islands' undersides. */}
      <hemisphereLight ref={hemi} args={["#bcd7ff", "#5a6684", 1.6]} />
      <directionalLight ref={sun} position={SUN_POSITION} intensity={1.4} />
    </>
  );
}
