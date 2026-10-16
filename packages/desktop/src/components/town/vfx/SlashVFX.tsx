import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { MAX_SLASHES, SLASH, slashField } from "../combat/slashes";

/**
 * A Percussionist's strikes (see combat/slashes), in two layers that sweep
 * together with the swing:
 *
 * - The swipe, on the ground: the blow's own reach, as far and as wide as
 *   it hits — a crisp bright line where the reach ends. A melee hit is judged on the ground, and from the camera
 *   behind and above, the ground is where a range reads.
 * - The trail, in the air: a crescent where the stick's tip went — from
 *   beside and behind its shoulder, round the front — tilted along the
 *   swing (level, it'd be a thin line edge-on to the camera): the slash,
 *   there even when the stick is hard to see.
 *
 * Each sweeps in with its leading edge brightest and a dimmer wake behind,
 * fine speed lines along it, then burns away from the inside out, the edge
 * last. Additive, so they read by day and glow at night.
 *
 * The camera sits behind the herzie, which hides the very ground its reach
 * covers. So your own are drawn twice: in full where they're seen, and
 * faintly where something's in front of them (a ghost, as range indicators
 * are drawn through walls) — the reach reads through the herzie striking.
 * Others' aren't: they'd show through trees and walls for no one's sake.
 * (The crosshair is what says a blow would land; see CombatOverlay.)
 *
 * One plane, laid out in the vertex shader from the reach and the arc; a
 * pair of materials per mesh, sharing their uniforms. Pooled: nothing is
 * made while fighting.
 */

/** Warm white at the core, gold at the edges — the cymbal's. */
const CORE = new THREE.Color("#fff3d1");
const EDGE = new THREE.Color("#ffb347");
/** The swipe sits this far above the ground, against z-fighting. */
const GROUND_LIFT = 0.03;
/** How strong the hidden parts are drawn (see above). Your own trail in
 * full: from behind, the swing is in front of the herzie, but it should
 * read as in front of you — as a slash drawn over the one striking. The
 * swipe, a guide on the ground, only faintly. */
const GHOST = { trail: 1, swipe: 0.35 };

const vertexShader = /* glsl */ `
uniform float uReach;
uniform float uFrom;
uniform float uTo;
uniform float uSide;
uniform float uGround;
varying vec2 vUv;
void main() {
  vUv = uv;
  float u = uv.x;
  // Round from the swinging arm's side (uFrom), across the front, to the
  // other (uTo): radians from straight ahead.
  float th = uSide * mix(uFrom, -uTo, u);
  // The swipe runs in from the reach most of the way to the herzie; the
  // trail is a crescent, thickest a little behind its middle, tapering to
  // points.
  float w = uGround > 0.5
    ? 0.78
    : 0.08 + 0.42 * pow(sin(3.14159265 * pow(u, 0.85)), 0.75);
  float r = uReach * (1.0 - w * (1.0 - uv.y));
  vec3 p = vec3(sin(th) * r, 0.0, cos(th) * r);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform float uHead;
uniform float uFade;
uniform float uGround;
uniform float uGhost;
uniform vec3 uCore;
uniform vec3 uEdge;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

void main() {
  float u = vUv.x;
  float v = vUv.y;
  // Not swept there yet.
  float behind = uHead - u;
  if (behind < 0.0) discard;
  float lead = smoothstep(0.0, 0.035, behind);
  // Brightest at its leading edge; the wake behind dimmer.
  float hot = exp(-behind / 0.15);
  float wake = mix(0.55, 1.0, exp(-behind / 0.25));
  // Burnt away from the inside out, the tail a little before the head,
  // the edge (the reach) last; a glowing seam where it's burning.
  float grain = noise(vec2(u * 16.0, v * 4.0));
  float burn = grain * 0.5 + v * 0.4 + (1.0 - behind) * 0.1;
  float t = uFade * 1.1 - 0.1;
  float keep = smoothstep(t - 0.06, t + 0.06, burn);
  float ember = keep * (1.0 - smoothstep(t + 0.02, t + 0.12, burn)) * step(0.001, uFade);
  // Speed lines, along the sweep.
  float streak = 0.6 + 0.4 * noise(vec2(v * 26.0, u * 1.5));

  float alpha;
  float white;
  if (uGround > 0.5) {
    // Ends cut square: the arc's ends are where the blow stops reaching.
    float ends = smoothstep(0.0, 0.015, u) * (1.0 - smoothstep(0.985, 1.0, u));
    // Just the line at the reach: a wash over the ground reads as mud.
    float rim = smoothstep(0.94, 0.975, v) * (1.0 - 0.35 * smoothstep(0.99, 1.0, v));
    alpha = rim * 1.4 * mix(0.8, 1.0, streak) * wake * lead * ends * keep;
    alpha += ember * 0.45 * v;
    white = rim * 0.5 + hot * 0.3;
  } else {
    // The points fade out.
    float tips = smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.9, 1.0, u));
    // Bright along its outer edge, where the tip went.
    float body = pow(v, 2.0);
    float edge = smoothstep(0.82, 0.95, v);
    alpha = (body * 0.8 * streak + edge * 0.9) * wake * lead * tips * keep;
    alpha += ember * 0.5 * v;
    white = 0.25 + edge * 0.6 + hot * 0.6;
  }
  alpha *= uGhost;
  if (alpha < 0.003) discard;
  vec3 color = mix(uEdge, uCore, clamp(white, 0.0, 1.0));
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
`;

