import { mulberry32 } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { MathUtils } from "three";
import { ambient } from "./ambient";
import { skyUniforms } from "./Islands";
import { groundY, type TownMap } from "./map";
import { lightning, rainbowNow, stepLightning, weatherNow } from "./weather";

// The weather, applied (see weather.ts for when it rains): the ground
// going dark and wet under it, and drying after; the splashes where drops
// land; the lightning in a storm; and the rainbow once a shower's passed.
// The falling rain itself is drawn over the frame (see
// vfx/rainOverlay.ts); the sky and the lights go grey under it in
// DayLight, which reads the same uniforms.

/** How many splashes can be going at once, near the player. */
const SPLASHES = 110;
/** How far from the player they land, and how long each lasts (s). */
const SPLASH_REACH = 9;
const SPLASH_LIFE = 0.36;
/** Each is a ring of this many segments. */
const RING = 8;
/** The ground takes this long to soak through (s), and this long to dry. */
const SOAK = 45;
const DRY = 240;
/** How quickly the rain comes on and goes off, as shown (per second). */
const RAIN_DAMP = 0.6;

/** The ring's corners, unit size. */
const RING_AT = Array.from({ length: RING }, (_, i) => {
  const a = (i / RING) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)] as const;
});

/** Lines with a fade per vertex, lit as the scene is (so rain at night is
 * dark), and faint right at the camera and far off. */
const splashMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uLight: ambient.uLight },
  vertexShader: /* glsl */ `
    attribute float alpha;
    varying float vAlpha;
    void main() {
      vec4 mv = modelViewMatrix * vec4( position, 1.0 );
      float depth = -mv.z;
      vAlpha = alpha * smoothstep( 1.5, 5.0, depth ) * ( 1.0 - smoothstep( 16.0, 28.0, depth ) );
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uLight;
    varying float vAlpha;
    void main() {
      if ( vAlpha <= 0.01 ) discard;
      gl_FragColor = vec4( vec3( 0.82, 0.9, 0.98 ) * max( uLight, vec3( 0.3 ) ), vAlpha * 0.8 );
      #include <colorspace_fragment>
    }
  `,
});

/**
 * Where drops land: a ring that starts as a speck and spreads and fades —
 * the usual splash of a pixel-art game, kept apart from the falling rain
 * and only near the player, where it can be seen. Each is placed once,
 * where it lands, and costs nothing to keep; the ring's ground is read
 * when it's born, not every frame.
 */
function Splashes({ map }: { map: TownMap }) {
  const rand = useMemo(() => mulberry32(2222), []);
  const spots = useMemo(
    () =>
      Array.from({ length: SPLASHES }, () => ({
        x: 0,
        y: 0,
        z: 0,
        born: Number.NEGATIVE_INFINITY,
      })),
    [],
  );
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(SPLASHES * RING * 6), 3),
    );
    g.setAttribute(
      "alpha",
      new THREE.BufferAttribute(new Float32Array(SPLASHES * RING * 2), 1),
    );
    g.setDrawRange(0, 0);
    return g;
  }, []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);
  const shown = useRef(0);

  useFrame(({ clock }) => {
    const rain = ambient.uRain.value;
    const count = Math.round(SPLASHES * Math.min(1, rain * 1.15));
    if (count === 0 && shown.current === 0) return;
    shown.current = count;
    geometry.setDrawRange(0, count * RING * 2);
    const t = clock.elapsedTime;
    const { x: px, z: pz } = ambient.uPlayer.value;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const alpha = geometry.attributes.alpha as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const s = spots[i];
      let age = (t - s.born) / SPLASH_LIFE;
      if (age >= 1) {
        // Lands somewhere new (a little while from now, so they don't
        // all go off at once).
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * SPLASH_REACH;
        s.x = px + Math.cos(a) * r;
        s.z = pz + Math.sin(a) * r;
        s.y = groundY(map, s.x, s.z) + 0.03;
        s.born = t + rand() * SPLASH_LIFE;
        age = (t - s.born) / SPLASH_LIFE;
      }
      const live = age >= 0;
      const k = live ? age : 0;
      // A speck at first, quickly widening and slowing, wider than it is
      // deep (it's flat on the ground).
      const spread = 0.03 + 0.2 * (1 - (1 - k) * (1 - k));
      const a = live ? (1 - k) * (1 - k) * 0.9 : 0;
      for (let j = 0; j < RING; j++) {
        const p = RING_AT[j];
        const n = RING_AT[(j + 1) % RING];
        const v = (i * RING + j) * 2;
        pos.setXYZ(v, s.x + p[0] * spread, s.y, s.z + p[1] * spread * 0.8);
        pos.setXYZ(v + 1, s.x + n[0] * spread, s.y, s.z + n[1] * spread * 0.8);
        alpha.setX(v, a);
        alpha.setX(v + 1, a);
      }
    }
    pos.needsUpdate = true;
    alpha.needsUpdate = true;
  });
  return (
    <lineSegments
      geometry={geometry}
      material={splashMaterial}
      frustumCulled={false}
    />
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
  return <Splashes map={map} />;
}
