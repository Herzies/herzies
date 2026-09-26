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
  type ItemType,
  type ItemUnit,
} from "@herzies/shared";
import { ItemPreviewCard } from "./ItemInspectOverlay";
import {
  CARD_SHAPE_CLIP,
  GenericTypeIcon,
  ItemTypeIcon,
} from "./icons/ItemTypeIcon";
import { HoverPreview, Tooltip } from "./Tooltip";

/** A slot's hit area: the 16px card plus 2px of transparent margin either
 * side, so neighbouring slots touch and there is no dead zone between them —
 * which used to be a 4px gap, and the clip-path on the visible card shape
 * clipped its pointer hit-testing too. The visible card is a child of this
 * button (see SLOT_CARD), so looks and spacing are unchanged. `group` lets the
 * card respond to the hover the whole area receives. */
const SLOT_HIT =
  "group flex h-4 w-5 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0";

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
  units,
  onUnequip,
  onPlaceRequest,
  className,
}: {
  group: DeckSlotGroup;
  equipped: Equipped;
  units: readonly ItemUnit[];
  onUnequip: (unitId: string) => void;
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
      {/* No `gap`: the spacing between boxes is baked into each slot's own hit
          area (see SLOT_HIT), so the pointer is always over some slot while it
          crosses the row. The negative margin puts the first box's visible
          edge back in line with the title above it. */}
      <div className="-mx-0.5 flex items-center">
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
              units={units}
              equipped={equipped}
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
  units,
  onUnequip,
  onPlaceRequest,
}: {
  equipped: Equipped;
  /** Every owned copy: what tells a box which copy it is showing (and so its
   * upgrade level), and which copy a click takes off. */
  units: readonly ItemUnit[];
  /** Takes the worn copy's id, not the item's — an item can have several copies
   * and only one is ever worn. */
  onUnequip: (unitId: string) => void;
  onPlaceRequest: (target: EmptySlotTarget) => void;
}) {
  return (
    <div className="grid w-full grid-cols-2 gap-x-4 gap-y-3 pt-3">
      <DeckGroup
        group={groupByLabel("Equipment")}
        equipped={equipped}
        units={units}
        onUnequip={onUnequip}
        onPlaceRequest={onPlaceRequest}
      />
      <DeckGroup
        group={groupByLabel("Accessories")}
        equipped={equipped}
        units={units}
        onUnequip={onUnequip}
        onPlaceRequest={onPlaceRequest}
      />
      <DeckGroup
        group={groupByLabel("Skin")}
        equipped={equipped}
        units={units}
        onUnequip={onUnequip}
        onPlaceRequest={onPlaceRequest}
      />
      <DeckGroup
        group={groupByLabel("Scenery")}
        equipped={equipped}
        units={units}
        onUnequip={onUnequip}
        onPlaceRequest={onPlaceRequest}
      />
      <DeckGroup
        group={groupByLabel("Modifiers")}
        equipped={equipped}
        units={units}
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
  units,
  equipped,
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
  units: readonly ItemUnit[];
  equipped: Equipped;
  onUnequip: (unitId: string) => void;
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
          className={SLOT_HIT}
        >
          <span
            className="h-4 w-4 bg-text-dim/10 transition-colors group-hover:bg-text-dim/25"
            style={{ clipPath: CARD_SHAPE_CLIP }}
          />
        </button>
      </Tooltip>
    );
  }

  const def = getItem(itemId);
  // An item is worn at most once, so this is THE copy in the box: its level is
  // what the preview shows, and it is the one a click takes off.
  const worn = units.find(
    (u) => u.itemId === itemId && u.equippedSlot !== null,
  );

  const button = (
    <button
      type="button"
      // Nothing to take off if the copy isn't among the units (a snapshot from
      // before copies existed): the box still shows what's worn, it just can't
      // act on it until the next sync brings the copies.
      disabled={!worn}
      onClick={() => worn && onUnequip(worn.id)}
      className={SLOT_HIT}
    >
      <span
        className="flex h-4 w-4 items-center justify-center bg-bg-panel/50 transition-opacity group-hover:opacity-75"
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
      </span>
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
          meta={`x${units.filter((u) => u.itemId === itemId).length}`}
          box={100}
          equipped={equipped}
          level={worn?.upgradeLevel ?? 0}
        />
      }
    >
      {button}
    </HoverPreview>
  );
}
