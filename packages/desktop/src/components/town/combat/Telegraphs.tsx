import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import {
  bossFight,
  type FloorShape,
  pruneShapes,
  SHAPE_FLASH_MS,
  useBossFight,
} from "./fight";
import { entityAt } from "./skills";

/**
 * What the boss is about to hit, drawn on the floor so it can be stepped
 * out of. Each shape is readable three ways, so it never relies on colour
 * alone: a hatched fill, a dashed outline, and a fill that grows toward
 * the moment it lands (from the middle for a circle; from the safe middle
 * outward for a ring). It flashes white as it lands, then goes.
 *
 * A buster is the boss's mark on one herzie: the circle follows them, with
 * a "!" overhead, because it lands on them wherever they go. A minion's
 * swing is the same shape in a sicklier green; the enrage's pulse, which
 * can't be escaped, is a deep violet over the whole room. A scatter mark
 * follows its herzie too, in ice blue with a "!" of its own: it goes off on
 * anyone near them, so the marked step away from the rest. The boss's
 * charge is a lane from where it stands, filling from its end toward the
 * far one: when it's full, the boss comes down it.
 */
export function Telegraphs() {
  useBossFight();
  useFrame(() => pruneShapes(performance.now()));
  return (
    <>
      {bossFight.shapes.map((s) =>
        s.kind === "lane" ? (
          <Lane key={s.id} shape={s} />
        ) : (
          <Shape key={s.id} shape={s} />
        ),
      )}
    </>
  );
}

