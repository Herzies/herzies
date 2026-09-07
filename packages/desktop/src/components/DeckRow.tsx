import {
  DECK_SLOT_GROUPS,
  type Equipped,
  getItem,
  getItemType,
  ITEM_TYPE_LABELS,
  type ItemType,
} from "@herzies/shared";
import { cn } from "../lib/utils";
import {
  ITEM_TYPE_DIM_BG_CLASSES,
  ITEM_TYPE_PILL_CLASSES,
} from "./ItemTypeTag";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { Tooltip } from "./Tooltip";

/** Chamfered card silhouette, in the same proportions as ItemTypeIcon's
 * CARD_FRAME outline (16x16 grid, border pixels at x=3/4/12/13, y=1/2/14/15),
 * used to clip deck slots into a card shape instead of a plain square. */
const CARD_SHAPE_CLIP =
  "polygon(25% 6.25%, 75% 6.25%, 75% 12.5%, 81.25% 12.5%, 81.25% 87.5%, 75% 87.5%, 75% 93.75%, 25% 93.75%, 25% 87.5%, 18.75% 87.5%, 18.75% 12.5%, 25% 12.5%)";

/** One row of fixed slot boxes, grouped by equip category (equip / accessories /
 * scenery / modifiers / skin) — both shaped like the card icons rather than
 * plain squares. Filled boxes show that item's type icon on a dimmed tint of
 * the category colour and unequip on click; empty boxes show a fainter tint
 * of the same category colour and name their category + slot number on hover. */
export function DeckRow({
  equipped,
  onUnequip,
}: {
  equipped: Equipped;
  onUnequip: (itemId: string) => void;
}) {
  return (
    <div className="flex w-full items-center justify-between">
      {DECK_SLOT_GROUPS.map((group) => (
        <div key={group.label} className="flex items-center gap-1">
          {Array.from({ length: group.count }, (_, i) => {
            const itemId =
              group.slots === "modifier"
                ? equipped.modifier?.[i]
                : equipped[group.slots[i]];
            return (
              <DeckSlot
                key={i}
                itemId={itemId}
                fallbackType={group.itemType}
                slotNumber={i + 1}
                slotCount={group.count}
                onUnequip={onUnequip}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DeckSlot({
  itemId,
  fallbackType,
  slotNumber,
  slotCount,
  onUnequip,
}: {
  itemId: string | undefined;
  fallbackType: ItemType;
  slotNumber: number;
  slotCount: number;
  onUnequip: (itemId: string) => void;
}) {
  if (!itemId) {
    const label =
      slotCount > 1
        ? `${ITEM_TYPE_LABELS[fallbackType]} slot #${slotNumber}`
        : `${ITEM_TYPE_LABELS[fallbackType]} slot`;
    return (
      <Tooltip label={label} align="left">
        <div
          className={cn(
            "h-4 w-4 shrink-0",
            ITEM_TYPE_DIM_BG_CLASSES[fallbackType],
          )}
          style={{ clipPath: CARD_SHAPE_CLIP }}
        />
      </Tooltip>
    );
  }

  const def = getItem(itemId);
  // Equipped-but-missing-from-catalog (stale/desynced data): render filled but
  // generic rather than silently falling back to empty — an empty box would
  // hide a real data problem and make the item un-unequippable here.
  const type = def ? getItemType(def) : fallbackType;
  const name = def?.name ?? itemId;

  return (
    <Tooltip label={name} align="left">
      <button
        type="button"
        onClick={() => onUnequip(itemId)}
        className={cn(
          "flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center transition-opacity hover:opacity-75",
          ITEM_TYPE_PILL_CLASSES[type],
        )}
        style={{ clipPath: CARD_SHAPE_CLIP }}
      >
        <ItemTypeIcon type={type} className="h-full w-full" />
      </button>
    </Tooltip>
  );
}
