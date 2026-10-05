import {
  CARD_SHAPE_CLIP,
  DECK_SLOT_GROUPS,
  type DeckSlotGroup,
  EQUIP_SLOT_LABELS,
  type Equipped,
  type EquipSlot,
  equipSlotFor,
  GenericTypeIcon,
  type GroundSide,
  getItem,
  groundSideOf,
  type ItemType,
  ItemTypeIcon,
  type ItemUnit,
} from "@herzies/shared";
import { cn } from "../lib/utils";
import { CompactItemPreview } from "./ItemInspectOverlay";
import { HoverPreview, Tooltip } from "./Tooltip";

/** Marks every deck box with the equip slot it takes, so a drag from the bank
 * can find what it's over via `elementFromPoint` — the same hit-testing the
 * grid's own drag uses (see InventoryView's SLOT_INDEX_ATTR). */
export const DECK_SLOT_ATTR = "data-deck-slot";
/** The ground side a box is, on the two Accessory boxes only. */
export const DECK_SIDE_ATTR = "data-deck-side";
/** The worn copy a filled box shows — what a flight into the deck aims at.
 * By copy rather than by box because modifiers append: which box a newly
 * placed modifier lands in isn't known until it's there. */
export const DECK_UNIT_ATTR = "data-deck-unit";

/** A slot's hit area: the 16px card — the bag grid's icon size — plus 2px of transparent margin either
 * side, so neighbouring slots touch and there is no dead zone between them
 * (the clip-path on the visible card clips its hit-testing too). `group` lets
 * the card respond to the hover the whole area receives. */
const SLOT_HIT =
  "group flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border-none p-0";

const groupByLabel = (label: string): DeckSlotGroup => {
  const group = DECK_SLOT_GROUPS.find((g) => g.label === label);
  if (!group) throw new Error(`Unknown deck slot group: ${label}`);
  return group;
};

const groupAccepts = (group: DeckSlotGroup, equipSlot: EquipSlot) =>
  group.slots === "modifier"
    ? equipSlot === "modifier"
    : group.slots.some((s) => equipSlotFor(s) === equipSlot);

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

/** A deck box, as an equip slot plus (for the two Accessory boxes) a side. */
export interface DeckBox {
  equipSlot: EquipSlot;
  side: GroundSide | undefined;
}

/** A bag card being dragged: which section it belongs in, and the one box a
 * drop right now would put it in (see InventoryView's landingBox). */
export interface DeckDragState {
  equipSlot: EquipSlot;
  /** Null when a drop would be refused — a full Modifier row. */
  landing: DeckBox | null;
  /** The cursor is somewhere over the herzie — a drop anywhere there counts. */
  inZone: boolean;
}

interface SlotHandlers {
  equipped: Equipped;
  units: readonly ItemUnit[];
  /** Copies mid-flight: their box stays empty-looking until they land. */
  flyingUnitIds: ReadonlySet<string>;
  drag: DeckDragState | null;
  /** The worn copy being dragged out of its box, if one is. */
  draggingUnitId: string | null;
  onUnequip: (unitId: string) => void;
  /** Shift+click on a filled box: Inspect, as its menu's. */
  onInspectRequest: (unitId: string) => void;
  /** Pointer down on a filled box: the start of a drag out of the deck. */
  onDragStart: (unitId: string, e: React.PointerEvent) => void;
  /** Right-click on a filled box: its menu (Inspect), at the cursor. */
  onMenuRequest: (unitId: string, x: number, y: number) => void;
  onPlaceRequest: (target: EmptySlotTarget) => void;
}

/** The stats box: no panel behind it, and no side padding either, so its
 * text lines up with the view's edge like "Herzie" and "Deck". */
export const OVERLAY_PANEL = "pointer-events-auto py-1.5";

/** One section of the deck: a title naming it and how many of its slots are
 * filled, above its row of boxes (each empty box also names its slot on
 * hover). While a card that belongs here is dragged, the row is tinted, and
 * the one box it would land in lights up. */
