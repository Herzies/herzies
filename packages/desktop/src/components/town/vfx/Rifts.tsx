import { RARITY_COLORS } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { LootTier } from "../sfx";

/**
 * The little black holes things drop out of while you listen (see
 * HomeDrops): one opens out of nothing, from a single point, works away
 * for a moment as if deciding what to give you — its rim flickering
 * through the rarities and settling on the one it picked — lets go of it,
 * then shrinks back into a point and is gone. Taken back (a drop picked up
 * somewhere else), one opens over it just long enough to draw it in.
 *
 * Drawn as a disc that always faces you: the black middle, a bright thin
 * ring round it (a black hole on the app's near-black background is only
 * seen by its light), a swirl of glowing matter spiralling in, and motes
 * drawn in from round it.
 */

/** Every knob in one place, so the feel can be tuned without hunting. */
export const RIFT = {
  /** Opening, from a point, with a little overshoot. */
  openMs: 300,
  /** Working away before it lets go (rarer things take longer). */
  workMs: 1_000,
  workPerTierMs: 90,
  /** Its rim settles on what it picked this long before letting go. */
  settleMs: 280,
  /** The kick as it lets go. */
  kickMs: 170,
  kick: 0.22,
  /** After letting go, it hangs on this long, then closes up. */
  lingerMs: 160,
  closeMs: 320,
  /** The flash as it closes into a point. */
  flashMs: 200,
  /** How big it is (world units, its outer edge), by tier. */
  radius: [0.62, 0.68, 0.74, 0.82, 0.9],
  /** How high its middle hangs over the ground. */
  height: 1.55,
  /** Taken back: open, draw it in, close — quicker. */
  vanishOpenMs: 200,
  vanishPullMs: 420,
} as const;

/** The rarities its rim flickers through while it works. */
const FLICKER = (
  ["common", "uncommon", "rare", "legendary", "mythic"] as const
).map((r) => new THREE.Color(RARITY_COLORS[r]));

export type Rift = {
  key: string;
  /** Where its middle is. */
  at: THREE.Vector3;
  tier: LootTier;
  /** What it settles on: the rarity's colour. */
  color: THREE.Color;
  /** performance.now() ms: opening, letting go, starting to close. */
  openAt: number;
  ejectAt: number;
  closeAt: number;
  /** Open just to take something back: no working, no flicker. */
  vanish: boolean;
};

/** How long a summoning rift works before letting go, for a `tier`. */
export function riftWorkMs(tier: LootTier): number {
  return RIFT.workMs + tier * RIFT.workPerTierMs;
}

/** When a rift opened at `openAt` has finished (closed and flashed). */
export function riftEndsAt(r: Rift): number {
  return r.closeAt + RIFT.closeMs + RIFT.flashMs;
}

const easeOutBack = (t: number) => {
  const c = 1.9;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};
const easeInBack = (t: number) => {
  const c = 1.7;
  return (c + 1) * t * t * t - c * t * t;
};

/** How open it is (its size, 0..~1.2) and how hard it's working, at
 * `now`. */
export function riftShape(
  r: Rift,
  now: number,
): { size: number; work: number; flash: number } {
  const open = r.vanish ? RIFT.vanishOpenMs : RIFT.openMs;
  const t = now - r.openAt;
  if (t < 0) return { size: 0, work: 0, flash: 0 };
  let size = t < open ? Math.max(0, easeOutBack(t / open)) : 1;
  // Working: it breathes, a little quicker as it goes.
  const working = Math.max(
    0,
    Math.min(1, t / Math.max(1, r.ejectAt - r.openAt)),
  );
  if (!r.vanish && now < r.ejectAt)
    size *= 1 + 0.04 * Math.sin((t / 1000) * Math.PI * 2 * (1.5 + working * 3));
  // The kick as it lets go: out, and back.
  const k = now - r.ejectAt;
  if (k >= 0 && k < RIFT.kickMs)
    size *= 1 + RIFT.kick * Math.sin((k / RIFT.kickMs) * Math.PI);
  // Closing up into a point.
  const c = now - r.closeAt;
  if (c >= 0)
    size *= Math.max(0, 1 - easeInBack(Math.min(1, c / RIFT.closeMs)));
  // A flash as it lets go, and as it winks out.
  let flash = 0;
  if (k >= 0 && k < RIFT.flashMs) flash = 1 - k / RIFT.flashMs;
  const f = c - RIFT.closeMs;
  if (f >= 0 && f < RIFT.flashMs) flash = Math.max(flash, 1 - f / RIFT.flashMs);
  const work = r.vanish ? 0.5 : now < r.ejectAt ? 0.3 + 0.7 * working : 0.4;
  return { size, work, flash };
}

/** Its rim's colour at `now`: flickering through the rarities while it
 * works, faster and faster, then settling on the one it picked. */
export function riftTint(r: Rift, now: number, out: THREE.Color): THREE.Color {
  if (r.vanish) return out.copy(r.color);
  const left = r.ejectAt - now;
  if (left <= RIFT.settleMs) {
    // Eased onto the real one.
    const t = 1 - Math.max(0, left) / RIFT.settleMs;
    const from = flickerAt(r, r.ejectAt - RIFT.settleMs);
    return out.copy(from).lerp(r.color, t * t * (3 - 2 * t));
  }
  return out.copy(flickerAt(r, now));
}

