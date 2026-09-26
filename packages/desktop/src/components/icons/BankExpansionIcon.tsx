import rawItemIconGrids from "./item-icon-grids.json";
import { PixelIcon } from "./PixelIcon";

// The Inventory Expansion's store icon. Painted in the icon-editor
// (`pnpm icon-editor`, listed there under EXTRA_ICONS) and stored beside the
// item icons in item-icon-grids.json, so editing it there and saving takes
// effect like any other source change. It is not a catalog item, so no
// ItemTypeIcon lookup finds it — this is its only consumer.
const { grid, palette } = rawItemIconGrids["bank-expansion"];

export function BankExpansionIcon({ className }: { className?: string }) {
  return <PixelIcon grid={grid} palette={palette} className={className} />;
}
