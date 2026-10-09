import { useFrame } from "@react-three/fiber";
import { EffectComposer, N8AO } from "@react-three/postprocessing";
import { type ComponentProps, useEffect, useRef } from "react";
import { ambient } from "./ambient";
import { townLook } from "./depth";

/** How dark the occlusion gets by day. */
const DAY_AO = 1.5;
/** How much of it is left at night: the lamps light the corners, and dark
 * on dark only muddies them. */
const NIGHT_AO = 0.35;

type AOPass = NonNullable<
  Extract<ComponentProps<typeof N8AO>["ref"], { current: unknown }>["current"]
>;

/**
 * Ambient occlusion: contact shade where walls meet the ground and things
 * sit on it, so they read as standing on the island rather than hovering
 * over it — screen-space (N8AO), one pass at the Town's own low
 * resolution. Kept to a small, world-sized radius, and fading with
 * distance so the haze stays the sky's colour.
 *
 * The composer draws the scene off-screen, where three leaves tone mapping
 * out; the materials do it themselves meanwhile (see depth.ts), so the
 * fog and sky come out exactly as they do without it.
 */
export function Occlusion() {
  const ao = useRef<AOPass>(null);
  useEffect(() => {
    townLook.z = 1;
    return () => {
      townLook.z = 0;
    };
  }, []);
  useFrame(() => {
    if (!ao.current) return;
    const night = ambient.uNight.value;
    ao.current.configuration.intensity = DAY_AO * (1 - night * (1 - NIGHT_AO));
  });
  return (
    <EffectComposer multisampling={0}>
      <N8AO
        ref={ao}
        quality="performance"
        halfRes={false}
        aoRadius={1.2}
        distanceFalloff={0.4}
        intensity={DAY_AO}
        color="black"
      />
    </EffectComposer>
  );
}
