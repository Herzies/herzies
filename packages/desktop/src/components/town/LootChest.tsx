import { useFrame } from "@react-three/fiber";
import { CuboidCollider } from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  CHEST_TOP,
  chestBodyGeometry,
  chestGlowGeometry,
  chestLidGeometry,
  chestMaterial,
  LID_HINGE,
} from "./wilds/models";

/**
 * A chest of loot under a beam of gold: the Wilds' cache (WildsLoot, in
 * its hold ring) and the Tower's Warden's chest (TowerChest) are the same
 * chest. An iron-bound chest (wilds/models.ts) pops up out of the ground,
 * its lid ajar on a glow and breathing, a ring pinging out round its foot,
 * a shaft of light rising out of it with a wider, fainter halo, and solid
 * like a barrel. What it holds isn't its business: the room opens it and
 * the loot fountains out as ordinary loot (LootDrops).
 *
 * The owner moves it frame by frame through two refs, read in the frame
 * loop (no re-render): how far the lid lifts past ajar, and how strong the
 * beam is (to fade it out once it's open).
 */

/** The beam: by default high enough to stand over the Wilds' trees from
 * anywhere on the island. It rises out of the chest (from under the lid,
 * so the chest hides its foot) and fades in over its first BEAM_FADE_IN
 * units, so it leaves the lid as light rather than starting as a
 * hard-edged tube; its halo, a wider, fainter glow, goes only part of the
 * way up. */
const BEAM_HEIGHT = 48;
const HALO_HEIGHT = 14;
const BEAM_FADE_IN = 1.4;
const HALO_FADE_IN = 2.4;
const GOLD = new THREE.Color("#ffd36a");
/** How far the lid stands open, how much more it lifts per unit of
 * `lift`, and how much it lifts on its breath. */
const LID_AJAR = 0.32;
const LID_HELD = 0.55;
/** The chest's drawn size: a little bigger than a barrel, to read from
 * afar at the Town's big pixels. */
const CHEST_SCALE = 1.35;
/** Where the beam starts: inside the chest, under its lid. */
const BEAM_BASE = CHEST_TOP * CHEST_SCALE * 0.7;
/** How long it takes to pop up out of the ground. */
const POP_MS = 600;

const BEAM_VERTEX = /* glsl */ `
  varying float vY;
  varying float vFacing;
  void main() {
    vY = position.y + 0.5;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;
const BEAM_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uFadeIn;
  varying float vY;
  varying float vFacing;
  void main() {
    // In softly at its foot, out up its height, and soft at its sides
    // (where the eye looks along the tube's wall): a shaft of light.
    float a = smoothstep(0.0, uFadeIn, vY) * pow(1.0 - vY, 1.6);
    gl_FragColor = vec4(uColor, a * vFacing * vFacing * uOpacity);
  }
`;

/** A beam of light on a unit cylinder (y from -0.5 to 0.5, scaled to its
 * height), fading in over `fadeIn` of its height from its foot. Additive,
 * never written to depth: it can't smear over what's behind or under it. */
function beamMaterial(color: THREE.Color, fadeIn: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uOpacity: { value: 0 },
      uFadeIn: { value: fadeIn },
    },
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** The chest at (x, ground, z) in the island's frame, its front turned to
 * `yaw`. `born` (performance.now() ms) is when it appeared: it pops up
 * from then. `lift` (0 ajar, 1 held wide; more flings it back), `shut`
 * (0 ajar and breathing, 1 the lid down on it: lift still lifts it from
 * there), `glow` (the beam's strength, 1 full) and `fade` (1 solid, 0
 * gone: given, the chest can fade away) are read every frame. `beam` is
 * the beam's height (a room's vault is lower than the Wilds' sky). */
