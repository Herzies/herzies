import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, N8AO } from "@react-three/postprocessing";
import {
  type ComponentProps,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import { townLook } from "./depth";
import { homeMode } from "./homeMode";
import { warpAmount } from "./portal";
import { DistortionBuffer, SonicDistortionEffect } from "./vfx/distortion";
import { HomeFadeEffect } from "./vfx/homeFade";

/** How many frames the world's drawn, unseen, to warm it (see Post). */
const WARM_FRAMES = 3;
/** How often (frames) the world's looked at to see whether it's grown. */
const WARM_CHECK_FRAMES = 90;

/** How dark the occlusion gets by day. */
const DAY_AO = 1.5;
/** How much of it is left at night: the lamps light the corners, and dark
 * on dark only muddies them. */
const NIGHT_AO = 0.35;

type AOPass = NonNullable<
  Extract<ComponentProps<typeof N8AO>["ref"], { current: unknown }>["current"]
>;

/**
 * What's done to the finished frame:
 *
 * - Ambient occlusion (`ao`): contact shade where walls meet the ground and
 *   things sit on it, so they read as standing on the island rather than
 *   hovering over it — screen-space (N8AO), one pass at the Town's own low
 *   resolution. Kept to a small, world-sized radius, and fading with
 *   distance so the haze stays the sky's colour.
 * - Distortion (`distort`): sound waves and portals bending the light
 *   behind them (see vfx/distortion.ts).
 * - Home's fade: the world going see-through on the way Home (see
 *   homeMode, vfx/homeFade.ts). Settled at Home there's no world to draw
 *   at all: the composer stands down, and HomeLayer draws what's left.
 *
 * The composer draws the scene off-screen, where three leaves tone mapping
 * out; the materials do it themselves meanwhile (see depth.ts), so the
 * fog and sky come out exactly as they do without it.
 */
export function Post({ ao, distort }: { ao: boolean; distort: boolean }) {
  const aoPass = useRef<AOPass>(null);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const buffer = useMemo(() => new DistortionBuffer(), []);
  const effect = useMemo(() => new SonicDistortionEffect(buffer), [buffer]);
  const fade = useMemo(() => new HomeFadeEffect(), []);
  useEffect(
    () => () => {
      effect.dispose();
      buffer.dispose();
      fade.dispose();
    },
    [effect, buffer, fade],
  );
  const scene = useThree((s) => s.scene);
  // Settled at Home: nothing of the world left to draw.
  const [atHome, setAtHome] = useState(homeMode.full);
  /**
   * The app opens on Home, where the world isn't drawn: so the first walk
   * out would compile every shader the world and this composer use, all in
   * the first frame of the swing, and stutter through it. Instead they're
   * compiled in the background while Home sits there (compileAsync, which
   * doesn't stall a frame), then the world's drawn for a couple of frames
   * under Home (faded to nothing, and cleared by HomeLayer: unseen) to
   * upload its textures and shadows and size the composer's buffers.
   */
  const warm = useRef({
    state: "cold" as "cold" | "compiling" | "drawing" | "warm",
    frames: 0,
    /** How many things were in the world when it was last warmed: the
     * world loads in pieces (the island, its physics, who's about), and
     * each new piece is warmed in turn. */
    things: -1,
    /** Frames until it's next counted. */
    countIn: 0,
  });
  useEffect(() => {
    townLook.z = 1;
    return () => {
      townLook.z = 0;
    };
  }, []);
  // Before the composer draws (it draws at priority 1).
  useFrame(() => {
    const w = warm.current;
    const settled = homeMode.full;
    // Now and then, settled at Home: has the world grown since?
    if (settled && w.state !== "compiling" && w.state !== "drawing") {
      if (--w.countIn <= 0) {
        w.countIn = WARM_CHECK_FRAMES;
        let things = 0;
        scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints)
            things++;
        });
        if (things !== w.things) {
          w.things = things;
          w.state = "cold";
        }
      }
    }
    if (settled && w.state === "cold") {
      w.state = "compiling";
      // As the composer draws it: off-screen, in half floats (three builds
      // a shader per kind of target), not to the screen.
      const target = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
      });
      const before = gl.getRenderTarget();
      gl.setRenderTarget(target);
      const compiled = gl.compileAsync(scene, camera);
      gl.setRenderTarget(before);
      compiled
        .catch(() => {})
        .finally(() => {
          target.dispose();
          w.state = "drawing";
          w.frames = WARM_FRAMES;
        });
    }
    // Drawing the world under Home a moment, to warm it (see above).
    const warming = w.state === "drawing";
    if (warming && --w.frames <= 0) w.state = "warm";
    const full = settled && !warming;
    if (full !== atHome) setAtHome(full);
    if (full) return;
    if (aoPass.current) {
      const night = ambient.uNight.value;
      // Gone first on the way Home: the herzie drawn again over the fading
      // world has none, and must match the one under it.
      aoPass.current.configuration.intensity =
        DAY_AO * (1 - night * (1 - NIGHT_AO)) * (1 - homeMode.aoFade);
    }
    if (distort) {
      effect.active = buffer.render(gl, camera);
      effect.warp = warpAmount();
    }
    fade.fade = homeMode.worldFade;
  });
  return (
    <EffectComposer multisampling={0} enabled={!atHome}>
      {ao && (
        <N8AO
          ref={aoPass}
          quality="performance"
          halfRes={false}
          aoRadius={1.2}
          distanceFalloff={0.4}
          intensity={DAY_AO}
          color="black"
        />
      )}
      {distort && <primitive object={effect} dispose={null} />}
      <primitive object={fade} dispose={null} />
    </EffectComposer>
  );
}