type SlashUniforms = Record<
  "uReach" | "uFrom" | "uTo" | "uSide" | "uGround" | "uHead" | "uFade",
  THREE.IUniform<number>
>;

function slashUniforms(ground: boolean): SlashUniforms {
  return {
    uReach: { value: SLASH.reach },
    uFrom: { value: ground ? SLASH.arc : SLASH.trailFrom },
    uTo: { value: ground ? SLASH.arc : SLASH.trailTo },
    uSide: { value: 1 },
    uGround: { value: ground ? 1 : 0 },
    uHead: { value: 0 },
    uFade: { value: 0 },
  };
}

/** Where it's seen, or (`ghost`) only where something's in front of it. */
function slashMaterial(
  uniforms: SlashUniforms,
  ghost: boolean,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      ...uniforms,
      uGhost: {
        value: ghost ? (uniforms.uGround.value ? GHOST.swipe : GHOST.trail) : 1,
      },
      uCore: { value: CORE },
      uEdge: { value: EDGE },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthFunc: ghost ? THREE.GreaterDepth : THREE.LessEqualDepth,
    side: THREE.DoubleSide,
    fog: false,
  });
}

export function SlashVFX() {
  const fx = useMemo(() => {
    const group = new THREE.Group();
    // u along the sweep, v from the inside out to the reach.
    const geometry = new THREE.PlaneGeometry(1, 1, 48, 6);
    // A mesh drawn where it's seen, with a child drawing its ghost.
    const make = (ground: boolean) => {
      const uniforms = slashUniforms(ground);
      const mesh = (ghost: boolean) => {
        const m = new THREE.Mesh(geometry, slashMaterial(uniforms, ghost));
        // Laid out in the shader: its bounds aren't the plane's.
        m.frustumCulled = false;
        m.renderOrder = 6;
        return m;
      };
      const m = mesh(false);
      const ghost = mesh(true);
      m.add(ghost);
      m.visible = false;
      m.rotation.order = "YXZ";
      group.add(m);
      return { mesh: m, ghost, uniforms };
    };
    const pairs = Array.from({ length: MAX_SLASHES }, () => ({
      trail: make(false),
      swipe: make(true),
    }));
    return { group, geometry, pairs };
  }, []);

  useEffect(
    () => () => {
      fx.geometry.dispose();
      fx.group.traverse((o) => {
        if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
      });
    },
    [fx],
  );

  useFrame((_, dt) => {
    slashField.step(Math.min(dt, 0.1));
    for (let i = 0; i < MAX_SLASHES; i++) {
      const s = slashField.slashes[i];
      const { trail, swipe } = fx.pairs[i];
      trail.mesh.visible = s.alive && s.trailHead > 0;
      swipe.mesh.visible = s.alive && s.head > 0;
      if (!trail.mesh.visible && !swipe.mesh.visible) continue;
      for (const { uniforms, ghost } of [trail, swipe]) {
        ghost.visible = s.mine;
        uniforms.uSide.value = s.side;
        uniforms.uFade.value = s.fade;
      }
      trail.uniforms.uHead.value = s.trailHead;
      swipe.uniforms.uHead.value = s.head;
      trail.uniforms.uReach.value = s.trail;
      trail.mesh.position.set(s.x, s.y, s.z);
      trail.mesh.rotation.set(0, s.yaw, s.side * SLASH.tilt);
      swipe.mesh.position.set(s.x, s.ground + GROUND_LIFT, s.z);
      swipe.mesh.rotation.set(0, s.yaw, 0);
    }
  });

  return <primitive object={fx.group} />;
}
