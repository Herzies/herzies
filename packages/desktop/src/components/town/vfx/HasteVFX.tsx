import { SKILL_DEFS } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { buffOn, entityAt, SKILL_FX_MS, skills } from "../combat/skills";

/** Hasted herzies drawn at once at most. */
const MAX_HASTED = 16;
/** Speed streaks behind each moving hasted herzie. */
const STREAKS = 4;
/** The last this long of a Haste, its dial blinks: about to run out. */
const ENDING_MS = 2_000;
/** Shockwaves a Haste sends out, one after another. */
const WAVES = 2;
const WAVE_GAP_MS = 140;

const CYAN = new THREE.Color(0x5ef0ff);

/**
 * Haste, for everyone in the room. Read at a glance, in a crowd, without
 * colour alone (shape and motion carry it too):
 *
 * - the cast: two fast cyan shockwaves out to its reach, so everyone sees
 *   who it caught;
 * - a hasted herzie: a ticking dial under its feet, its marks spinning fast
 *   (a metronome turned up), blinking as it runs out;
 * - moving hasted: speed streaks trailing behind it.
 *
 * Pooled meshes, moved each frame; nothing is created while fighting.
 */
export function HasteVFX() {
  const fx = useMemo(() => {
    const group = new THREE.Group();

    const waveGeo = new THREE.RingGeometry(0.9, 1, 64);
    waveGeo.rotateX(-Math.PI / 2);
    const waves = Array.from({ length: 8 }, () => {
      const m = new THREE.Mesh(
        waveGeo,
        new THREE.MeshBasicMaterial({
          color: CYAN,
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

    // The dial: a ring of ticks with three bright hands, spun by uSpin.
    const dialGeo = new THREE.PlaneGeometry(2.4, 2.4);
    dialGeo.rotateX(-Math.PI / 2);
    const dials = Array.from({ length: MAX_HASTED }, () => {
      const m = new THREE.Mesh(
        dialGeo,
        new THREE.ShaderMaterial({
          uniforms: {
            uSpin: { value: 0 },
            uAlpha: { value: 1 },
            uColor: { value: CYAN.clone() },
          },
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: /* glsl */ `
            uniform float uSpin;
            uniform float uAlpha;
            uniform vec3 uColor;
            varying vec2 vUv;
            const float TAU = 6.2831853;
            void main() {
              vec2 p = (vUv - 0.5) * 2.0;
              float d = length(p);
              if (d > 1.0) discard;
              float ang = atan(p.y, p.x);
              // Twelve ticks round the rim.
              float tick = step(0.82, d) * step(d, 0.96)
                * step(0.6, fract(ang / TAU * 12.0));
              // Three swept hands, spinning: each a wedge fading behind it.
              float sweep = fract((ang - uSpin) / TAU * 3.0);
              float hands = step(0.45, d) * step(d, 0.8) * pow(sweep, 6.0);
              // A thin inner ring.
              float ring = smoothstep(0.05, 0.0, abs(d - 0.42));
              float a = (tick * 0.8 + hands * 0.9 + ring * 0.5) * uAlpha;
              gl_FragColor = vec4(uColor, a);
            }
          `,
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

    // Streaks: thin quads along the way a herzie moves.
    const streakGeo = new THREE.PlaneGeometry(0.05, 1);
    streakGeo.rotateX(-Math.PI / 2);
    streakGeo.translate(0, 0, 0.5);
    const streakMat = new THREE.MeshBasicMaterial({
      color: CYAN,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const streaks = Array.from({ length: MAX_HASTED * STREAKS }, () => {
      const m = new THREE.Mesh(streakGeo, streakMat);
      m.visible = false;
      m.renderOrder = 7;
      group.add(m);
      return m;
    });

    return {
      group,
      waves,
      dials,
      streaks,
      waveGeo,
      dialGeo,
      streakGeo,
      streakMat,
    };
  }, []);

  useEffect(
    () => () => {
      fx.waveGeo.dispose();
      fx.dialGeo.dispose();
      fx.streakGeo.dispose();
      fx.streakMat.dispose();
      for (const w of fx.waves) (w.material as THREE.Material).dispose();
      for (const d of fx.dials) (d.material as THREE.Material).dispose();
    },
    [fx],
  );

  /** Where each hasted herzie was last frame, and how fast it's going
   * (smoothed), for its streaks. */
  const motion = useMemo(
    () => new Map<number, { x: number; z: number; vx: number; vz: number }>(),
    [],
  );

  useFrame((_, dt) => {
    const now = performance.now();

    // The cast: shockwaves out to its reach.
    const reach = SKILL_DEFS.haste.radius ?? 10;
    let wave = 0;
    for (const c of skills.casts) {
      if (c.skill !== "haste") continue;
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

    // Each hasted herzie: its dial, and streaks if it's moving.
    let dial = 0;
    let streak = 0;
    const k = Math.min(1, dt * 10);
    for (const [id, at] of entityAt) {
      const haste = buffOn(id, "haste", now);
      if (!haste) {
        motion.delete(id);
        continue;
      }
      if (dial >= fx.dials.length) break;
      const m = fx.dials[dial++];
      m.visible = true;
      m.position.set(at.x, 0.075, at.z);
      const left = haste.until - now;
      const mat = m.material as THREE.ShaderMaterial;
      // Faster spin for a stronger Haste.
      mat.uniforms.uSpin.value = (now / 1000) * (6 + 10 * haste.value);
      const blink =
        left < ENDING_MS ? 0.45 + 0.55 * (Math.sin(now / 70) > 0 ? 1 : 0) : 1;
      mat.uniforms.uAlpha.value = blink;

      const prev = motion.get(id);
      const vx = prev && dt > 0 ? (at.x - prev.x) / dt : 0;
      const vz = prev && dt > 0 ? (at.z - prev.z) / dt : 0;
      const sm = prev
        ? { vx: prev.vx + (vx - prev.vx) * k, vz: prev.vz + (vz - prev.vz) * k }
        : { vx: 0, vz: 0 };
      motion.set(id, { x: at.x, z: at.z, ...sm });
      const speed = Math.hypot(sm.vx, sm.vz);
      if (speed < 1) continue;
      // Behind it: along the way it came, fanned across its body.
      const yaw = Math.atan2(-sm.vx, -sm.vz);
      const len = Math.min(1.8, 0.25 * speed);
      for (let i = 0; i < STREAKS && streak < fx.streaks.length; i++) {
        const s = fx.streaks[streak++];
        const side = (i - (STREAKS - 1) / 2) * 0.28;
        const flick = 0.75 + 0.25 * Math.sin(now / 45 + i * 2.1 + id);
        s.visible = true;
        s.position.set(
          at.x + Math.cos(yaw) * side,
          0.35 + ((i * 0.37) % 1) * at.top * 0.6,
          at.z - Math.sin(yaw) * side,
        );
        s.rotation.set(0, yaw, 0);
        s.scale.set(1, 1, len * flick);
      }
    }
    for (; dial < fx.dials.length; dial++) fx.dials[dial].visible = false;
    for (; streak < fx.streaks.length; streak++)
      fx.streaks[streak].visible = false;
  });

  return <primitive object={fx.group} />;
}
