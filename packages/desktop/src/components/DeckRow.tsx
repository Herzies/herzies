import {
  DECK_SLOT_GROUPS,
  type DeckSlotGroup,
  EQUIP_SLOT_LABELS,
  type Equipped,
  type EquipSlot,
  equipSlotFor,
  type GroundSide,
  getItem,
  groundSideOf,
  type Inventory,
  type ItemType,
} from "@herzies/shared";
import { ItemPreviewCard } from "./ItemInspectOverlay";
import {
  CARD_SHAPE_CLIP,
  GenericTypeIcon,
  ItemTypeIcon,
} from "./icons/ItemTypeIcon";
import { HoverPreview, Tooltip } from "./Tooltip";

const groupByLabel = (label: string): DeckSlotGroup => {
  const group = DECK_SLOT_GROUPS.find((g) => g.label === label);
  if (!group) throw new Error(`Unknown deck slot group: ${label}`);
  return group;
};

/** What a clicked empty box asks for: the catalog equip slot an item needs
 * to land there, the ground side when the box is one of the two ground
 * slots (so clicking the right box doesn't fill the left one), and where to
 * open the picker. */
export interface EmptySlotTarget {
  equipSlot: EquipSlot;
  side: GroundSide | undefined;
  label: string;
  x: number;
  y: number;
}

/** A category box: a title naming it and how many of its slots are filled,
 * above a row of fixed slot boxes shaped like the card icons rather than
 * plain squares. Filled boxes show that item's own icon, coloured by its own
 * art (not its category) and unequip on click; empty boxes are a plain dim
 * placeholder that names their category + slot number on hover, and open a
 * picker of the items that could fill them on click. */
