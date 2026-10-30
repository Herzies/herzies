import { homeMode } from "./homeMode";

/**
 * Names over visitors and the cave fade in as you come near, so the Town
 * isn't a field of labels from every distance.
 */

/** Fully invisible this far off, and fully there this near (world units). */
export const NAME_FADE = { far: 15, near: 9 } as const;

/** How visible a name is at distance `d`: 0 beyond `far`, 1 within `near`,
 * eased between. Names go with the world on the way Home: Home shows only
 * your herzie. */
export function nameOpacity(d: number): number {
  const t = Math.min(
    1,
    Math.max(0, (NAME_FADE.far - d) / (NAME_FADE.far - NAME_FADE.near)),
  );
  return t * t * (3 - 2 * t) * (1 - homeMode.worldFade);
}

/** Names are bare text, no box: a dark outline and glow keep them readable
 * over grass, water and sky alike. */
export const NAME_SHADOW =
  "0 0 3px #000, 0 1px 2px #000, 1px 0 0 rgba(0,0,0,.75), -1px 0 0 rgba(0,0,0,.75), 0 -1px 0 rgba(0,0,0,.75), 0 1px 0 #000";
