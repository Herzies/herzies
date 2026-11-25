import { SKILL_DEFS } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { buffOn, entityAt, SKILL_FX_MS, skills } from "../combat/skills";

/** Buffed herzies drawn at once at most. */
const MAX_BUFFED = 16;
/** The last this long of the buff, its mark blinks: about to run out. */
const ENDING_MS = 2_000;
/** Shockwaves the cast sends out, one after another. */
const WAVES = 2;
const WAVE_GAP_MS = 140;

/** How each tune looks: its colour, and how its mark under a herzie
 * moves (see MARK_FRAG). */
const LOOKS = {
  rage: { color: new THREE.Color(0xff5a24), mode: 0 },
  focus: { color: new THREE.Color(0xcfe8ff), mode: 1 },
} as const;

/** The mark under a buffed herzie, by uMode. Rage (0): a ring that beats
 * like a heart, two quick thumps a second sent outward as embers. Focus
 * (1): a calm, sharp reticle, its four ticks slowly turning, an inner
 * ring breathing in and out. */
const MARK_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  uniform float uMode;
  uniform vec3 uColor;
  varying vec2 vUv;
  const float TAU = 6.2831853;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float d = length(p);
    if (d > 1.0) discard;
    float ang = atan(p.y, p.x);
    float a;
    if (uMode < 0.5) {
      // A heartbeat: two thumps then a rest, each sending a ring out.
      float beat = fract(uTime * 1.1);
      float thump = exp(-beat * 14.0) + 0.7 * exp(-max(0.0, beat - 0.18) * 14.0) * step(0.18, beat);
      float rim = smoothstep(0.07, 0.0, abs(d - (0.72 + 0.1 * thump)));
      float wave = smoothstep(0.08, 0.0, abs(d - beat * 1.1)) * (1.0 - beat);
      float jag = 0.6 + 0.4 * step(0.5, fract(ang / TAU * 16.0 + uTime * 0.4));
      a = (rim * (0.55 + 0.6 * thump) * jag + wave * 0.7) ;
    } else {
      // A reticle: four ticks turning slowly, a crisp outer ring, an inner
      // one breathing.
      float rim = smoothstep(0.03, 0.0, abs(d - 0.86));
      float q = fract((ang + uTime * 0.6) / TAU * 4.0);
      float ticks = step(0.62, d) * step(d, 0.8) * smoothstep(0.06, 0.0, abs(q - 0.5) - 0.02);
      float inner = smoothstep(0.03, 0.0, abs(d - (0.38 + 0.05 * sin(uTime * 2.4))));
      a = rim * 0.7 + ticks * 0.9 + inner * 0.5;
    }
    gl_FragColor = vec4(uColor, a * uAlpha);
  }
`;

/**
 * A Bard's Rage or Focus, for everyone in the room, made as Haste is
 * (HasteVFX), in its own colour and motion:
 *
 * - the cast: two fast shockwaves out to its reach, so everyone sees who
 *   it caught;
 * - a buffed herzie: a mark under its feet, Rage's a red-orange ring that
 *   beats like a heart, Focus's a cool blue-white reticle slowly turning;
 *   blinking as it runs out.
 *
 * Pooled meshes, moved each frame; nothing is created while fighting.
 */
export function TuneVFX({ buff }: { buff: "rage" | "focus" }) {
  const look = LOOKS[buff];
  const fx = useMemo(() => {
    const group = new THREE.Group();

    const waveGeo = new THREE.RingGeometry(0.9, 1, 64);
    waveGeo.rotateX(-Math.PI / 2);
    const waves = Array.from({ length: 8 }, () => {
      const m = new THREE.Mesh(
        waveGeo,
        new THREE.MeshBasicMaterial({
          color: look.color,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
        }),
      );
      m.visible = false;
      m.renderOrder = 6;
      group.add(m);
      return m;
    });

    const markGeo = new THREE.PlaneGeometry(2.4, 2.4);
    markGeo.rotateX(-Math.PI / 2);
    const marks = Array.from({ length: MAX_BUFFED }, () => {
      const m = new THREE.Mesh(
        markGeo,
        new THREE.ShaderMaterial({
          uniforms: {
            uTime: { value: 0 },
            uAlpha: { value: 1 },
            uMode: { value: look.mode },
            uColor: { value: look.color.clone() },
          },
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: MARK_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
        }),
      );
      m.visible = false;
      m.renderOrder = 6;
      group.add(m);
      return m;
    });

    return { group, waves, marks, waveGeo, markGeo };
  }, [look]);

  useEffect(
    () => () => {
      fx.waveGeo.dispose();
      fx.markGeo.dispose();
      for (const w of fx.waves) (w.material as THREE.Material).dispose();
      for (const m of fx.marks) (m.material as THREE.Material).dispose();
    },
    [fx],
  );

  useFrame(() => {
    const now = performance.now();

    // The cast: shockwaves out to its reach.
    const reach = SKILL_DEFS[buff].radius ?? 10;
    let wave = 0;
    for (const c of skills.casts) {
      if (c.skill !== buff) continue;
      const age = now - c.at;
      for (let i = 0; i < WAVES && wave < fx.waves.length; i++) {
        const t = (age - i * WAVE_GAP_MS) / (SKILL_FX_MS * 0.45);
        if (t < 0 || t > 1) continue;
        const m = fx.waves[wave++];
        m.visible = true;
        m.position.set(c.x, 0.1 + i * 0.01, c.z);
        // Fast out, easing at the edge.
        m.scale.setScalar(Math.max(0.05, reach * (1 - (1 - t) ** 2)));
        (m.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t);
      }
    }
    for (; wave < fx.waves.length; wave++) fx.waves[wave].visible = false;

    // Each buffed herzie: its mark.
    let mark = 0;
    for (const [id, at] of entityAt) {
      if (mark >= fx.marks.length) break;
      const b = buffOn(id, buff, now);
      if (!b) continue;
      const m = fx.marks[mark++];
      m.visible = true;
      // A touch above Haste's dial, so the two can share the ground.
      m.position.set(at.x, 0.08, at.z);
      const left = b.until - now;
      const mat = m.material as THREE.ShaderMaterial;
      mat.uniforms.uTime.value = now / 1000 + id * 0.37;
      mat.uniforms.uAlpha.value =
        left < ENDING_MS ? 0.45 + 0.55 * (Math.sin(now / 70) > 0 ? 1 : 0) : 1;
    }
    for (; mark < fx.marks.length; mark++) fx.marks[mark].visible = false;
  });

  return <primitive object={fx.group} />;
}
