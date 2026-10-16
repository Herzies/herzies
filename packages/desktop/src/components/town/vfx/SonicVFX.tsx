import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import {
  IMPACT_SECONDS,
  MUZZLE_SECONDS,
  type Vec3,
  WAKE_SECONDS,
  WAVE,
  type Wave,
  waveField,
  waveRadius,
} from "../combat/waves";
import { distortionMaterial, distortionScene } from "./distortion";

/**
 * How a sonic wave looks: mostly by what it does to the light behind it.
 *
 * - The wave itself: three nested domes, its front and two echoes behind
 *   it — ")))" — pulsing as they go and spreading as sound does. Each is
 *   drawn twice: into the distortion buffer (bending the world behind it,
 *   see distortion.ts) and, faintly, as a glowing rim where it's seen
 *   edge-on, so it reads against open sky too, where there's nothing
 *   behind it to bend.
 * - Wake rings left in the air behind it, spreading and fading.
 * - A flash at the hand as it leaves, and a shockwave where it strikes: a
 *   sphere of bent light swelling out.
 * - Sparks, and little music notes, thrown off along the way and at the
 *   strike.
 *
 * Everything is pooled and instanced: four draw calls into the buffer,
 * four in the scene, one for the particles, however many waves are out.
 */

/** The wave's colour, where it glows. */
export const GLOW = new THREE.Color("#9fe8ff");
const GLOW_CRIT = new THREE.Color("#ffd36b");

/** How far round a dome reaches from its front (radians). */
const CAP = 1.05;
/** The echoes: how far back each dome sits (in front radii), how big it
 * is, and how strong. */
const SHELLS = [
  { back: 0, size: 1, strength: 1 },
  { back: 0.42, size: 0.82, strength: 0.7 },
  { back: 0.8, size: 0.66, strength: 0.45 },
] as const;

/** A dome facing +z, its front at the origin: uv.y is 1 at the front and
 * 0 at its open rim (see distortionMaterial). */
function capGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, CAP);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, -1);
  return g;
}

