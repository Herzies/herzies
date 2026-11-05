import { RIMSHOT } from "@herzies/shared";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { prune, SLAM_AFTER_MS, type Slam, slams } from "../combat/slams";
import type { Vec3 } from "../combat/waves";
import { groundY, type TownMap } from "../map";
import { distortionScene } from "./distortion";
import { FxLayer, SPARK, scatter, useMotes, WHITE } from "./SonicVFX";

/** Slams drawn at once at most. */
const MAX = 4;
const GOLD = new THREE.Color("#ffd36b");
const HOT = new THREE.Color("#fff2c2");
const DUST = new THREE.Color("#8a7a62");
const UP: Vec3 = [0, 1, 0];
/** How far above the ground the rings float, so they never flicker into
 * it. */
const LIFT = 0.04;
/** The shockwave: out to just past the reach this fast, and a slower,
 * wider, fainter one behind it (ms). */
const WAVE_MS = 220;
const WAVE2_MS = 520;
/** Dust and debris per slam. */
const PUFFS = 18;
const CHUNKS = 12;
/** How long the cracks' glow and the dust last (ms). */
const CRACK_GLOW_MS = 220;
const DUST_MS = 900;
const CRACK_SIZE = 4.6;

const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
const easeIn = (t: number) => Math.min(1, Math.max(0, t)) ** 2;

const RING_VERT = /* glsl */ `
  attribute float aGlow;
  varying float vGlow;
  void main() {
    vGlow = aGlow;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;
const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uAlpha;
  varying float vGlow;
  void main() {
    float g = vGlow * vGlow;
    gl_FragColor = vec4(mix(uColor, uHot, smoothstep(0.8, 1.0, vGlow)), g * uAlpha);
  }
`;

const RING_SEGS = 96;
/** A ring's rows across its width (−1 inside to 1 outside) and how bright
 * each is: soft either side of a bright middle. */
const ROWS = [-1, -0.18, 0.18, 1] as const;
const ROW_GLOW = [0, 1, 1, 0] as const;

/** A bright ring lying on the ground, any radius and width. */
class GroundRing {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

