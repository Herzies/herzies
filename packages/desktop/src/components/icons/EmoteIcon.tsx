import { PixelIcon, ICON_GRID_JSON as rawItemIconGrids } from "@herzies/shared";

// An emote's Premium icon, painted in the item editor (`pnpm item-editor`,
// under EXTRA_ICONS) and stored beside the item icons as "emote-<id>". An
// emote without one shows nothing in its place.
const grids = rawItemIconGrids as Record<
  string,
  { grid: string[]; palette: string[] } | undefined
>;

export function EmoteIcon({
  emoteId,
  className,
}: {
  emoteId: string;
  className?: string;
}) {
  const icon = grids[`emote-${emoteId}`];
  if (!icon) return <span className={className} />;
  return (
    <PixelIcon grid={icon.grid} palette={icon.palette} className={className} />
  );
}