/** The faint visible rim, in the scene: glowing where it's seen edge-on. */
function rimMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: /* glsl */ `
      attribute vec2 aFx;
      attribute vec3 aColor;
      varying vec3 vNormalView;
      varying vec3 vView;
      varying float vStrength;
      varying float vRim;
      varying vec3 vColor;
      void main() {
        vec4 view = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vNormalView = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vView = -view.xyz;
        vStrength = aFx.x;
        vRim = mix(1.0, smoothstep(0.0, 0.45, uv.y), aFx.y);
        vColor = aColor;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormalView;
      varying vec3 vView;
      varying float vStrength;
      varying float vRim;
      varying vec3 vColor;
      void main() {
        float facing = abs(dot(normalize(vNormalView), normalize(vView)));
        float edge = pow(1.0 - facing, 2.5);
        float a = edge * vStrength * vRim * 0.55;
        gl_FragColor = vec4(vColor * a, 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
}

/** One kind of shape, instanced twice: into the distortion buffer and,
 * as a glowing rim, into the scene. */
export class FxLayer {
  readonly bend: THREE.InstancedMesh;
  readonly glow: THREE.InstancedMesh;
  private readonly fx: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private n = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    readonly max: number,
    /** Whether it's a cap (fade its open rim) or closed. */
    private readonly cap: boolean,
  ) {
    this.fx = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.colors = new THREE.InstancedBufferAttribute(
      new Float32Array(max * 3),
      3,
    );
    const g = geometry.clone();
    g.setAttribute("aFx", this.fx);
    g.setAttribute("aColor", this.colors);
    this.bend = new THREE.InstancedMesh(g, distortionMaterial(), max);
    this.glow = new THREE.InstancedMesh(g, rimMaterial(), max);
    for (const m of [this.bend, this.glow]) {
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.fx.setUsage(THREE.DynamicDrawUsage);
    this.colors.setUsage(THREE.DynamicDrawUsage);
  }

  begin() {
    this.n = 0;
  }

  /** One more: at `at`, facing `dir`, `size` across, this strong. */
  add(
    at: Readonly<Vec3>,
    dir: Readonly<Vec3>,
    size: number,
    strength: number,
    color: THREE.Color,
  ) {
    if (this.n >= this.max || strength <= 0.001) return;
    _pos.set(at[0], at[1], at[2]);
    _dir.set(dir[0], dir[1], dir[2]);
    _quat.setFromUnitVectors(FORWARD, _dir.normalize());
    _scale.setScalar(size);
    _matrix.compose(_pos, _quat, _scale);
    this.bend.setMatrixAt(this.n, _matrix);
    this.glow.setMatrixAt(this.n, _matrix);
    this.fx.setXY(this.n, strength, this.cap ? 1 : 0);
    this.colors.setXYZ(this.n, color.r, color.g, color.b);
    this.n++;
  }

  end() {
    for (const m of [this.bend, this.glow]) {
      m.count = this.n;
      m.instanceMatrix.needsUpdate = true;
    }
    this.fx.needsUpdate = true;
    this.colors.needsUpdate = true;
  }

  dispose() {
    this.bend.geometry.dispose();
    (this.bend.material as THREE.Material).dispose();
    (this.glow.material as THREE.Material).dispose();
  }
}

const FORWARD = new THREE.Vector3(0, 0, 1);
const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _color = new THREE.Color();

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** How strong a wave is now: in quickly at the hand, out as it runs out
 * of reach. */
function waveStrength(w: Wave): number {
  const left = w.reach - w.travelled;
  return Math.min(1, w.age / 0.05) * Math.min(1, left / 4);
}

// --- Particles: sparks and notes -------------------------------------------

/** What a particle is drawn as: a spark (a soft dot), or a note. */
export const SPARK = 0;
export const NOTE = 1;
export const NOTES = 2;

type Mote = {
  alive: boolean;
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
  size: number;
  kind: number;
  gravity: number;
  drag: number;
  color: THREE.Color;
};

const MOTES = 220;

/** Spark and note sprites, side by side in one texture. */
function moteAtlas(): THREE.Texture {
  const cell = 64;
  const c = document.createElement("canvas");
  c.width = cell * 3;
  c.height = cell;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  const dot = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  dot.addColorStop(0, "rgba(255,255,255,1)");
  dot.addColorStop(0.35, "rgba(255,255,255,0.75)");
  dot.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = dot;
  ctx.fillRect(0, 0, cell, cell);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 50px system-ui, sans-serif";
  ctx.fillText("♪", cell * 1.5, cell * 0.52);
  ctx.fillText("♫", cell * 2.5, cell * 0.52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function useMotes() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  return useMemo(() => {
    const motes: Mote[] = Array.from({ length: MOTES }, () => ({
      alive: false,
      pos: [0, 0, 0],
      vel: [0, 0, 0],
      age: 0,
      life: 1,
      size: 0.1,
      kind: SPARK,
      gravity: 0,
      drag: 0,
      color: new THREE.Color(),
    }));
    const geometry = new THREE.BufferGeometry();
    const attr = (n: number) =>
      new THREE.BufferAttribute(new Float32Array(MOTES * n), n).setUsage(
        THREE.DynamicDrawUsage,
      );
    geometry.setAttribute("position", attr(3));
    geometry.setAttribute("aSize", attr(1));
    geometry.setAttribute("aAlpha", attr(1));
    geometry.setAttribute("aKind", attr(1));
    geometry.setAttribute("aColor", attr(3));
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPixels: { value: 1 }, uAtlas: { value: moteAtlas() } },
      vertexShader: /* glsl */ `
        uniform float uPixels;
        attribute float aSize;
        attribute float aAlpha;
        attribute float aKind;
        attribute vec3 aColor;
        varying float vAlpha;
        varying float vKind;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          vKind = aKind;
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, aSize * uPixels / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        varying float vAlpha;
        varying float vKind;
        varying vec3 vColor;
        void main() {
          if (vAlpha <= 0.0) discard;
          vec2 uv = vec2((gl_PointCoord.x + vKind) / 3.0, 1.0 - gl_PointCoord.y);
          float a = texture2D(uAtlas, uv).a * vAlpha;
          gl_FragColor = vec4(vColor * a, 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;

    const spawn = (
      at: Readonly<Vec3>,
      vel: Readonly<Vec3>,
      o: {
        life: number;
        size: number;
        kind: number;
        color: THREE.Color;
        gravity?: number;
        drag?: number;
      },
    ) => {
      let m = motes[0];
      for (const x of motes) {
        if (!x.alive) {
          m = x;
          break;
        }
        if (x.age / x.life > m.age / m.life) m = x;
      }
      m.alive = true;
      m.pos[0] = at[0];
      m.pos[1] = at[1];
      m.pos[2] = at[2];
      m.vel[0] = vel[0];
      m.vel[1] = vel[1];
      m.vel[2] = vel[2];
      m.age = 0;
      m.life = o.life;
      m.size = o.size;
      m.kind = o.kind;
      m.gravity = o.gravity ?? 0;
      m.drag = o.drag ?? 0;
      m.color.copy(o.color);
    };

    const a = geometry.attributes;
    const update = (dt: number) => {
      const fov = (camera as THREE.PerspectiveCamera).fov ?? 55;
      material.uniforms.uPixels.value =
        gl.domElement.height / (2 * Math.tan((fov * Math.PI) / 360));
      for (let i = 0; i < MOTES; i++) {
        const m = motes[i];
        if (m.alive) {
          m.age += dt;
          if (m.age >= m.life) m.alive = false;
        }
        if (!m.alive) {
          (a.aAlpha as THREE.BufferAttribute).setX(i, 0);
          continue;
        }
        const k = Math.exp(-m.drag * dt);
        m.vel[0] *= k;
        m.vel[1] = m.vel[1] * k - m.gravity * dt;
        m.vel[2] *= k;
        m.pos[0] += m.vel[0] * dt;
        m.pos[1] += m.vel[1] * dt;
        m.pos[2] += m.vel[2] * dt;
        const t = m.age / m.life;
        // Pop in, linger, fade.
        const alpha = Math.min(1, t * 8) * (1 - t) ** 1.5;
        (a.position as THREE.BufferAttribute).setXYZ(i, ...m.pos);
        (a.aSize as THREE.BufferAttribute).setX(
          i,
          m.size * (m.kind === SPARK ? 1 - t * 0.6 : 0.8 + t * 0.4),
        );
        (a.aAlpha as THREE.BufferAttribute).setX(i, alpha);
        (a.aKind as THREE.BufferAttribute).setX(i, m.kind);
        (a.aColor as THREE.BufferAttribute).setXYZ(
          i,
          m.color.r,
          m.color.g,
          m.color.b,
        );
      }
      for (const name of ["position", "aSize", "aAlpha", "aKind", "aColor"]) {
        (a[name] as THREE.BufferAttribute).needsUpdate = true;
      }
    };
    const dispose = () => {
      geometry.dispose();
      (material.uniforms.uAtlas.value as THREE.Texture).dispose();
      material.dispose();
    };
    return { points, spawn, update, dispose };
  }, [gl, camera]);
}