  constructor() {
    const g = new THREE.BufferGeometry();
    const n = ROWS.length * (RING_SEGS + 1);
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(n * 3), 3),
    );
    const glow = new Float32Array(n);
    for (let r = 0; r < ROWS.length; r++)
      for (let j = 0; j <= RING_SEGS; j++)
        glow[r * (RING_SEGS + 1) + j] = ROW_GLOW[r];
    g.setAttribute("aGlow", new THREE.BufferAttribute(glow, 1));
    const index: number[] = [];
    for (let r = 0; r < ROWS.length - 1; r++)
      for (let j = 0; j < RING_SEGS; j++) {
        const a = r * (RING_SEGS + 1) + j;
        const b = a + RING_SEGS + 1;
        index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    g.setIndex(index);
    this.mesh = new THREE.Mesh(
      g,
      new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
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
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 7;
  }

  /** On the ground round (cx, cz), `r` out, `width` wide, this bright. */
  show(
    map: TownMap,
    cx: number,
    cz: number,
    r: number,
    width: number,
    alpha: number,
  ) {
    if (alpha <= 0.001 || r <= 0.01) {
      this.mesh.visible = false;
      return;
    }
    const pos = this.mesh.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    for (let row = 0; row < ROWS.length; row++) {
      const rr = Math.max(0.02, r + (ROWS[row] * width) / 2);
      for (let j = 0; j <= RING_SEGS; j++) {
        const a = (j / RING_SEGS) * Math.PI * 2;
        const x = cx + Math.sin(a) * rr;
        const z = cz + Math.cos(a) * rr;
        const k = (row * (RING_SEGS + 1) + j) * 3;
        p[k] = x;
        p[k + 1] = groundY(map, x, z) + LIFT;
        p[k + 2] = z;
      }
    }
    pos.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.material.uniforms.uAlpha.value = alpha;
    this.mesh.visible = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** The cracks a slam leaves: jagged lines out from the middle, drawn once. */
function crackTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.translate(size / 2, size / 2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const arm = (
      angle: number,
      length: number,
      width: number,
      depth: number,
    ) => {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      let x = 0;
      let y = 0;
      let a = angle;
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        a += (rand() - 0.5) * 0.7;
        const d = (length / steps) * (0.7 + rand() * 0.6);
        x += Math.cos(a) * d;
        y += Math.sin(a) * d;
        ctx.lineTo(x, y);
        // Now and then a fork off it.
        if (depth > 0 && rand() < 0.35) {
          ctx.save();
          ctx.translate(x, y);
          arm(
            a + (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.6),
            length * 0.35,
            width * 0.6,
            depth - 1,
          );
          ctx.restore();
          ctx.moveTo(x, y);
        }
      }
      ctx.lineWidth = width;
      ctx.stroke();
    };
    ctx.strokeStyle = "rgba(255,255,255,1)";
    const arms = 9;
    for (let i = 0; i < arms; i++)
      arm(
        (i / arms) * Math.PI * 2 + rand() * 0.5,
        size * (0.3 + rand() * 0.16),
        5 - rand() * 2,
        1,
      );
    // The dent in the middle.
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.12);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

type Puff = {
  alive: boolean;
  at: Vec3;
  vel: Vec3;
  age: number;
  size: number;
};
type Chunk = {
  alive: boolean;
  at: Vec3;
  vel: Vec3;
  spin: Vec3;
  age: number;
  size: number;
};

/**
 * A Rimshot, anyone's, as the eye sees it. Winding up: a ring on the
 * ground at its reach (RIMSHOT.radius) with a glow sweeping out to it as
 * the wind-up runs, landing on the slam; the charge gathering on the
 * stick. The slam (when the herzie's stick strikes): a shockwave racing
 * out with the light bending behind it, a slower wave after, sparks off
 * the stick, dust skimming out low, chunks of ground hopping, and cracks
 * left glowing then fading. Pooled; nothing is made while fighting.
 */
export function SlamVFX({ map }: { map: TownMap }) {
  const scene = useThree((s) => s.scene);
  const parts = useMemo(() => {
    const ring = () => new GroundRing();
    const crackTex = crackTexture();
    const crackGeo = new THREE.PlaneGeometry(1, 1);
    crackGeo.rotateX(-Math.PI / 2);
    const cracks = Array.from({ length: MAX }, () => {
      const dark = new THREE.Mesh(
        crackGeo,
        new THREE.MeshBasicMaterial({
          color: 0x1a120a,
          alphaMap: crackTex,
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          fog: false,
        }),
      );
      const glow = new THREE.Mesh(
        crackGeo,
        new THREE.MeshBasicMaterial({
          color: GOLD,
          alphaMap: crackTex,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          fog: false,
        }),
      );
      for (const m of [dark, glow]) {
        m.visible = false;
        m.frustumCulled = false;
      }
      dark.renderOrder = 6;
      glow.renderOrder = 7;
      return { dark, glow };
    });
    const dust = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 10, 6),
      new THREE.MeshBasicMaterial({
        color: DUST,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        fog: true,
      }),
      PUFFS * MAX,
    );
    const debris = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x5b4a36, roughness: 0.9 }),
      CHUNKS * MAX,
    );
    for (const m of [dust, debris]) {
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    debris.castShadow = true;
    return {
      edges: Array.from({ length: MAX }, ring),
      fills: Array.from({ length: MAX }, ring),
      waves: Array.from({ length: MAX }, ring),
      waves2: Array.from({ length: MAX }, ring),
      crackTex,
      crackGeo,
      cracks,
      dust,
      debris,
      bends: new FxLayer(
        new THREE.TorusGeometry(1, 0.16, 6, 48),
        MAX * 2,
        false,
      ),
      orbs: new FxLayer(new THREE.SphereGeometry(1, 14, 8), MAX, false),
      puffs: Array.from(
        { length: PUFFS * MAX },
        (): Puff => ({
          alive: false,
          at: [0, 0, 0],
          vel: [0, 0, 0],
          age: 0,
          size: 0,
        }),
      ),
      chunks: Array.from(
        { length: CHUNKS * MAX },
        (): Chunk => ({
          alive: false,
          at: [0, 0, 0],
          vel: [0, 0, 0],
          spin: [0, 0, 0],
          age: 0,
          size: 0,
        }),
      ),
      crackOf: new Map<Slam, { index: number; turn: number }>(),
      burst: new WeakSet<Slam>(),
    };
  }, []);
  const motes = useMotes();

  useEffect(() => {
    const rings = [
      ...parts.edges,
      ...parts.fills,
      ...parts.waves,
      ...parts.waves2,
    ];
    for (const r of rings) scene.add(r.mesh);
    for (const c of parts.cracks) scene.add(c.dark, c.glow);
    scene.add(parts.dust, parts.debris, motes.points);
    for (const l of [parts.bends, parts.orbs]) {
      distortionScene.add(l.bend);
      scene.add(l.glow);
    }
    return () => {
      for (const r of rings) {
        scene.remove(r.mesh);
        r.dispose();
      }
      for (const c of parts.cracks) {
        scene.remove(c.dark, c.glow);
        (c.dark.material as THREE.Material).dispose();
        (c.glow.material as THREE.Material).dispose();
      }
      parts.crackGeo.dispose();
      parts.crackTex.dispose();
      scene.remove(parts.dust, parts.debris, motes.points);
      for (const m of [parts.dust, parts.debris]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
        m.dispose();
      }
      for (const l of [parts.bends, parts.orbs]) {
        distortionScene.remove(l.bend);
        scene.remove(l.glow);
        l.dispose();
      }
      motes.dispose();
    };
  }, [parts, scene, motes]);

  const tip = useMemo<Vec3>(() => [0, 0, 0], []);
  const v = useMemo<Vec3>(() => [0, 0, 0], []);
  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const e = useMemo(() => new THREE.Euler(), []);
  const p3 = useMemo(() => new THREE.Vector3(), []);
  const s3 = useMemo(() => new THREE.Vector3(), []);

  /** The slam's first frame: everything thrown off it. */
  const burst = (s: Slam) => {
    const [hx, , hz] = s.hit;
    const hy = groundY(map, hx, hz);
    // Sparks off the stick, up and out.
    for (let i = 0; i < 30; i++) {
      scatter(UP, 1.1, v);
      const speed = 4 + Math.random() * 6;
      motes.spawn(
        [hx, hy + 0.15, hz],
        [v[0] * speed, Math.abs(v[1]) * speed, v[2] * speed],
        {
          life: 0.35 + Math.random() * 0.25,
          size: 0.12 + Math.random() * 0.1,
          kind: SPARK,
          color: Math.random() < 0.4 ? WHITE : GOLD,
          gravity: 9,
          drag: 2.5,
        },
      );
    }
    // Dust skimming out low from where it struck, in a ring.
    let n = 0;
    for (const p of parts.puffs) {
      if (p.alive || n >= PUFFS) continue;
      const a = (n / PUFFS) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 3.5 + Math.random() * 2.5;
      p.alive = true;
      p.age = 0;
      p.size = 0.12 + Math.random() * 0.1;
      p.at = [hx + Math.sin(a) * 0.3, hy + 0.15, hz + Math.cos(a) * 0.3];
      p.vel = [
        Math.sin(a) * speed,
        0.4 + Math.random() * 0.6,
        Math.cos(a) * speed,
      ];
      n++;
    }
    // Chunks of ground, hopping out.
    n = 0;
    for (const c of parts.chunks) {
      if (c.alive || n >= CHUNKS) continue;
      const a = Math.random() * Math.PI * 2;
      const out = 2 + Math.random() * 3;
      c.alive = true;
      c.age = 0;
      c.size = 0.07 + Math.random() * 0.09;
      c.at = [hx, hy + 0.1, hz];
      c.vel = [Math.sin(a) * out, 3.5 + Math.random() * 3, Math.cos(a) * out];
      c.spin = [
        Math.random() * 12 - 6,
        Math.random() * 12 - 6,
        Math.random() * 12 - 6,
      ];
      n++;
    }
    // Cracks, turned any way.
    const used = new Set([...parts.crackOf.values()].map((x) => x.index));
    for (let i = 0; i < MAX; i++)
      if (!used.has(i)) {
        parts.crackOf.set(s, { index: i, turn: Math.random() * Math.PI * 2 });
        break;
      }
  };

  useFrame((_, frameDt) => {
    const now = performance.now();
    const dt = Math.min(frameDt, 0.05);
    prune(now);
    parts.bends.begin();
    parts.orbs.begin();
    const R = RIMSHOT.radius;
    let i = 0;
    for (const s of slams) {
      if (i >= MAX) break;
      const k = i++;
      const gy = groundY(map, s.x, s.z);
      if (s.landedAt === null) {
        // Winding up: the reach, and a glow sweeping out to it.
        const u = Math.min(
          1,
          (now - s.castAt) / Math.max(1, s.dueAt - s.castAt),
        );
        parts.edges[k].show(map, s.x, s.z, R, 0.1, 0.25 + 0.5 * u);
        parts.fills[k].show(map, s.x, s.z, R * easeIn(u), 0.7, 0.45 * u);
        parts.waves[k].mesh.visible = false;
        parts.waves2[k].mesh.visible = false;
        // The charge on the stick: a growing orb, and motes drawn into it.
        if (s.tip) {
          s.tip(tip);
          parts.orbs.add(tip, UP, 0.08 + 0.22 * u, 0.25 + 0.65 * u, GOLD);
          if (Math.random() < dt * 60 * u) {
            scatter(UP, 1.6, v);
            const d = 0.7 + Math.random() * 0.4;
            const life = 0.22;
            motes.spawn(
              [tip[0] + v[0] * d, tip[1] + v[1] * d, tip[2] + v[2] * d],
              [(-v[0] * d) / life, (-v[1] * d) / life, (-v[2] * d) / life],
              { life, size: 0.12, kind: SPARK, color: GOLD },
            );
          }
        }
        continue;
      }
      if (!parts.burst.has(s)) {
        parts.burst.add(s);
        burst(s);
      }
      const t = now - s.landedAt;
      parts.edges[k].show(map, s.x, s.z, R, 0.1, 0.75 * (1 - easeOut(t / 160)));
      parts.fills[k].mesh.visible = false;
      // The shockwave: out past the reach, fast, with the light bending
      // behind it; a slower, wider, fainter one after.
      const w1 = (R + 0.4) * easeOut(t / WAVE_MS);
      const a1 = (1 - Math.min(1, t / (WAVE_MS * 1.8))) ** 2;
      parts.waves[k].show(
        map,
        s.x,
        s.z,
        w1,
        0.35 - 0.2 * easeOut(t / WAVE_MS),
        a1 * 1.2,
      );
      const w2 = R * 1.4 * easeOut(t / WAVE2_MS);
      const a2 = 0.5 * (1 - Math.min(1, t / (WAVE2_MS * 1.3))) ** 2;
      parts.waves2[k].show(map, s.x, s.z, w2, 0.8, a2);
      if (a1 > 0.01)
        parts.bends.add([s.x, gy + 0.25, s.z], UP, Math.max(0.2, w1), a1, GOLD);
      // A flash where the stick struck.
      if (t < 120)
        parts.orbs.add(
          [s.hit[0], groundY(map, s.hit[0], s.hit[2]) + 0.2, s.hit[2]],
          UP,
          0.35 + t * 0.008,
          1 - t / 120,
          HOT,
        );
    }
    for (; i < MAX; i++) {
      for (const r of [
        parts.edges[i],
        parts.fills[i],
        parts.waves[i],
        parts.waves2[i],
      ])
        r.mesh.visible = false;
    }
    parts.bends.end();
    parts.orbs.end();

    // Cracks: glowing at first, then dark, fading out.
    for (const [s, c] of parts.crackOf) {
      const mesh = parts.cracks[c.index];
      const t = s.landedAt === null ? 0 : now - s.landedAt;
      if (s.landedAt === null || t > SLAM_AFTER_MS || !slams.includes(s)) {
        mesh.dark.visible = mesh.glow.visible = false;
        parts.crackOf.delete(s);
        continue;
      }
      const [hx, , hz] = s.hit;
      const y = groundY(map, hx, hz) + 0.02;
      const grow = 0.6 + 0.4 * easeOut(t / 90);
      for (const m of [mesh.dark, mesh.glow]) {
        m.visible = true;
        m.position.set(hx, y, hz);
        m.rotation.y = c.turn;
        m.scale.set(CRACK_SIZE * grow, 1, CRACK_SIZE * grow);
      }
      (mesh.dark.material as THREE.MeshBasicMaterial).opacity =
        0.75 * (1 - easeIn(t / SLAM_AFTER_MS));
      (mesh.glow.material as THREE.MeshBasicMaterial).opacity = Math.exp(
        -t / CRACK_GLOW_MS,
      );
    }

    // Dust: out and slowing, swelling as it thins.
    let n = 0;
    for (const p of parts.puffs) {
      if (!p.alive) continue;
      p.age += dt;
      const u = (p.age * 1000) / DUST_MS;
      if (u >= 1) {
        p.alive = false;
        continue;
      }
      const drag = Math.exp(-dt * 4);
      p.vel[0] *= drag;
      p.vel[2] *= drag;
      p.vel[1] *= drag;
      p.at[0] += p.vel[0] * dt;
      p.at[1] += p.vel[1] * dt;
      p.at[2] += p.vel[2] * dt;
      // Swelling as it thins, and gone by the end.
      const r = p.size * (1 + u * 1.4) * (1 - u) ** 0.6;
      p3.set(p.at[0], p.at[1], p.at[2]);
      s3.setScalar(r);
      m4.compose(p3, q.identity(), s3);
      parts.dust.setMatrixAt(n++, m4);
    }
    parts.dust.count = n;
    parts.dust.instanceMatrix.needsUpdate = true;
    (parts.dust.material as THREE.MeshBasicMaterial).opacity = 0.22;

    // Chunks: hopping out under gravity, settling where they land.
    n = 0;
    for (const c of parts.chunks) {
      if (!c.alive) continue;
      c.age += dt;
      if (c.age > 1.1) {
        c.alive = false;
        continue;
      }
      c.vel[1] -= 22 * dt;
      c.at[0] += c.vel[0] * dt;
      c.at[1] += c.vel[1] * dt;
      c.at[2] += c.vel[2] * dt;
      const floor = groundY(map, c.at[0], c.at[2]) + c.size / 2;
      if (c.at[1] < floor) {
        c.at[1] = floor;
        c.vel[1] = Math.abs(c.vel[1]) * 0.3;
        c.vel[0] *= 0.5;
        c.vel[2] *= 0.5;
      }
      e.set(c.age * c.spin[0], c.age * c.spin[1], c.age * c.spin[2]);
      q.setFromEuler(e);
      p3.set(c.at[0], c.at[1], c.at[2]);
      const shrink = c.age > 0.8 ? 1 - (c.age - 0.8) / 0.3 : 1;
      s3.setScalar(c.size * Math.max(0, shrink));
      m4.compose(p3, q, s3);
      parts.debris.setMatrixAt(n++, m4);
    }
    parts.debris.count = n;
    parts.debris.instanceMatrix.needsUpdate = true;

    motes.update(dt);
  });

  return null;
}