function DeckGroup({
  group,
  className,
  ...handlers
}: SlotHandlers & {
  group: DeckSlotGroup;
  className?: string;
}) {
  const { equipped, drag } = handlers;
  const target = drag !== null && groupAccepts(group, drag.equipSlot);
  const filled =
    group.slots === "modifier"
      ? (equipped.modifier?.length ?? 0)
      : group.slots.filter((slot) => equipped[slot]).length;

  return (
    <div className={className}>
      <div className="mb-1 text-[10px] text-text-dim">
        {group.label} ({filled}/{group.count})
      </div>
      {/* No `gap`: the spacing between boxes is baked into each slot's own hit
        area (see SLOT_HIT), so the pointer is always over some slot while it
        crosses the row. The negative left margin puts the first box's visible
        edge in line with the title above it. */}
      <div
        className={cn(
          "-ml-0.5 flex w-fit",
          target && (drag.inZone ? "bg-cyan/15" : "bg-cyan/5"),
        )}
      >
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
          const side = storedSlot ? groundSideOf(storedSlot) : undefined;
          // How many boxes in this group take the *same* equip slot, which is
          // what decides whether a box needs a "#N" to be identifiable.
          const alike =
            group.slots === "modifier"
              ? group.count
              : group.slots.filter((s) => equipSlotFor(s) === equipSlot).length;
          // Exactly one box lights up: where the card would land. Modifier
          // boxes have no identity of their own, so that's the next free one.
          const landing = drag?.inZone ? drag.landing : null;
          const hovered =
            landing !== null &&
            landing.equipSlot === equipSlot &&
            (equipSlot === "modifier"
              ? i === (equipped.modifier?.length ?? 0)
              : landing.side === side);
          return (
            <DeckSlot
              key={i}
              itemId={itemId}
              fallbackType={group.itemType}
              equipSlot={equipSlot}
              side={side}
              slotNumber={i + 1}
              slotCount={alike}
              hovered={hovered}
              {...handlers}
              onPlaceRequest={(x, y) =>
                handlers.onPlaceRequest({
                  equipSlot,
                  side,
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

/** The deck, under the Herzie view's "Deck" tab: its sections in two
 * columns, Modifiers (the longest run) across the bottom. */
export function DeckOverlay(props: SlotHandlers) {
  return (
    <div className="pointer-events-auto grid w-full grid-cols-2 gap-x-4 gap-y-1.5 pt-1.5">
      {DECK_SLOT_ORDER.map((label) => (
        <DeckGroup
          key={label}
          group={groupByLabel(label)}
          className={label === "Modifiers" ? "col-span-2" : undefined}
          {...props}
        />
      ))}
    </div>
  );
}

/** Reading order, two to a row: what's worn on the body first, then the
 * herzie's look, then the Modifiers, the longest run, on a row of their own. */
const DECK_SLOT_ORDER = [
  "Equipment",
  "Accessories",
  "Skin",
  "Scenery",
  "Modifiers",
] as const;

function DeckSlot({
  itemId,
  fallbackType,
  equipSlot,
  side,
  slotNumber,
  slotCount,
  hovered,
  units,
  equipped,
  flyingUnitIds,
  draggingUnitId,
  onUnequip,
  onInspectRequest,
  onDragStart,
  onMenuRequest,
  onPlaceRequest,
}: Omit<SlotHandlers, "onPlaceRequest" | "drag"> & {
  itemId: string | undefined;
  fallbackType: ItemType;
  /** This box's own equip slot, which for Equipment is finer-grained than
   * `fallbackType`: head, face and body are all "Equipable" but each box
   * takes only one of them. */
  equipSlot: EquipSlot;
  side: GroundSide | undefined;
  slotNumber: number;
  /** How many boxes in the group share this box's equip slot — a "#N" is
   * only worth showing when more than one of them is interchangeable. */
  slotCount: number;
  /** A card being dragged would land in this exact box. */
  hovered: boolean;
  onPlaceRequest: (x: number, y: number) => void;
}) {
  const dropAttrs = {
    [DECK_SLOT_ATTR]: equipSlot,
    ...(side ? { [DECK_SIDE_ATTR]: side } : {}),
  };
  // Lit on the square around the card rather than on the card itself, which
  // a filled box's icon would cover. (cn is plain clsx, so the two bg classes
  // mustn't both be present.)
  const hitClass = cn(SLOT_HIT, hovered ? "bg-cyan/40" : "bg-transparent");

  if (!itemId) {
    // Named by equip slot rather than by the group's item type: the three
    // Equipment boxes all read "Equipable" but accept head, face and body
    // items respectively. The `#N` suffix survives only where the boxes
    // really are alike (Modifiers, and the two Accessory sides).
    const name = EQUIP_SLOT_LABELS[equipSlot];
    const label =
      slotCount > 1 ? `${name} slot #${slotNumber}` : `${name} slot`;
    return (
      <Tooltip label={label}>
        <button
          type="button"
          aria-label={label}
          {...dropAttrs}
          // The picker opens at the cursor rather than at the box, so it
          // doesn't cover the neighbouring slots being compared against. A
          // keyboard activation reports (0, 0) and has no cursor to speak of,
          // so fall back to the box's own corner there.
          onClick={(e) => {
            if (e.clientX === 0 && e.clientY === 0) {
              const rect = e.currentTarget.getBoundingClientRect();
              onPlaceRequest(rect.right, rect.bottom);
            } else {
              onPlaceRequest(e.clientX, e.clientY);
            }
          }}
          className={hitClass}
        >
          <span
            className={cn(
              "h-6 w-6 bg-text-dim/20 transition-colors group-hover:bg-text-dim/35",
            )}
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
  const flying = worn !== undefined && flyingUnitIds.has(worn.id);
  const dragging = worn !== undefined && worn.id === draggingUnitId;

  const button = (
    <button
      type="button"
      {...dropAttrs}
      {...(worn ? { [DECK_UNIT_ATTR]: worn.id } : {})}
      // Nothing to take off if the copy isn't among the units (a snapshot from
      // before copies existed): the box still shows what's worn, it just can't
      // act on it until the next sync brings the copies.
      disabled={!worn}
      onPointerDown={(e) => worn && onDragStart(worn.id, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (worn) onMenuRequest(worn.id, e.clientX, e.clientY);
      }}
      onClick={(e) => {
        if (!worn) return;
        if (e.shiftKey) onInspectRequest(worn.id);
        else onUnequip(worn.id);
      }}
      className={hitClass}
    >
      <span
        className={cn(
          "relative flex h-6 w-6 items-center justify-center transition-opacity group-hover:opacity-75",
          dragging && "opacity-30",
          // Still laid out (the flight measures it), just not drawn until the
          // flying copy arrives.
          flying && "invisible",
        )}
        // No card-shaped clip on the icon, unlike the empty box: the icon draws
        // its own card frame, and the clip shaved off its right and bottom
        // edges.
      >
        {/* The app background behind the card, clipped to its shape, so the
            card's see-through middle shows that, the same as a card in the
            bag, whatever is behind the deck. Only the backing is clipped. */}
        <span
          aria-hidden="true"
          className="absolute inset-0 bg-bg"
          style={{ clipPath: CARD_SHAPE_CLIP }}
        />
        {def ? (
          <ItemTypeIcon
            item={def}
            rarityFrame
            className="relative h-full w-full"
          />
        ) : (
          // Equipped-but-missing-from-catalog (stale/desynced data): render
          // filled but generic rather than silently falling back to empty — an
          // empty box would hide a real data problem and make the item
          // un-unequippable here.
          <GenericTypeIcon
            type={fallbackType}
            className="relative h-full w-full"
          />
        )}
      </span>
    </button>
  );

  if (!def) return <Tooltip label={itemId}>{button}</Tooltip>;

  return (
    // The same condensed card as the bag's. Above the box when there's room
    // (the deck sits at the bottom of the herzie), else below.
    <HoverPreview
      alwaysAbove={false}
      estWidth={180}
      estHeight={80}
      content={
        <CompactItemPreview
          itemId={itemId}
          equipped={equipped}
          level={worn?.upgradeLevel ?? 0}
        />
      }
    >
      {button}
    </HoverPreview>
  );
}
