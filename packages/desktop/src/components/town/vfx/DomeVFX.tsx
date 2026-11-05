import { DOME } from "@herzies/shared/combat";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import {
  DOME_FADE_MS,
  domes,
  prune,
  type ShownDome,
  shownRadius,
} from "../combat/domes";
import { groundY, type TownMap } from "../map";

/** Domes drawn at once at most (one per Percussionist casting). */
const MAX = 4;
/** The shell's grid: rings from its top to its rim, and round. */
const RINGS = 18;
const SEGS = 56;
/** The line where it meets the ground: points round, and its rows out
 * from the edge (inner glow, the line, outer glow), with how bright each
 * row is. */
const LINE_SEGS = 112;
const LINE_ROWS = [-0.32, -0.045, 0.045, 0.75] as const;
const LINE_GLOW = [0, 1, 1, 0] as const;
/** How far above the ground the line floats, so it never flickers into
 * it. */
const LIFT = 0.035;
/** How long before it goes down that it starts to flicker, a warning. */
const WARN_MS = 600;
/** A blocked hit's ripple: how fast it spreads over the shell, and for how
 * long. */
const RIPPLE_SPEED = 9;
const RIPPLE_S = 0.6;

const GOLD = new THREE.Color("#ffd36b");
const HOT = new THREE.Color("#fff2c2");

const SHELL_VERT = /* glsl */ `
  attribute float aH;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vH;
  void main() {
    vWorld = position;
    vNormal = normal;
    vH = aH;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

const SHELL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uAlpha;
  uniform float uTime;
  uniform float uFlash;
  uniform vec3 uCenter;
  uniform vec4 uHits[4];
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vH;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorld);
    // Bright where the eye grazes it (its outline, from in or out), faint
    // where it looks straight through.
    float rim = pow(1.0 - abs(dot(n, v)), 2.4);
    float glow = 0.018 + rim * 0.58;
    // Brighter low down, where it meets the ground.
    glow += pow(1.0 - vH, 5.0) * 0.18;
    // A slow shimmer of bands rising over it.
    float band = 0.5 + 0.5 * sin((vWorld.y - uCenter.y) * 5.0 - uTime * 2.2);
    glow += band * band * 0.035 * (0.3 + rim);
    // A soft lattice, so it reads as a shield, not a glass ball.
    vec3 d = normalize(vWorld - uCenter);
    float lat = abs(sin(atan(d.x, d.z) * 9.0)) * abs(sin(acos(clamp(d.y, -1.0, 1.0)) * 9.0));
    glow += smoothstep(0.92, 1.0, lat) * 0.08;
    // Hits it turned away: a ring spreading out from where each struck.
    float ripple = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 h = uHits[i];
      float age = uTime - h.w;
      if (h.w <= 0.0 || age < 0.0 || age > ${RIPPLE_S.toFixed(2)}) continue;
      float dist = distance(vWorld, h.xyz);
      float k = 1.0 - age / ${RIPPLE_S.toFixed(2)};
      float front = exp(-pow((dist - age * ${RIPPLE_SPEED.toFixed(1)}) * 2.6, 2.0));
      ripple += front * k * k + exp(-dist * 2.2) * k * k * k * 0.9;
    }
    glow += ripple * 0.9 + uFlash * 0.35;
    vec3 col = mix(uColor, uHot, clamp(rim * 0.5 + ripple * 0.6 + uFlash * 0.5, 0.0, 1.0));
    gl_FragColor = vec4(col, clamp(glow, 0.0, 1.0) * uAlpha);
  }
`;

const LINE_VERT = /* glsl */ `
  attribute float aGlow;
  varying float vGlow;
  void main() {
    vGlow = aGlow;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

const LINE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uAlpha;
  varying float vGlow;
  void main() {
    // The glow's wings fall off softly; the line itself is near white.
    float g = vGlow * vGlow;
    vec3 col = mix(uColor, uHot, smoothstep(0.82, 1.0, vGlow));
    gl_FragColor = vec4(col, g * uAlpha);
  }
`;

type Slot = {
  shell: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  line: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** What the geometry was last built for (it's rebuilt only when it
   * grows, fades or moves). */
  built: { d: ShownDome | null; r: number };
};

function shellGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const n = (RINGS + 1) * (SEGS + 1);
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(n * 3), 3),
  );
  g.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array(n * 3), 3),
  );
  const h = new Float32Array(n);
  for (let i = 0; i <= RINGS; i++)
    for (let j = 0; j <= SEGS; j++)
      h[i * (SEGS + 1) + j] = Math.cos((i / RINGS) * (Math.PI / 2));
  g.setAttribute("aH", new THREE.BufferAttribute(h, 1));
  const index: number[] = [];
  for (let i = 0; i < RINGS; i++)
    for (let j = 0; j < SEGS; j++) {
      const a = i * (SEGS + 1) + j;
      const b = a + SEGS + 1;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  g.setIndex(index);
  return g;
}

function lineGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const rows = LINE_ROWS.length;
  const n = rows * (LINE_SEGS + 1);
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(n * 3), 3),
  );
  const glow = new Float32Array(n);
  for (let r = 0; r < rows; r++)
    for (let j = 0; j <= LINE_SEGS; j++)
      glow[r * (LINE_SEGS + 1) + j] = LINE_GLOW[r];
  g.setAttribute("aGlow", new THREE.BufferAttribute(glow, 1));
  const index: number[] = [];
  for (let r = 0; r < rows - 1; r++)
    for (let j = 0; j < LINE_SEGS; j++) {
      const a = r * (LINE_SEGS + 1) + j;
      const b = a + LINE_SEGS + 1;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  g.setIndex(index);
  return g;
}

/**
 * Builds a dome of radius `r` at (cx, cz) over the ground: a shell whose
 * every point stands its hemisphere height over the ground beneath it, so
 * on a slope its rim still meets the ground exactly at `r` (the line, and
 * the shelter the server judges); and the line round it, lying on the
 * ground.
 */
function build(slot: Slot, map: TownMap, cx: number, cz: number, r: number) {
  const pos = slot.shell.geometry.getAttribute(
    "position",
  ) as THREE.BufferAttribute;
  const p = pos.array as Float32Array;
  for (let i = 0; i <= RINGS; i++) {
    const th = (i / RINGS) * (Math.PI / 2);
    const d = Math.sin(th) * r;
    const up = Math.cos(th) * r;
    for (let j = 0; j <= SEGS; j++) {
      const ph = (j / SEGS) * Math.PI * 2;
      const x = cx + Math.sin(ph) * d;
      const z = cz + Math.cos(ph) * d;
      const k = (i * (SEGS + 1) + j) * 3;
      p[k] = x;
      p[k + 1] = groundY(map, x, z) + up;
      p[k + 2] = z;
    }
  }
  pos.needsUpdate = true;
  slot.shell.geometry.computeVertexNormals();
  slot.shell.geometry.computeBoundingSphere();

  const lpos = slot.line.geometry.getAttribute(
    "position",
  ) as THREE.BufferAttribute;
  const l = lpos.array as Float32Array;
  for (let row = 0; row < LINE_ROWS.length; row++) {
    const rr = Math.max(0.05, r + LINE_ROWS[row]);
    for (let j = 0; j <= LINE_SEGS; j++) {
      const ph = (j / LINE_SEGS) * Math.PI * 2;
      const x = cx + Math.sin(ph) * rr;
      const z = cz + Math.cos(ph) * rr;
      const k = (row * (LINE_SEGS + 1) + j) * 3;
      l[k] = x;
      l[k + 1] = groundY(map, x, z) + LIFT;
      l[k + 2] = z;
    }
  }
  lpos.needsUpdate = true;
  slot.line.geometry.computeBoundingSphere();
}

/** How bright a dome is at `now`: in as it's cast, a warning flicker
 * before it goes down, and out as it fades. */
function alphaOf(d: ShownDome, now: number): number {
  const appear = Math.min(1, (now - d.castAt) / 90);
  if (now >= d.until) return Math.max(0, 1 - (now - d.until) / DOME_FADE_MS);
  const left = d.until - now;
  if (left < WARN_MS) {
    // Quicker as the end nears.
    const u = 1 - left / WARN_MS;
    const beat = Math.cos(now / (55 - u * 30));
    return appear * (0.72 + 0.28 * beat);
  }
  return appear;
}

