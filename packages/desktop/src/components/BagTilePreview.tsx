import type { Equipped, ItemUnit } from "@herzies/shared";
import { compareWithWorn } from "../lib/compare";
import { useShiftHeld } from "../lib/shiftHeld";
import { CompactItemPreview } from "./ItemInspectOverlay";
import { StatChanges } from "./StatChanges";

/**
 * A bag card's hover preview. Held Shift, a wearable one is set against what
 * the herzie wears in its slot: what wearing it would do to the stats, and
 * the worn card under it. Without Shift, the preview says Shift is there.
 * (Shift-click still opens Inspect: that's the tile's click, not this.)
 */
export function BagTilePreview({
  itemId,
  unitId,
  level,
  equipped,
  units,
}: {
  itemId: string;
  unitId: string;
  level: number;
  equipped: Equipped;
  units: readonly ItemUnit[];
}) {
  const shift = useShiftHeld();
  const compare = compareWithWorn(unitId, units);
  if (!compare) {
    return (
      <CompactItemPreview itemId={itemId} equipped={equipped} level={level} />
    );
  }
  if (!shift) {
    return (
      <CompactItemPreview
        itemId={itemId}
        equipped={equipped}
        level={level}
        footer={
          <div className="mt-0.5 text-ui-sm text-text-dim/70">
            Shift: compare
          </div>
        }
      />
    );
  }
  const { worn, now, then, changes } = compare;
  return (
    // What's worn on top, the card being weighed under it, next to its tile.
    <div className="flex flex-col gap-1">
      {worn ? (
        <CompactItemPreview
          itemId={worn.itemId}
          equipped={equipped}
          level={worn.upgradeLevel}
          label="Worn"
        />
      ) : (
        <div className="w-[180px] border border-white/15 bg-bg-panel px-2 py-1 text-ui-sm text-text-dim shadow-xl shadow-black/50">
          Nothing worn there
        </div>
      )}
      <CompactItemPreview
        itemId={itemId}
        equipped={equipped}
        level={level}
        footer={
          changes.length > 0 ? (
            <StatChanges now={now} then={then} changes={changes} />
          ) : (
            <div className="mt-0.5 border-t border-white/15 pt-0.5 text-ui-sm text-text-dim">
              No change to your stats
            </div>
          )
        }
      />
    </div>
  );
}
