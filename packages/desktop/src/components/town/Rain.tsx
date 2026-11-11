import { mulberry32 } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { MathUtils } from "three";
import { ambient } from "./ambient";
import { skyUniforms } from "./Islands";
import { groundY, type TownMap } from "./map";
import { lightning, rainbowNow, stepLightning, weatherNow } from "./weather";

// The weather, applied (see weather.ts for when it rains): the rain
// itself, as streaks falling round the player; the ground going dark and
// wet under it, and drying after; the lightning in a storm; and the
// rainbow once a shower's passed. The sky and the lights go grey under it
// in DayLight, which reads the same uniforms.

/** How many streaks fall at the hardest rain, in a box this far round
 * the player and this high. */
const DROPS = 700;
const RAIN_REACH = 11;
const RAIN_HEIGHT = 11;
/** How fast they fall, and how long each streak is. */
const RAIN_SPEED = 14;
const STREAK = 0.55;
/** The last of a drop's fall (a fraction) it spends splashing. */
const SPLASH_FALL = 0.04;
/** How much the wind leans the rain. */
const RAIN_LEAN = 0.3;
/** The ground takes this long to soak through (s), and this long to dry. */
const SOAK = 45;
const DRY = 240;
/** How quickly the rain comes on and goes off, as shown (per second). */
const RAIN_DAMP = 0.6;

/** Streaks: bright at the foot, fading to nothing up the tail, so each
 * reads as a falling drop rather than a stick; lit as the scene is, so
 * rain at night is dark. Alpha is per vertex. */
const rainMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uLight: ambient.uLight, uRain: ambient.uRain },
  vertexShader: /* glsl */ `
    attribute float alpha;
    varying float vAlpha;
    void main() {
      vec4 mv = modelViewMatrix * vec4( position, 1.0 );
      // Faint right at the camera and far off, clearest in between.
      float depth = -mv.z;
      vAlpha = alpha * smoothstep( 1.5, 6.0, depth ) * ( 1.0 - smoothstep( 14.0, 26.0, depth ) );
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uLight;
    varying float vAlpha;
    void main() {
      if ( vAlpha <= 0.01 ) discard;
      gl_FragColor = vec4( vec3( 0.82, 0.9, 0.98 ) * max( uLight, vec3( 0.25 ) ), vAlpha * 0.75 );
      #include <colorspace_fragment>
    }
  `,
});

/** Rain falling round the player: streaks on the wind, wrapped round a
 * box so it never runs out, like the snow — and a flat ring of splash
 * where each one lands. */
function Rain({ map }: { map: TownMap }) {
  const drops = useMemo(() => {
    const rand = mulberry32(1111);
    return Array.from({ length: DROPS }, () => ({
      x: rand() * RAIN_REACH * 2,
      y: rand() * RAIN_HEIGHT,
      z: rand() * RAIN_REACH * 2,
      speed: 0.85 + rand() * 0.3,
    }));
  }, []);
  /** Streaks (two vertices each) then splashes (four: a flat "—"). */
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(DROPS * 6), 3),
    );
    g.setAttribute(
      "alpha",
      new THREE.BufferAttribute(new Float32Array(DROPS * 2), 1),
    );
    g.setDrawRange(0, 0);
    return g;
  }, []);
  const splashes = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(DROPS * 12), 3),
    );
    g.setAttribute(
      "alpha",
      new THREE.BufferAttribute(new Float32Array(DROPS * 4), 1),
    );
    g.setDrawRange(0, 0);
    return g;
  }, []);
  useLayoutEffect(
    () => () => {
      geometry.dispose();
      splashes.dispose();
    },
    [geometry, splashes],
  );
  const shown = useRef(0);

  useFrame(({ clock }) => {
    const rain = ambient.uRain.value;
    const falling = Math.round(DROPS * Math.min(1, rain * 1.1));
    if (falling === 0 && shown.current === 0) return;
    shown.current = falling;
    geometry.setDrawRange(0, falling * 2);
    splashes.setDrawRange(0, falling * 4);
    const t = clock.elapsedTime;
    const wind = ambient.uWindDir.value;
    const { x: px, z: pz } = ambient.uPlayer.value;
    const wrap = (v: number, n: number) => ((v % n) + n) % n;
    const span = RAIN_REACH * 2;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const alpha = geometry.attributes.alpha as THREE.BufferAttribute;
    const spos = splashes.attributes.position as THREE.BufferAttribute;
    const salpha = splashes.attributes.alpha as THREE.BufferAttribute;
    const lx = wind.x * RAIN_LEAN;
    const lz = wind.y * RAIN_LEAN;
    for (let i = 0; i < falling; i++) {
      const d = drops[i];
      const down = t * RAIN_SPEED * d.speed;
      const x = px - RAIN_REACH + wrap(d.x + lx * down - px, span);
      const z = pz - RAIN_REACH + wrap(d.z + lz * down - pz, span);
      const ground = groundY(map, x, z);
      // How far down its fall (0 at the top, 1 at the ground).
      const fall = wrap(d.y - down, RAIN_HEIGHT) / RAIN_HEIGHT;
      const y = ground + fall * RAIN_HEIGHT;
      pos.setXYZ(i * 2, x, y, z);
      pos.setXYZ(i * 2 + 1, x + lx * STREAK, y + STREAK, z + lz * STREAK);
      alpha.setX(i * 2, 1);
      alpha.setX(i * 2 + 1, 0);
      // Landed (the last sliver of its fall): a splash that spreads a
      // moment and fades.
      const landed = fall < SPLASH_FALL;
      const k = landed ? 1 - fall / SPLASH_FALL : 1;
      const r = 0.06 + k * 0.14;
      const a = landed ? 1 - k : 0;
      const gy = ground + 0.03;
      spos.setXYZ(i * 4, x - r, gy, z);
      spos.setXYZ(i * 4 + 1, x - r * 0.4, gy, z);
      spos.setXYZ(i * 4 + 2, x + r * 0.4, gy, z);
      spos.setXYZ(i * 4 + 3, x + r, gy, z);
      salpha.setX(i * 4, 0);
      salpha.setX(i * 4 + 1, a);
      salpha.setX(i * 4 + 2, a);
      salpha.setX(i * 4 + 3, 0);
    }
    pos.needsUpdate = true;
    alpha.needsUpdate = true;
    spos.needsUpdate = true;
    salpha.needsUpdate = true;
  });
  return (
    <>
      <lineSegments
        geometry={geometry}
        material={rainMaterial}
        frustumCulled={false}
      />
      <lineSegments
        geometry={splashes}
        material={rainMaterial}
        frustumCulled={false}
      />
    </>
  );
}

/** Keeps the weather's uniforms up to date, and draws the rain. */
export function Weather({ map }: { map: TownMap }) {
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
  return <Rain map={map} />;
}