const reduced = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Re-rendered only when its own props change, not on every fight update. */
const Shape = memo(function Shape({ shape }: { shape: FloorShape }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uR: { value: shape.r },
          uInner: { value: shape.inner },
          uRing: { value: shape.kind === "ring" ? 1 : 0 },
          uProgress: { value: 0 },
          uFlash: { value: 0 },
          uTime: { value: 0 },
          uMotion: { value: reduced() ? 0 : 1 },
          uTone: {
            value: shape.lethal
              ? 2
              : shape.kind === "scatter"
                ? 3
                : shape.mob !== undefined
                  ? 1
                  : 0,
          },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uR;
          uniform float uInner;
          uniform float uRing;
          uniform float uProgress;
          uniform float uFlash;
          uniform float uTime;
          uniform float uMotion;
          uniform float uTone;
          varying vec2 vUv;
          void main() {
            vec2 p = (vUv - 0.5) * 2.0 * uR;
            float d = length(p);
            if (d > uR + 0.2) discard;
            float inside = step(uInner, d) * step(d, uR);
            // How far it has filled: out from the middle, or out from the
            // ring's safe middle.
            float edge = mix(uR * uProgress, uInner + (uR - uInner) * uProgress, uRing);
            float filled = step(d, edge) * inside;
            // Hatching, so the area reads without its colour.
            float hatch = step(0.5, fract((p.x + p.y) * 1.3));
            // A dashed outline.
            float ang = atan(p.y, p.x);
            float dash = step(0.35, fract(ang * uR * 0.9));
            float line = smoothstep(0.14, 0.02, abs(d - uR)) * dash
              + uRing * smoothstep(0.14, 0.02, abs(d - uInner)) * dash;
            float pulse = mix(1.0, 0.8 + 0.2 * sin(uTime * 12.0), uMotion);
            // The boss's: red to gold. A minion's: green. The pulse: violet.
            vec3 warm = uTone > 2.5 ? vec3(0.25, 0.72, 1.0)
              : uTone > 1.5 ? vec3(0.55, 0.18, 0.95)
              : uTone > 0.5 ? vec3(0.45, 0.9, 0.25) : vec3(1.0, 0.32, 0.2);
            vec3 hot = uTone > 2.5 ? vec3(0.8, 0.95, 1.0)
              : uTone > 1.5 ? vec3(0.95, 0.75, 1.0)
              : uTone > 0.5 ? vec3(0.85, 1.0, 0.55) : vec3(1.0, 0.82, 0.55);
            vec3 col = mix(warm, hot, filled * 0.7);
            float a = inside * (0.1 + 0.1 * hatch) + filled * (0.3 + 0.14 * hatch) + line * 0.95 * pulse;
            col = mix(col, vec3(1.0), uFlash);
            a = clamp(a + uFlash * inside * 0.6, 0.0, 1.0);
            gl_FragColor = vec4(col, a);
          }
        `,
        transparent: true,
        depthWrite: false,
        fog: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    [shape.r, shape.inner, shape.kind, shape.lethal, shape.mob],
  );
  useEffect(() => () => material.dispose(), [material]);

  const mesh = useMemo(() => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(shape.r * 2 + 0.4, shape.r * 2 + 0.4),
      material,
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(shape.x, 0.05, shape.z);
    m.renderOrder = 5;
    return m;
  }, [shape.r, shape.x, shape.z, material]);
  useEffect(() => () => mesh.geometry.dispose(), [mesh]);

  // A buster's "!" over its target's head.
  const follows = shape.kind === "buster" || shape.kind === "scatter";
  const mark = useMemo(() => {
    if (shape.kind !== "buster" && shape.kind !== "scatter") return null;
    const g = new THREE.Group();
    const red = new THREE.MeshBasicMaterial({
      color: shape.kind === "scatter" ? 0x5ec8ff : 0xff3b30,
      fog: false,
    });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 0.12), red);
    bar.position.y = 0.32;
    const dot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), red);
    g.add(bar, dot);
    return g;
  }, [shape.kind]);
  useEffect(
    () => () => {
      mark?.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    },
    [mark],
  );

  useFrame(({ clock }) => {
    const now = performance.now();
    if (follows && shape.target !== undefined) {
      const at = entityAt.get(shape.target);
      if (at) {
        mesh.position.set(at.x, 0.05, at.z);
        mark?.position.set(at.x, at.top + 0.45, at.z);
      }
      if (mark) mark.visible = !!at && shape.resolvedAt === null;
    }
    const span = Math.max(1, shape.lands - shape.from);
    const done = shape.resolvedAt !== null;
    const u = material.uniforms;
    u.uProgress.value = done
      ? 1
      : Math.min(1, Math.max(0, (now - shape.from) / span));
    u.uFlash.value =
      shape.resolvedAt === null
        ? 0
        : Math.max(0, 1 - (now - shape.resolvedAt) / SHAPE_FLASH_MS);
    u.uTime.value = clock.elapsedTime;
  });

  return (
    <>
      <primitive object={mesh} />
      {mark ? <primitive object={mark} /> : null}
    </>
  );
});

/** The boss's charge: a strip on the floor from where it stands, heading
 * `yaw`, `len` long and `r` either side, filling from the boss's end. */
const Lane = memo(function Lane({ shape }: { shape: FloorShape }) {
  const len = shape.len ?? 0;
  const half = shape.r;
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uLen: { value: len },
          uHalf: { value: half },
          uProgress: { value: 0 },
          uFlash: { value: 0 },
          uTime: { value: 0 },
          uMotion: { value: reduced() ? 0 : 1 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uLen;
          uniform float uHalf;
          uniform float uProgress;
          uniform float uFlash;
          uniform float uTime;
          uniform float uMotion;
          varying vec2 vUv;
          void main() {
            // Across (-half..half, with a margin) and along (0 at the boss).
            float across = (vUv.x - 0.5) * 2.0 * (uHalf + 0.2);
            float along = (1.0 - vUv.y) * uLen;
            float inside = step(abs(across), uHalf);
            float filled = step(along, uLen * uProgress) * inside;
            float hatch = step(0.5, fract((along + across) * 1.3));
            // Dashed edges down both sides, and chevrons pointing the way
            // it'll come, sliding toward the far end.
            float edge = smoothstep(0.14, 0.02, abs(abs(across) - uHalf));
            float dash = step(0.35, fract(along * 0.9));
            float chev = step(0.75, fract((along - abs(across) * 0.8) * 0.45 - uTime * 1.6 * uMotion));
            float pulse = mix(1.0, 0.8 + 0.2 * sin(uTime * 12.0), uMotion);
            vec3 warm = vec3(1.0, 0.32, 0.2);
            vec3 hot = vec3(1.0, 0.82, 0.55);
            vec3 col = mix(warm, hot, filled * 0.7);
            float a = inside * (0.1 + 0.1 * hatch + 0.22 * chev)
              + filled * (0.3 + 0.14 * hatch)
              + edge * dash * 0.95 * pulse;
            col = mix(col, vec3(1.0), uFlash);
            a = clamp(a + uFlash * inside * 0.6, 0.0, 1.0);
            gl_FragColor = vec4(col, a);
          }
        `,
        transparent: true,
        depthWrite: false,
        fog: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    [len, half],
  );
  useEffect(() => () => material.dispose(), [material]);

  const group = useMemo(() => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2 + 0.4, Math.max(0.1, len)),
      material,
    );
    m.rotation.x = -Math.PI / 2;
    // Turned by the group: local +z is the way it charges.
    m.position.set(0, 0.05, len / 2);
    m.renderOrder = 5;
    g.add(m);
    g.position.set(shape.x, 0, shape.z);
    g.rotation.y = shape.yaw ?? 0;
    return g;
  }, [half, len, shape.x, shape.z, shape.yaw, material]);
  useEffect(
    () => () =>
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      }),
    [group],
  );

  useFrame(({ clock }) => {
    const now = performance.now();
    const span = Math.max(1, shape.lands - shape.from);
    const u = material.uniforms;
    u.uProgress.value =
      shape.resolvedAt !== null
        ? 1
        : Math.min(1, Math.max(0, (now - shape.from) / span));
    u.uFlash.value =
      shape.resolvedAt === null
        ? 0
        : Math.max(0, 1 - (now - shape.resolvedAt) / SHAPE_FLASH_MS);
    u.uTime.value = clock.elapsedTime;
  });

  return <primitive object={group} />;
});
