import { mulberry32 } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { MathUtils } from "three";
import { ambient } from "./ambient";
import { skyUniforms } from "./Islands";
import { lightning, rainbowNow, stepLightning, weatherNow } from "./weather";

// The weather, applied (see weather.ts for when it rains): the rain
// itself, as streaks falling round the player; the ground going dark and
// wet under it, and drying after; the lightning in a storm; and the
// rainbow once a shower's passed. The sky and the lights go grey under it
// in DayLight, which reads the same uniforms.

/** How many streaks fall at the hardest rain, in a box this far round
 * the player and this high. */
const DROPS = 420;
const RAIN_REACH = 11;
const RAIN_HEIGHT = 11;
/** How fast they fall, and how long each streak is. */
const RAIN_SPEED = 11;
const STREAK = 0.45;
/** How much the wind leans the rain. */
const RAIN_LEAN = 0.3;
/** The ground takes this long to soak through (s), and this long to dry. */
const SOAK = 45;
const DRY = 240;
/** How quickly the rain comes on and goes off, as shown (per second). */
const RAIN_DAMP = 0.6;

const rainMaterial = new THREE.LineBasicMaterial({
  color: "#d6e4f2",
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
});

/** Rain falling round the player: streaks on the wind, wrapped round a
 * box so it never runs out, like the snow. One draw. */
function Rain() {
  const drops = useMemo(() => {
    const rand = mulberry32(1111);
    return Array.from({ length: DROPS }, () => ({
      x: rand() * RAIN_REACH * 2,
      y: rand() * RAIN_HEIGHT,
      z: rand() * RAIN_REACH * 2,
      speed: 0.85 + rand() * 0.3,
    }));
  }, []);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(DROPS * 6), 3),
    );
    g.setDrawRange(0, 0);
    return g;
  }, []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const shown = useRef(0);

  useFrame(({ clock }) => {
    const rain = ambient.uRain.value;
    const falling = Math.round(DROPS * Math.min(1, rain * 1.1));
    if (falling === 0 && shown.current === 0) return;
    shown.current = falling;
    geometry.setDrawRange(0, falling * 2);
    const t = clock.elapsedTime;
    const wind = ambient.uWindDir.value;
    const { x: px, y: py, z: pz } = ambient.uPlayer.value;
    const wrap = (v: number, n: number) => ((v % n) + n) % n;
    const span = RAIN_REACH * 2;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const lx = wind.x * RAIN_LEAN;
    const lz = wind.y * RAIN_LEAN;
    for (let i = 0; i < falling; i++) {
      const d = drops[i];
      const down = t * RAIN_SPEED * d.speed;
      const y = py - 1 + wrap(d.y - down, RAIN_HEIGHT);
      const x = px - RAIN_REACH + wrap(d.x + lx * down - px, span);
      const z = pz - RAIN_REACH + wrap(d.z + lz * down - pz, span);
      pos.setXYZ(i * 2, x, y, z);
      pos.setXYZ(i * 2 + 1, x + lx * STREAK, y + STREAK, z + lz * STREAK);
    }
    pos.needsUpdate = true;
  });
  return (
    <lineSegments
      geometry={geometry}
      material={rainMaterial}
      frustumCulled={false}
    />
  );
}

/** Keeps the weather's uniforms up to date, and draws the rain. */
export function Weather() {
  useFrame((_, dt) => {
    const step = Math.min(dt, 0.1);
    const w = weatherNow();
    // Eased, so a shower starts as a few drops.
    ambient.uRain.value = MathUtils.damp(
      ambient.uRain.value,
      w.rain,
      RAIN_DAMP,
      step,
    );
    const rain = ambient.uRain.value;
    const wet = ambient.uWet.value;
    const soaked = Math.min(1, rain * 1.3);
    ambient.uWet.value =
      wet < soaked
        ? Math.min(soaked, wet + step / SOAK)
        : Math.max(soaked, wet - step / DRY);
    stepLightning(w.storm, rain, step);
    skyUniforms.uOvercast.value = MathUtils.smoothstep(rain, 0.05, 0.6);
    skyUniforms.uFlash.value = lightning.flash;
    // A rainbow wants the sun up and the sky clearing.
    const sunUp = MathUtils.smoothstep(skyUniforms.uSunDir.value.y, 0.05, 0.25);
    skyUniforms.uRainbow.value = rainbowNow() * sunUp * (1 - rain);
  });
  return <Rain />;
}