function flickerAt(r: Rift, now: number): THREE.Color {
  // Steps through the rarities, quickening (its phase grows with t²).
  const t = Math.max(0, now - r.openAt) / 1000;
  const i = Math.floor(t * 3 + t * t * 6) % FLICKER.length;
  return FLICKER[i];
}

function holeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWork: { value: 0 },
      uTint: { value: new THREE.Color() },
      uFlash: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uWork;
      uniform vec3 uTint;
      uniform float uFlash;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;
        float a = atan(p.y, p.x);
        // The swirl, spiralling in, faster as it works.
        float speed = 1.4 + uWork * 5.0;
        float swirl = a + 3.6 / (r + 0.28) - uTime * speed;
        float bands = noise(vec2(swirl * 2.2, r * 5.0 - uTime * 1.3));
        bands += 0.5 * noise(vec2(swirl * 5.5, r * 11.0 + uTime * 2.0));
        float disk = smoothstep(1.0, 0.55, r) * smoothstep(0.34, 0.5, r);
        disk *= 0.3 + 0.7 * smoothstep(0.45, 1.2, bands);
        // The bright thin ring at the edge of the dark.
        float ring = exp(-pow((r - 0.4) / 0.045, 2.0));
        // The dark itself, edged soft.
        float core = 1.0 - smoothstep(0.33, 0.39, r);
        vec3 hot = mix(uTint, vec3(1.0), 0.55);
        vec3 color = uTint * disk * (1.1 + uWork * 0.6) + hot * ring * (1.6 + uWork);
        color += vec3(1.0) * uFlash * smoothstep(0.9, 0.0, r);
        float alpha = clamp(disk * 0.95 + ring + core + uFlash * smoothstep(0.9, 0.0, r), 0.0, 1.0);
        color = mix(color, vec3(0.0), core * (1.0 - uFlash));
        gl_FragColor = vec4(color, alpha);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
}

/** Motes drawn in from round it, spiralling into the dark: worked out on
 * the GPU from the time, in the disc's own plane. */
function motesMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uTint: { value: new THREE.Color() },
      uStrength: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uStrength;
      attribute float aSeed;
      varying float vAlpha;
      void main() {
        float t = fract(uTime * (0.6 + uStrength * 0.9) + aSeed);
        float a = aSeed * 40.0 + t * 6.0;
        float r = mix(2.2, 0.35, t * t);
        vec3 p = vec3(cos(a) * r, sin(a) * r, 0.0);
        vAlpha = uStrength * smoothstep(0.0, 0.2, t) * (1.0 - smoothstep(0.8, 1.0, t));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = max(1.0, 0.06 * 220.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = (1.0 - smoothstep(0.15, 0.5, length(c))) * vAlpha;
        gl_FragColor = vec4(mix(uTint, vec3(1.0), 0.5), a);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
}

const MOTES = 36;
const moteGeometry = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(MOTES * 3), 3),
  );
  const seeds = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) seeds[i] = i / MOTES + Math.random() * 0.02;
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  return g;
})();
const discGeometry = new THREE.PlaneGeometry(2, 2);

/** One rift, drawn from its timeline every frame. `onGroup` hands its
 * group over (HomeDrops puts it on Home's layer). */
export function RiftView({
  rift,
  onGroup,
}: {
  rift: Rift;
  onGroup?: (group: THREE.Group | null) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const hole = useMemo(holeMaterial, []);
  const motes = useMemo(motesMaterial, []);
  const tint = useMemo(() => new THREE.Color(), []);
  const radius = RIFT.radius[rift.tier];
  useLayoutEffect(() => {
    onGroup?.(group.current);
    return () => {
      onGroup?.(null);
      hole.dispose();
      motes.dispose();
    };
  }, [hole, motes, onGroup]);

  useFrame(({ camera, clock }) => {
    const g = group.current;
    if (!g) return;
    const now = performance.now();
    const shape = riftShape(rift, now);
    g.visible = shape.size > 0.002 || shape.flash > 0.002;
    if (!g.visible) return;
    g.position.copy(rift.at);
    // Always facing you.
    g.quaternion.copy(camera.quaternion);
    // Even at nothing, the flash still shows: a point of light.
    g.scale.setScalar(radius * Math.max(shape.size, shape.flash * 0.35));
    riftTint(rift, now, tint);
    hole.uniforms.uTime.value = clock.elapsedTime;
    hole.uniforms.uWork.value = shape.work;
    hole.uniforms.uFlash.value = shape.flash;
    (hole.uniforms.uTint.value as THREE.Color).copy(tint);
    motes.uniforms.uTime.value = clock.elapsedTime;
    motes.uniforms.uStrength.value =
      now < rift.ejectAt ? shape.work * Math.min(1, shape.size) : 0;
    (motes.uniforms.uTint.value as THREE.Color).copy(tint);
  });

  return (
    <group ref={group} visible={false}>
      <mesh geometry={discGeometry} material={hole} renderOrder={2} />
      <points
        geometry={moteGeometry}
        material={motes}
        frustumCulled={false}
        renderOrder={3}
      />
    </group>
  );
}