/**
 * The Cymbrella's dome: a gold shield standing where it was cast, a bright
 * line where it meets the ground, growing from round its caster and
 * shoving enemies out as it goes (the server moves them; this is drawn
 * from the same numbers, a beat behind so the edge meets them). A hit it
 * turns away ripples from where it struck. Pooled; nothing is made while
 * fighting.
 */
export function DomeVFX({ map }: { map: TownMap }) {
  const scene = useThree((s) => s.scene);
  const slots = useMemo<Slot[]>(
    () =>
      Array.from({ length: MAX }, () => {
        const shell = new THREE.Mesh(
          shellGeometry(),
          new THREE.ShaderMaterial({
            vertexShader: SHELL_VERT,
            fragmentShader: SHELL_FRAG,
            uniforms: {
              uColor: { value: GOLD.clone() },
              uHot: { value: HOT.clone() },
              uAlpha: { value: 0 },
              uTime: { value: 0 },
              uFlash: { value: 0 },
              uCenter: { value: new THREE.Vector3() },
              uHits: {
                value: Array.from({ length: 4 }, () => new THREE.Vector4()),
              },
            },
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
          }),
        );
        const line = new THREE.Mesh(
          lineGeometry(),
          new THREE.ShaderMaterial({
            vertexShader: LINE_VERT,
            fragmentShader: LINE_FRAG,
            uniforms: {
              uColor: { value: GOLD.clone() },
              uHot: { value: HOT.clone() },
              uAlpha: { value: 0 },
            },
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            polygonOffset: true,
            polygonOffsetFactor: -2,
          }),
        );
        for (const m of [shell, line]) {
          m.frustumCulled = false;
          m.visible = false;
        }
        shell.renderOrder = 8;
        line.renderOrder = 7;
        return { shell, line, built: { d: null, r: -1 } };
      }),
    [],
  );

  useEffect(() => {
    for (const s of slots) scene.add(s.shell, s.line);
    return () => {
      for (const s of slots) {
        scene.remove(s.shell, s.line);
        for (const m of [s.shell, s.line]) {
          m.geometry.dispose();
          m.material.dispose();
        }
      }
    };
  }, [scene, slots]);

  useFrame(() => {
    const now = performance.now();
    prune(now);
    const t = now / 1000;
    let n = 0;
    for (const d of domes) {
      if (n >= MAX) break;
      if (now < d.castAt) continue;
      const slot = slots[n++];
      const r = shownRadius(d, now);
      if (slot.built.d !== d || Math.abs(slot.built.r - r) > 1e-3) {
        build(slot, map, d.x, d.z, r);
        slot.built = { d, r };
      }
      const alpha = alphaOf(d, now);
      const su = slot.shell.material.uniforms;
      su.uAlpha.value = alpha;
      su.uTime.value = t;
      // A flash as it lands at full size.
      const landed = now - (d.from + DOME.growMs);
      su.uFlash.value = landed >= 0 ? Math.exp(-landed / 140) : 0;
      (su.uCenter.value as THREE.Vector3).set(d.x, groundY(map, d.x, d.z), d.z);
      const hits = su.uHits.value as THREE.Vector4[];
      for (let i = 0; i < 4; i++) {
        const h = d.hits[d.hits.length - 1 - i];
        if (!h) {
          hits[i].set(0, 0, 0, 0);
          continue;
        }
        // Where on the shell it struck: toward where it came from, a
        // little up the side.
        const dx = h.x - d.x;
        const dz = h.z - d.z;
        const l = Math.hypot(dx, dz) || 1;
        const hx = d.x + (dx / l) * r * 0.9;
        const hz = d.z + (dz / l) * r * 0.9;
        hits[i].set(hx, groundY(map, hx, hz) + r * 0.45, hz, h.at / 1000);
      }
      slot.shell.visible = true;
      const lu = slot.line.material.uniforms;
      lu.uAlpha.value =
        Math.min(1, alpha * 1.15) * (0.85 + su.uFlash.value * 0.3);
      slot.line.visible = true;
    }
    for (; n < MAX; n++) {
      slots[n].shell.visible = false;
      slots[n].line.visible = false;
      slots[n].built.d = null;
    }
  });

  return null;
}
