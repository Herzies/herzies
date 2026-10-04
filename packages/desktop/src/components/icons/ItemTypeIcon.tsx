import {
  getItemColor,
  getItemSet,
  getItemType,
  type ItemDef,
  type ItemType,
} from "@herzies/shared";
import rawItemIconGrids from "./item-icon-grids.json";
import { PixelIcon } from "./PixelIcon";
import { TYPE_ICON_GRIDS as GRIDS } from "./type-icon-grids";

/** Bespoke 16x16 pip per item id, depicting what that specific item actually
 * is or does (e.g. the headphones item gets an actual pair of headphones)
 * rather than its generic type shape, painted per-pixel rather than in one
 * solid tint — `grid` indexes into `palette` per cell ('.' empty, '0'-'9'/
 * 'a'-'f' a palette slot). Falls back to `GRIDS` (type-icon-grids.ts) for
 * any item without one yet — e.g. a newly added item.
 *
 * Lives in its own JSON file (rather than inline here) so the icon-editor
 * tool (`pnpm icon-editor`, see `tools/icon-editor/`) can read and overwrite
 * it directly — painting it there and saving takes effect immediately, the
 * same live-reload any other source edit gets. */
const ITEM_ICON_GRIDS: Partial<
  Record<string, { grid: string[]; palette: string[] }>
> = rawItemIconGrids;

/** Chamfered card silhouette, in the same proportions as CARD_FRAME's
 * outline in type-icon-grids.ts (16x16 grid, border pixels at x=3/4/12/13,
 * y=1/2/14/15) — for clipping something else (a background tint, a solid fill) into the
 * same card shape instead of a plain square. */
export const CARD_SHAPE_CLIP =
  "polygon(25% 6.25%, 75% 6.25%, 75% 12.5%, 81.25% 12.5%, 81.25% 87.5%, 75% 87.5%, 75% 93.75%, 25% 93.75%, 25% 87.5%, 18.75% 87.5%, 18.75% 12.5%, 25% 12.5%)";

/** Generic per-type pip with no item-specific art or colour — used only when
 * an equipped itemId is missing from the catalog (stale/desynced data), so
 * the slot still renders something instead of looking empty. */
export function GenericTypeIcon({
  type,
  className,
}: {
  type: ItemType;
  className?: string;
}) {
  return <PixelIcon grid={GRIDS[type]} className={className} />;
}

export function ItemTypeIcon({
  item,
  className,
}: {
  item: ItemDef;
  className?: string;
}) {
  const type = getItemType(item);
  const bespoke = ITEM_ICON_GRIDS[item.id];
  const set = getItemSet(item.id);

  if (set?.visual) {
    // A set's shared visual clue (e.g. Prismatic's rainbow) overrides
    // whatever this item's own icon was painted — only its shape carries
    // over (any painted cell counts as filled) — so members read as related
    // regardless of their individual icon's colours.
    const shape = (bespoke?.grid ?? GRIDS[type]).map((row) =>
      row.replace(/[^.]/g, "#"),
    );
    return (
      <PixelIcon
        grid={shape}
        className={className}
        gradient={set.visual.gradient}
      />
    );
  }

  if (bespoke) {
    return (
      <PixelIcon
        grid={bespoke.grid}
        palette={bespoke.palette}
        className={className}
      />
    );
  }

  // No bespoke icon yet: the generic per-type pip, tinted with this item's
  // own dominant-colour tint (sampled from its card art).
  return (
    <PixelIcon
      grid={GRIDS[type]}
      className={className}
      style={{ color: getItemColor(item) }}
    />
  );
}