/** A random unit vector, roughly along `dir` within `spread` (0 straight,
 * 1 a hemisphere). */
export function scatter(dir: Readonly<Vec3>, spread: number, out: Vec3): Vec3 {
  const u = Math.random() * 2 - 1;
  const th = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  out[0] = dir[0] + r * Math.cos(th) * spread;
  out[1] = dir[1] + u * spread;
  out[2] = dir[2] + r * Math.sin(th) * spread;
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l;
  out[1] /= l;
  out[2] /= l;
  return out;
}

const _v: Vec3 = [0, 0, 0];
const _at: Vec3 = [0, 0, 0];
export const WHITE = new THREE.Color("#ffffff");

/** The waves, as the eye sees them. Mount once in the Town. */
export function SonicVFX() {
  const layers = useMemo(
    () => ({
      shells: new FxLayer(capGeometry(), 32 * SHELLS.length, true),
      wakes: new FxLayer(new THREE.TorusGeometry(1, 0.14, 6, 28), 64, false),
      bursts: new FxLayer(new THREE.SphereGeometry(1, 24, 14), 24, false),
      muzzles: new FxLayer(new THREE.SphereGeometry(1, 16, 10), 8, false),
    }),
    [],
  );
  const motes = useMotes();
  const scene = useThree((s) => s.scene);

  useLayoutEffect(() => {
    const all = Object.values(layers);
    for (const l of all) {
      distortionScene.add(l.bend);
      scene.add(l.glow);
    }
    scene.add(motes.points);
    return () => {
      for (const l of all) {
        distortionScene.remove(l.bend);
        scene.remove(l.glow);
        l.dispose();
      }
      scene.remove(motes.points);
      motes.dispose();
      waveField.clear();
    };
  }, [layers, motes, scene]);

  useFrame(({ clock }, dt) => {
    const time = clock.elapsedTime;
    const { shells, wakes, bursts, muzzles } = layers;
    for (const l of Object.values(layers)) l.begin();

    for (const w of waveField.waves) {
      if (!w.alive) continue;
      const r = waveRadius(w);
      const strength = waveStrength(w);
      SHELLS.forEach((s, k) => {
        const pulse = 1 + Math.sin(time * 34 - k * 1.7) * 0.07;
        const back = s.back * r * 1.6;
        _at[0] = w.pos[0] - w.dir[0] * back;
        _at[1] = w.pos[1] - w.dir[1] * back;
        _at[2] = w.pos[2] - w.dir[2] * back;
        shells.add(_at, w.dir, r * s.size * pulse, strength * s.strength, GLOW);
      });
      // A trail of sparks, and now and then a note.
      if (Math.random() < dt * 55) {
        scatter(w.dir, 1, _v);
        motes.spawn(
          w.pos,
          [
            _v[0] * 1.2 - w.dir[0] * 2,
            _v[1] * 1.2 + 0.4,
            _v[2] * 1.2 - w.dir[2] * 2,
          ],
          {
            life: 0.45,
            size: 0.14 + Math.random() * 0.1,
            kind: SPARK,
            color: GLOW,
            drag: 3,
          },
        );
      }
      if (Math.random() < dt * 7) {
        scatter([0, 1, 0], 0.6, _v);
        motes.spawn(
          w.pos,
          [_v[0] * 0.6, 1.1 + Math.random() * 0.6, _v[2] * 0.6],
          {
            life: 0.9,
            size: 0.38,
            kind: Math.random() < 0.5 ? NOTE : NOTES,
            color: GLOW,
            drag: 1.5,
          },
        );
      }
    }

    for (const k of waveField.wakes) {
      if (!k.alive) continue;
      const t = k.age / WAKE_SECONDS;
      wakes.add(
        k.pos,
        k.dir,
        k.radius * (1 + easeOut(t) * 1.4),
        (1 - t) ** 2 * 0.55,
        GLOW,
      );
    }

    for (const m of waveField.muzzles) {
      if (!m.alive) continue;
      const t = m.age / MUZZLE_SECONDS;
      muzzles.add(
        m.pos,
        m.dir,
        0.12 + easeOut(t) * 0.55,
        (1 - t) ** 2 * 1.1,
        GLOW,
      );
      if (m.fresh) {
        m.fresh = false;
        for (let i = 0; i < 10; i++) {
          scatter(m.dir, 0.9, _v);
          motes.spawn(m.pos, [_v[0] * 3.5, _v[1] * 3.5, _v[2] * 3.5], {
            life: 0.25,
            size: 0.12,
            kind: SPARK,
            color: WHITE,
            drag: 6,
          });
        }
      }
    }

    for (const b of waveField.impacts) {
      if (!b.alive) continue;
      const t = b.age / IMPACT_SECONDS;
      const crit = b.kind === "crit";
      const fizzle = b.kind === "fizzle";
      const reach = crit ? 2.9 : fizzle ? 1.1 : 1.9;
      const color = crit ? GLOW_CRIT : GLOW;
      bursts.add(
        b.pos,
        b.dir,
        0.2 + easeOut(t) * reach,
        (1 - t) ** 1.6 * (fizzle ? 0.7 : 1.25),
        color,
      );
      if (b.fresh) {
        b.fresh = false;
        // Splash back off where it struck.
        const back: Vec3 = [-b.dir[0], -b.dir[1] + 0.3, -b.dir[2]];
        const n = crit ? 34 : fizzle ? 10 : 22;
        for (let i = 0; i < n; i++) {
          scatter(back, 1.1, _v);
          const speed = 3 + Math.random() * (crit ? 7 : 5);
          motes.spawn(b.pos, [_v[0] * speed, _v[1] * speed, _v[2] * speed], {
            life: 0.35 + Math.random() * 0.3,
            size: 0.1 + Math.random() * 0.12,
            kind: SPARK,
            color: Math.random() < 0.5 ? WHITE : color,
            gravity: 9,
            drag: 2.5,
          });
        }
        if (!fizzle) {
          for (let i = 0; i < (crit ? 5 : 2); i++) {
            scatter([0, 1, 0], 0.8, _v);
            _color.copy(color).lerp(WHITE, 0.3);
            motes.spawn(
              b.pos,
              [_v[0] * 1.4, 1.6 + Math.random(), _v[2] * 1.4],
              {
                life: 1.1,
                size: crit ? 0.55 : 0.42,
                kind: Math.random() < 0.5 ? NOTE : NOTES,
                color: _color,
                drag: 1.2,
              },
            );
          }
        }
      }
    }

    for (const l of Object.values(layers)) l.end();
    motes.update(dt);
  });

  return null;
}

/** For tuning: the wave's full reach (so a host can, say, scale a meter). */
export const WAVE_RANGE = WAVE.range;
