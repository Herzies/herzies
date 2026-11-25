import { homeMode } from "./homeMode";

/**
 * Names over visitors and the cave fade in as you come near, so the Town
 * isn't a field of labels from every distance.
 */

/** Fully invisible this far off, and fully there this near (world units). */
export const NAME_FADE = { far: 15, near: 9 } as const;

/** 1 within `near`, 0 beyond `far`, smoothly between. */
function fadeBetween(d: number, near: number, far: number): number {
  const t = Math.min(1, Math.max(0, (far - d) / (far - near)));
  return t * t * (3 - 2 * t);
}

/** How visible a name is at distance `d`: 0 beyond `far`, 1 within `near`,
 * eased between. Names go with the world on the way Home: Home shows only
 * your herzie. */
export function nameOpacity(d: number): number {
  return (
    fadeBetween(d, NAME_FADE.near, NAME_FADE.far) * (1 - homeMode.worldFade)
  );
}

/**
 * Other players' labels reach further than visitors' (you want to see
 * who's about), the title under a name a little less far, and both shrink
 * a touch with distance. A duel's two are read from across the field.
 */
export const REMOTE_LABEL = {
  name: { near: 22, far: 30 },
  title: { near: 14, far: 22 },
  /** Full size within `near`, `min` of it from `far`. */
  scale: { near: 12, far: 30, min: 0.8 },
  /** Duelists' names and health bars. */
  duel: { near: 45, far: 50 },
  /** Ordinary names shown at once, nearest first: a crowd isn't a wall of
   * text. */
  nearest: 12,
} as const;

/** How one other player's label is drawn: each part's opacity (0–1) and
 * the whole label's scale. */
export type RemoteLabel = {
  name: number;
  title: number;
  /** The health bar (in a fight). */
  hp: number;
  scale: number;
};

/**
 * Another player's label at distance `d`. `duelist`: in a duel you're in
 * or watching (its name and bar carry further); `hovered`: the pointer's
 * on it (all of it, fully); `ranked`: among the nearest
 * {@link REMOTE_LABEL.nearest} (others show no name).
 */
export function remoteLabel(
  d: number,
  opts: { duelist?: boolean; hovered?: boolean; ranked?: boolean } = {},
): RemoteLabel {
  const world = 1 - homeMode.worldFade;
  const { scale: s } = REMOTE_LABEL;
  const scale =
    1 - (1 - s.min) * Math.min(1, Math.max(0, (d - s.near) / (s.far - s.near)));
  if (opts.hovered) return { name: world, title: world, hp: world, scale: 1 };
  const listed = opts.ranked !== false;
  const far = opts.duelist
    ? fadeBetween(d, REMOTE_LABEL.duel.near, REMOTE_LABEL.duel.far)
    : 0;
  const name = Math.max(
    far,
    listed ? fadeBetween(d, REMOTE_LABEL.name.near, REMOTE_LABEL.name.far) : 0,
  );
  const title = listed
    ? fadeBetween(d, REMOTE_LABEL.title.near, REMOTE_LABEL.title.far)
    : 0;
  const hp = opts.duelist ? far : fadeBetween(d, NAME_FADE.near, NAME_FADE.far);
  return { name: name * world, title: title * world, hp: hp * world, scale };
}

/** The ids of the `n` entries nearest (x, z), into `out` (cleared first). */
export function nearestIds(
  entries: Iterable<[number, { x: number; z: number }]>,
  x: number,
  z: number,
  n: number,
  out: Set<number>,
): Set<number> {
  out.clear();
  const all: { id: number; d: number }[] = [];
  for (const [id, at] of entries)
    all.push({ id, d: Math.hypot(at.x - x, at.z - z) });
  all.sort((p, q) => p.d - q.d);
  for (let i = 0; i < Math.min(n, all.length); i++) out.add(all[i].id);
  return out;
}

/** Names are bare text, no box: a dark outline and glow keep them readable
 * over grass, water and sky alike. */
export const NAME_SHADOW =
  "0 0 3px #000, 0 1px 2px #000, 1px 0 0 rgba(0,0,0,.75), -1px 0 0 rgba(0,0,0,.75), 0 -1px 0 rgba(0,0,0,.75), 0 1px 0 #000";
