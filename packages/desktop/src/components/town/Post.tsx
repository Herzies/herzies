import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, N8AO } from "@react-three/postprocessing";
import { type ComponentProps, useEffect, useMemo, useRef } from "react";
import { ambient } from "./ambient";
import { townLook } from "./depth";
import { warpAmount } from "./portal";
import { DistortionBuffer, SonicDistortionEffect } from "./vfx/distortion";

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
  useEffect(
    () => () => {
      effect.dispose();
      buffer.dispose();
    },
    [effect, buffer],
  );
  useEffect(() => {
    townLook.z = 1;
    return () => {
      townLook.z = 0;
    };
  }, []);
  // Before the composer draws (it draws at priority 1).
  useFrame(() => {
    if (aoPass.current) {
      const night = ambient.uNight.value;
      aoPass.current.configuration.intensity =
        DAY_AO * (1 - night * (1 - NIGHT_AO));
    }
    if (distort) {
      effect.active = buffer.render(gl, camera);
      effect.warp = warpAmount();
    }
  });
  return (
    <EffectComposer multisampling={0}>
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
    </EffectComposer>
  );
}
