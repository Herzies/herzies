import { FORBIDDEN_FREQUENCY } from "@herzies/shared";
import {
  BOSS_STAND,
  DISC_RANGE,
  DISC_SPEED,
  HERZIE_BODY,
  WAVE_HAND_HEIGHT,
} from "@herzies/shared/combat";
import { MOB } from "@herzies/shared/tower";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import {
  type Bleed,
  discLanded,
  pruneBleeds,
  walkBleeds,
} from "../combat/bleeds";
import { liveDummies } from "../combat/Dummies";
import { DUMMY } from "../combat/dummy";
import { bossFight, bossNow } from "../combat/fight";
import { entityAt, skills } from "../combat/skills";
import { groundY, type TownMap } from "../map";

/** Bleeding things drawn at once at most, glitch specks round each (per
 * stack), and Forbidden Frequency discs in the air at once. */
const MAX = 12;
const SPECKS = 7;
const MAX_DISCS = 6;
/** How long a fresh stack's flare lasts, and the fade at a bleed's end. */
const FLARE_MS = 260;
const FADE_MS = 400;

/** The aura: a band round the body with a corrupted waveform running
 * round it, blocks of it jumping sideways, a cyan ghost split off it;
 * louder and wilder with more stacks (uIntensity, 1/3 to 1), flaring as a
 * stack lands. */
const AURA_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uAlpha;
  uniform float uFlare;
  varying vec2 vUv;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    float t = uTime;
    float x = vUv.x;
    float block = floor(vUv.y * 6.0) + floor(t * 14.0) * 7.0;
    x += (hash(block) - 0.5) * 0.14 * uIntensity * step(0.55, hash(block + 3.1));
    float w = 0.5 + (0.12 + 0.14 * uIntensity)
      * sin(x * 31.4159 + t * 9.0) * (0.6 + 0.4 * sin(x * 81.68 - t * 23.0));
    w += (hash(floor(x * 48.0) + floor(t * 20.0)) - 0.5) * 0.16 * uIntensity;
    float line = smoothstep(0.06, 0.0, abs(vUv.y - w));
    float ghost = smoothstep(0.05, 0.0, abs(vUv.y - w - 0.05));
    float edge = smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
    vec3 col = vec3(0.62, 0.2, 1.0) * line + vec3(0.1, 0.9, 1.0) * ghost * 0.6
      + vec3(1.0, 0.3, 0.8) * uFlare;
    float a = ((line + ghost * 0.6) * (0.5 + 0.5 * uIntensity) + uFlare * 0.2)
      * edge * uAlpha;
    gl_FragColor = vec4(col, a);
  }
