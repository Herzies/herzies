import {
  DECK_SLOT_GROUPS,
  type DeckSlotGroup,
  type Equipped,
  getItem,
  getItemColor,
  getItemType,
  type Inventory,
  ITEM_TYPE_LABELS,
  type ItemType,
} from "@herzies/shared";
import { CARD_SHAPE_CLIP, ItemTypeIcon } from "./icons/ItemTypeIcon";
import { ItemPreviewCard } from "./ItemInspectOverlay";
import { HoverPreview, Tooltip } from "./Tooltip";

const groupByLabel = (label: string): DeckSlotGroup => {
  const group = DECK_SLOT_GROUPS.find((g) => g.label === label);
  if (!group) throw new Error(`Unknown deck slot group: ${label}`);
  return group;
};

/** A category box: a title naming it and how many of its slots are filled,
 * above a row of fixed slot boxes shaped like the card icons rather than
 * plain squares. Filled boxes show that item's own icon, coloured by its own
 * art (not its category) and unequip on click; empty boxes are a plain dim
 * placeholder that names their category + slot number on hover. */
function DeckGroup({
  group,
  equipped,
  inventory,
  onUnequip,
  className,
}: {
  group: DeckSlotGroup;
  equipped: Equipped;
  inventory: Inventory | null;
  onUnequip: (itemId: string) => void;
  className?: string;
}) {
  const equippedCount =
    group.slots === "modifier"
      ? (equipped.modifier?.length ?? 0)
      : group.slots.filter((slot) => equipped[slot]).length;

  return (
    <div className={className}>
      <div className="mb-1 text-[10px] text-text-dim">
        {group.label} ({equippedCount}/{group.count})
      </div>
      <div className="flex items-center gap-1">
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
              inventory={inventory}
              onUnequip={onUnequip}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Two columns of category boxes — Equipment/Accessories, Skin/Scenery — with
 * Modifiers spanning both columns beneath, since it has more slots than the
 * others. */
export function DeckRow({
  equipped,
  inventory,
  onUnequip,
}: {
  equipped: Equipped;
  inventory: Inventory | null;
  onUnequip: (itemId: string) => void;
}) {
  return (
    <div className="grid w-full grid-cols-2 gap-x-4 gap-y-3 pt-3">
      <DeckGroup
        group={groupByLabel("Equipment")}
        equipped={equipped}
        inventory={inventory}
        onUnequip={onUnequip}
      />
      <DeckGroup
        group={groupByLabel("Accessories")}
        equipped={equipped}
        inventory={inventory}
        onUnequip={onUnequip}
      />
      <DeckGroup
        group={groupByLabel("Skin")}
        equipped={equipped}
        inventory={inventory}
        onUnequip={onUnequip}
      />
      <DeckGroup
        group={groupByLabel("Scenery")}
        equipped={equipped}
        inventory={inventory}
        onUnequip={onUnequip}
      />
      <DeckGroup
        group={groupByLabel("Modifiers")}
        equipped={equipped}
        inventory={inventory}
        onUnequip={onUnequip}
        className="col-span-2"
      />
    </div>
  );
}

function DeckSlot({
  itemId,
  fallbackType,
  slotNumber,
  slotCount,
  inventory,
  onUnequip,
}: {
  itemId: string | undefined;
  fallbackType: ItemType;
  slotNumber: number;
  slotCount: number;
  inventory: Inventory | null;
  onUnequip: (itemId: string) => void;
}) {
  if (!itemId) {
    const label =
      slotCount > 1
        ? `${ITEM_TYPE_LABELS[fallbackType]} slot #${slotNumber}`
        : `${ITEM_TYPE_LABELS[fallbackType]} slot`;
    return (
      <Tooltip label={label}>
        <div
          className="h-4 w-4 shrink-0 bg-text-dim/10"
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

  const button = (
    <button
      type="button"
      onClick={() => onUnequip(itemId)}
      className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center bg-bg-panel/50 transition-opacity hover:opacity-75"
      style={{ clipPath: CARD_SHAPE_CLIP }}
    >
      {/* Coloured by this specific item's own dominant art colour, not its
          category — matches how it's coloured in the inventory grid and
          store. */}
      <ItemTypeIcon
        type={type}
        className="h-full w-full"
        style={def ? { color: getItemColor(def) } : undefined}
      />
    </button>
  );

  // Missing from the catalog (stale/desynced data): nothing to preview, so
  // fall back to a plain label instead of a preview card for an item that
  // doesn't exist.
  if (!def) return <Tooltip label={itemId}>{button}</Tooltip>;

  return (
    <HoverPreview
      content={
        <ItemPreviewCard
          itemId={itemId}
          meta={`x${inventory?.[itemId] ?? 0}`}
          box={100}
          inventory={inventory}
        />
      }
    >
      {button}
    </HoverPreview>
  );
}