function DeckGroup({
  group,
  equipped,
  inventory,
  itemUpgrades,
  onUnequip,
  onPlaceRequest,
  className,
}: {
  group: DeckSlotGroup;
  equipped: Equipped;
  inventory: Inventory | null;
  itemUpgrades: Record<string, number>;
  onUnequip: (itemId: string) => void;
  onPlaceRequest: (target: EmptySlotTarget) => void;
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
          const storedSlot =
            group.slots === "modifier" ? undefined : group.slots[i];
          const itemId = storedSlot
            ? equipped[storedSlot]
            : equipped.modifier?.[i];
          // Modifiers have no per-box identity: `applyEquip` appends to the
          // list, so an item picked from *any* empty modifier box lands at
          // the first free position rather than at the box that was clicked.
          const equipSlot = storedSlot ? equipSlotFor(storedSlot) : "modifier";
          // How many boxes in this group take the *same* equip slot, which is
          // what decides whether a box needs a "#N" to be identifiable. All 6
          // Modifiers and both Accessories (ground_left/ground_right) do, so
          // they get numbered; the three Equipment boxes each take a
          // different slot, so their names already tell them apart.
          const alike =
            group.slots === "modifier"
              ? group.count
              : group.slots.filter((s) => equipSlotFor(s) === equipSlot).length;
          return (
            <DeckSlot
              key={i}
              itemId={itemId}
              fallbackType={group.itemType}
              equipSlot={equipSlot}
              slotNumber={i + 1}
              slotCount={alike}
              inventory={inventory}
              equipped={equipped}
              itemUpgrades={itemUpgrades}
              onUnequip={onUnequip}
              onPlaceRequest={(x, y) =>
                onPlaceRequest({
                  equipSlot,
                  side: storedSlot ? groundSideOf(storedSlot) : undefined,
                  label: EQUIP_SLOT_LABELS[equipSlot],
                  x,
                  y,
                })
              }
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
  itemUpgrades,
  onUnequip,
  onPlaceRequest,
}: {
  equipped: Equipped;
  inventory: Inventory | null;
  /** Dice-upgrade levels — see ItemPreviewCard's `level` prop. */
  itemUpgrades: Record<string, number>;
  onUnequip: (itemId: string) => void;
  onPlaceRequest: (target: EmptySlotTarget) => void;
}) {
  return (
    <div className="grid w-full grid-cols-2 gap-x-4 gap-y-3 pt-3">
      <DeckGroup
        group={groupByLabel("Equipment")}
        equipped={equipped}
        inventory={inventory}
        itemUpgrades={itemUpgrades}
        onUnequip={onUnequip}
        onPlaceRequest={onPlaceRequest}
      />
      <DeckGroup
        group={groupByLabel("Accessories")}
        equipped={equipped}
        inventory={inventory}
        itemUpgrades={itemUpgrades}
        onUnequip={onUnequip}
        onPlaceRequest={onPlaceRequest}
      />
      <DeckGroup
        group={groupByLabel("Skin")}
        equipped={equipped}
        inventory={inventory}
        itemUpgrades={itemUpgrades}
        onUnequip={onUnequip}
        onPlaceRequest={onPlaceRequest}
      />
      <DeckGroup
        group={groupByLabel("Scenery")}
        equipped={equipped}
        inventory={inventory}
        itemUpgrades={itemUpgrades}
        onUnequip={onUnequip}
        onPlaceRequest={onPlaceRequest}
      />
      <DeckGroup
        group={groupByLabel("Modifiers")}
        equipped={equipped}
        inventory={inventory}
        itemUpgrades={itemUpgrades}
        onUnequip={onUnequip}
        onPlaceRequest={onPlaceRequest}
        className="col-span-2"
      />
    </div>
  );
}

function DeckSlot({
  itemId,
  fallbackType,
  equipSlot,
  slotNumber,
  slotCount,
  inventory,
  equipped,
  itemUpgrades,
  onUnequip,
  onPlaceRequest,
}: {
  itemId: string | undefined;
  fallbackType: ItemType;
  /** This box's own equip slot, which for Equipment is finer-grained than
   * `fallbackType`: head, face and body are all "Equipable" but each box
   * takes only one of them. */
  equipSlot: EquipSlot;
  slotNumber: number;
  /** How many boxes in the group share this box's equip slot — a "#N" is
   * only worth showing when more than one of them is interchangeable. */
  slotCount: number;
  inventory: Inventory | null;
  equipped: Equipped;
  /** Dice-upgrade levels — see ItemPreviewCard's `level` prop. */
  itemUpgrades: Record<string, number>;
  onUnequip: (itemId: string) => void;
  onPlaceRequest: (x: number, y: number) => void;
}) {
  if (!itemId) {
    // Named by equip slot rather than by the group's item type, and this is
    // load-bearing now that clicking opens a picker: the three Equipment
    // boxes all read "Equipable" but accept head, face and body items
    // respectively, so the old label promised things two of them refuse.
    // The `#N` suffix survives only where the boxes really are alike
    // (Modifiers, and the two Accessory sides), which is where a number is
    // the only thing that tells them apart.
    const name = EQUIP_SLOT_LABELS[equipSlot];
    const label =
      slotCount > 1 ? `${name} slot #${slotNumber}` : `${name} slot`;
    return (
      <Tooltip label={label}>
        <button
          type="button"
          aria-label={label}
          // The picker opens at the cursor rather than at the box: these are
          // 16px, so anchoring to the box itself would put the list on top
          // of the neighbouring slots the player is comparing against. A
          // keyboard activation reports (0, 0) and has no cursor to speak
          // of, so fall back to the box's own corner there.
          onClick={(e) => {
            if (e.clientX === 0 && e.clientY === 0) {
              const rect = e.currentTarget.getBoundingClientRect();
              onPlaceRequest(rect.right, rect.bottom);
            } else {
              onPlaceRequest(e.clientX, e.clientY);
            }
          }}
          className="h-4 w-4 shrink-0 cursor-pointer border-none bg-text-dim/10 p-0 transition-colors hover:bg-text-dim/25"
          style={{ clipPath: CARD_SHAPE_CLIP }}
        />
      </Tooltip>
    );
  }

  const def = getItem(itemId);

  const button = (
    <button
      type="button"
      onClick={() => onUnequip(itemId)}
      className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center bg-bg-panel/50 transition-opacity hover:opacity-75"
      style={{ clipPath: CARD_SHAPE_CLIP }}
    >
      {def ? (
        <ItemTypeIcon item={def} className="h-full w-full" />
      ) : (
        // Equipped-but-missing-from-catalog (stale/desynced data): render
        // filled but generic rather than silently falling back to empty — an
        // empty box would hide a real data problem and make the item
        // un-unequippable here.
        <GenericTypeIcon type={fallbackType} className="h-full w-full" />
      )}
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
          equipped={equipped}
          level={itemUpgrades[itemId] ?? 0}
        />
      }
    >
      {button}
    </HoverPreview>
  );
}