`;

const hash = (n: number) => {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
};

/** Where a bleeding thing is now: its feet, its middle's radius and its
 * height. Filled in, not made, each frame. */
const spot = { x: 0, ground: 0, z: 0, radius: 0, height: 0 };
const bossAt = { x: 0, z: 0, yaw: 0 };

/** Finds bleed `b`'s target into {@link spot}; false if it isn't drawn
 * (left, fallen, out of sight). */
function findTarget(b: Bleed, map: TownMap): boolean {
  const t = b.target;
  if (t.kind === "herzie") {
    const at = entityAt.get(t.id);
    if (!at) return false;
    spot.x = at.x;
    spot.z = at.z;
    spot.ground = groundY(map, at.x, at.z);
    spot.height = Math.max(0.5, at.top - spot.ground);
    spot.radius = HERZIE_BODY.radius + 0.12;
    return true;
  }
  if (t.kind === "boss") {
    if (!bossFight.on || bossFight.tower) return false;
    bossNow(undefined, bossAt);
    spot.x = bossAt.x;
    spot.z = bossAt.z;
    spot.ground = 0;
    spot.height = BOSS_STAND.top;
    spot.radius = BOSS_STAND.radius + 0.2;
    return true;
  }
  for (const d of liveDummies) {
    if (t.kind === "mob" ? d.mob !== t.id : d.key !== t.key) continue;
    const size = d.size ?? 1;
    const mob = t.kind === "mob";
    spot.x = d.x;
    spot.z = d.z;
    spot.ground = d.y ?? 0;
    spot.height = mob ? MOB.top * size : DUMMY.top;
    spot.radius = (mob ? MOB.radius : DUMMY.radius) * size + 0.12;
    return true;
  }
  return false;
}

/**
 * Forbidden Frequency, for everyone in the room: its disc, dark and
 * glitching, flying out along the throw until it lands (or reaches as far
 * as a disc goes); and on whatever bleeds, a corrupted soundwave round its
 * body and specks of static rising off it, wilder with each stack, until
 * the bleed runs out (its stacks show by the health bar: BleedDrop).
 * Pooled: a mesh per aura and disc, one points cloud; nothing is made
 * while fighting.
 */
export function BleedVFX({ map }: { map: TownMap }) {
  const fx = useMemo(() => {
    const group = new THREE.Group();

    const auraGeo = new THREE.CylinderGeometry(1, 1, 1, 40, 1, true);
    const auras = Array.from({ length: MAX }, () => {
      const m = new THREE.Mesh(
        auraGeo,
        new THREE.ShaderMaterial({
          uniforms: {
            uTime: { value: 0 },
            uIntensity: { value: 0 },
            uAlpha: { value: 1 },
            uFlare: { value: 0 },
          },
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: AURA_FRAG,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          fog: false,
        }),
      );
      m.visible = false;
      m.renderOrder = 8;
      group.add(m);
      return m;
    });

    const speckCount = MAX * SPECKS * FORBIDDEN_FREQUENCY.maxStacks;
    const speckPos = new Float32Array(speckCount * 3);
    const speckCol = new Float32Array(speckCount * 3);
    for (let i = 0; i < speckCount; i++) {
      // Mostly violet, now and then a cyan or a hot pink one.
      const r = hash(i * 7.31);
      const c =
        r < 0.6 ? [0.65, 0.25, 1] : r < 0.8 ? [0.2, 0.9, 1] : [1, 0.3, 0.8];
      speckCol.set(c, i * 3);
    }
    const speckGeo = new THREE.BufferGeometry();
    const speckAttr = new THREE.BufferAttribute(speckPos, 3);
    speckAttr.setUsage(THREE.DynamicDrawUsage);
    speckGeo.setAttribute("position", speckAttr);
    speckGeo.setAttribute("color", new THREE.BufferAttribute(speckCol, 3));
    speckGeo.setDrawRange(0, 0);
    const speckMat = new THREE.PointsMaterial({
      size: 0.075,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const specks = new THREE.Points(speckGeo, speckMat);
    specks.frustumCulled = false;
    specks.renderOrder = 9;
    group.add(specks);

    const discGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.04, 24);
    const discMat = new THREE.MeshStandardMaterial({
      color: 0x2a0b3d,
      roughness: 0.35,
      metalness: 0.4,
      emissive: 0x8a2cff,
      emissiveIntensity: 0.8,
    });
    const discs = Array.from({ length: MAX_DISCS }, () => {
      const m = new THREE.Mesh(discGeo, discMat);
      m.visible = false;
      group.add(m);
      return m;
    });

    return {
      group,
      auras,
      auraGeo,
      specks,
      speckCount,
      speckAttr,
      speckGeo,
      speckMat,
      discs,
      discGeo,
      discMat,
    };
  }, []);

  useEffect(
    () => () => {
      fx.auraGeo.dispose();
      for (const a of fx.auras) (a.material as THREE.Material).dispose();
      fx.speckGeo.dispose();
      fx.speckMat.dispose();
      fx.discGeo.dispose();
      fx.discMat.dispose();
    },
    [fx],
  );

  /** One frame's walk over the bleeds: its counters, and the visitor
   * (made once, so walking the map makes nothing). */
  const walk = useMemo(() => {
    const state = { now: 0, aura: 0, speck: 0 };
    const visit = (b: Bleed) => {
      if (state.aura >= fx.auras.length || !findTarget(b, map)) return;
      const now = state.now;
      const alpha = Math.min(1, Math.max(0, (b.until - now) / FADE_MS));
      const flare = Math.max(0, 1 - (now - b.landedAt) / FLARE_MS);
      const stacks = Math.min(FORBIDDEN_FREQUENCY.maxStacks, b.stacks);
      const intensity = stacks / FORBIDDEN_FREQUENCY.maxStacks;

      const aura = fx.auras[state.aura++];
      aura.visible = true;
      aura.position.set(spot.x, spot.ground + spot.height * 0.5, spot.z);
      aura.scale.set(
        spot.radius * (1 + 0.08 * flare),
        spot.height * 0.7,
        spot.radius * (1 + 0.08 * flare),
      );
      const u = (aura.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = now / 1000 + spot.x * 0.13;
      u.uIntensity.value = intensity;
      u.uAlpha.value = alpha;
      u.uFlare.value = flare;

      // Static rising off it: specks drifting up round the body, now and
      // then jumping sideways, as a glitch does.
      const pos = fx.speckAttr.array as Float32Array;
      const n = SPECKS * stacks;
      const t = now / 1000;
      for (let j = 0; j < n && state.speck < fx.speckCount; j++) {
        const seed = j * 12.9898 + (b.landedAt % 997);
        const rise = (hash(seed) + t * (0.45 + 0.3 * hash(seed + 1))) % 1;
        const jump = hash(Math.floor(t * 12) + j * 3.7) > 0.85 ? 0.5 : 0;
        const ang = hash(seed + 2) * Math.PI * 2 + t * 0.8 + jump;
        const r = spot.radius * (0.85 + 0.35 * hash(seed + 3));
        const i = state.speck++ * 3;
        pos[i] = spot.x + Math.cos(ang) * r;
        pos[i + 1] = spot.ground + spot.height * (0.1 + 0.95 * rise);
        pos[i + 2] = spot.z + Math.sin(ang) * r;
      }
    };
    return { state, visit };
  }, [fx, map]);

  useFrame(() => {
    const now = performance.now();
    pruneBleeds(now);

    // Discs in the air: out along the throw until they land, or as far as
    // a disc goes, glitching as they fly.
    let disc = 0;
    for (const c of skills.casts) {
      if (c.skill !== "forbidden-frequency" || disc >= fx.discs.length)
        continue;
      const age = now - c.at;
      const travelled = (age / 1000) * DISC_SPEED;
      const landed = discLanded.get(c.by) ?? Number.NEGATIVE_INFINITY;
      if (travelled >= DISC_RANGE || landed >= c.at) continue;
      const m = fx.discs[disc++];
      m.visible = true;
      const glitch = hash(Math.floor(now / 45) + c.at) > 0.7 ? 0.12 : 0;
      const along = 0.6 + travelled;
      m.position.set(
        c.x + Math.sin(c.yaw) * along + Math.cos(c.yaw) * glitch,
        groundY(map, c.x, c.z) + WAVE_HAND_HEIGHT,
        c.z + Math.cos(c.yaw) * along - Math.sin(c.yaw) * glitch,
      );
      m.rotation.set(0.2, age * 0.04, 0);
    }
    for (; disc < fx.discs.length; disc++) fx.discs[disc].visible = false;

    // Everything bleeding.
    const s = walk.state;
    s.now = now;
    s.aura = 0;
    s.speck = 0;
    walkBleeds(walk.visit);
    for (let i = s.aura; i < fx.auras.length; i++) fx.auras[i].visible = false;
    fx.speckGeo.setDrawRange(0, s.speck);
    if (s.speck > 0) fx.speckAttr.needsUpdate = true;
  });

  return <primitive object={fx.group} />;
}