export function LootChest({
  x,
  z,
  ground,
  yaw,
  born,
  lift,
  shut,
  glow,
  fade,
  beam = BEAM_HEIGHT,
}: {
  x: number;
  z: number;
  ground: number;
  yaw: number;
  born: number;
  lift?: { readonly current: number };
  shut?: { readonly current: number };
  glow?: { readonly current: number };
  fade?: { readonly current: number };
  beam?: number;
}) {
  const halo = Math.min(HALO_HEIGHT, beam);
  const fades = fade !== undefined;
  const parts = useMemo(() => {
    const wood = chestMaterial();
    // Transparent from the start rather than once it fades: switching
    // over mid-fade would recompile its shader on the spot.
    if (fades) wood.transparent = true;
    return {
      body: chestBodyGeometry(),
      lid: chestLidGeometry(),
      glow: chestGlowGeometry(),
      wood,
      beam: beamMaterial(GOLD, BEAM_FADE_IN / beam),
      halo: beamMaterial(GOLD, HALO_FADE_IN / halo),
    };
  }, [beam, halo, fades]);
  useEffect(
    () => () => {
      for (const p of Object.values(parts)) p.dispose();
    },
    [parts],
  );
  const lid = useRef<THREE.Group>(null);
  const ping = useRef<THREE.Mesh>(null);
  const chest = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const pop = Math.min(1, (performance.now() - born) / POP_MS);
    const strength = glow?.current ?? 1;
    const solid = fade?.current ?? 1;
    if (chest.current)
      chest.current.scale.setScalar(
        CHEST_SCALE * (0.3 + 0.7 * pop) * (0.85 + 0.15 * solid),
      );
    if (lid.current)
      lid.current.rotation.x =
        -(1 - (shut?.current ?? 0)) *
          (LID_AJAR + Math.max(0, Math.sin(t * 1.6)) * 0.08) -
        (lift?.current ?? 0) * LID_HELD;
    if (fades) {
      parts.wood.opacity = solid;
      // The glow inside is solid colour: it goes with the first of the
      // fade rather than hanging on in the air.
      if (inner.current) inner.current.visible = solid > 0.7;
    }
    parts.beam.uniforms.uOpacity.value =
      (0.7 + Math.sin(t * 2) * 0.08) * strength;
    parts.halo.uniforms.uOpacity.value =
      (0.3 + Math.sin(t * 1.3) * 0.08) * strength;
    if (ping.current) {
      const s = 1 + ((t * 0.6) % 1) * 1.6;
      ping.current.scale.set(s, s, 1);
      (ping.current.material as THREE.MeshBasicMaterial).opacity =
        0.8 * (1 - ((t * 0.6) % 1)) * strength;
    }
  });
  return (
    <>
      <group position={[x, ground, z]}>
        <group ref={chest} rotation={[0, yaw, 0]}>
          <mesh
            geometry={parts.body}
            material={parts.wood}
            castShadow
            receiveShadow
          />
          <group ref={lid} position={LID_HINGE}>
            <mesh geometry={parts.lid} material={parts.wood} castShadow />
          </group>
          <mesh ref={inner} geometry={parts.glow}>
            <meshBasicMaterial color="#ffe08a" toneMapped={false} />
          </mesh>
        </group>
        <mesh
          material={parts.beam}
          position={[0, BEAM_BASE + beam / 2, 0]}
          scale={[1, beam, 1]}
        >
          <cylinderGeometry args={[0.3, 0.24, 1, 24, 1, true]} />
        </mesh>
        <mesh
          material={parts.halo}
          position={[0, BEAM_BASE + halo / 2, 0]}
          scale={[1, halo, 1]}
        >
          {/* Its foot inside the chest, like the beam's: a wider foot would
              stand in front of the chest and wash over it. */}
          <cylinderGeometry args={[0.85, 0.3, 1, 24, 1, true]} />
        </mesh>
        <mesh
          ref={ping}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.03, 0]}
        >
          <ringGeometry args={[0.7, 0.85, 48]} />
          <meshBasicMaterial
            color={GOLD}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      </group>
      {/* Solid, like a barrel. */}
      <CuboidCollider
        args={[0.45 * CHEST_SCALE, 0.3 * CHEST_SCALE, 0.3 * CHEST_SCALE]}
        position={[x, ground + 0.3 * CHEST_SCALE, z]}
        rotation={[0, yaw, 0]}
      />
    </>
  );
}
