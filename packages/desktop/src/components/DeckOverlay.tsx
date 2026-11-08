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
import type { ReactNode } from "react";
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
  "group flex shrink-0 cursor-pointer items-center justify-center border-none p-0";

/** A box's size: the small window's deck ("sm": a 24px card in 28px), or the
 * big window's character screen ("lg": 32px, twice the pixel art, in 40px). */
export type DeckSlotSize = "sm" | "lg";
const HIT_SIZE: Record<DeckSlotSize, string> = {
  sm: "h-7 w-7",
  lg: "h-10 w-10",
};
const CARD_SIZE: Record<DeckSlotSize, string> = {
  sm: "h-6 w-6",
  lg: "h-8 w-8",
};

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

interface DeckOverlayProps extends SlotHandlers {
  /** Show the Instrument section (class gear): once the herzie has a class,
   * or holds something anyway. Before that its boxes could only ever be
   * empty. */
  showInstrument?: boolean;
}

/** The stats box: no panel behind it, and no side padding either, so its
 * text lines up with the view's edge like "Herzie" and "Deck". */
export const OVERLAY_PANEL = "pointer-events-auto py-1.5";

/** Everything about box `i` of `group` that both deck layouts need: what's
 * in it, the equip slot and side it takes, how to name it, and whether a
 * card being dragged would land in it. */
function deckBox(
  group: DeckSlotGroup,
  i: number,
  equipped: Equipped,
  drag: DeckDragState | null,
) {
  const storedSlot = group.slots === "modifier" ? undefined : group.slots[i];
  const itemId = storedSlot ? equipped[storedSlot] : equipped.modifier?.[i];
  // Modifiers have no per-box identity: `applyEquip` appends to the
  // list, so an item picked from *any* empty modifier box lands at
  // the first free position rather than at the box that was clicked.
  const equipSlot: EquipSlot = storedSlot
    ? equipSlotFor(storedSlot)
    : "modifier";
  const side = storedSlot ? groundSideOf(storedSlot) : undefined;
  // How many boxes in this group take the *same* equip slot, which
  // is what decides whether a box needs a "#N" to be identifiable.
  const slotCount =
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
  return {
    itemId,
    fallbackType: group.itemType,
    equipSlot,
    side,
    slotNumber: i + 1,
    slotCount,
    hovered,
  };
}

/** One section of the deck: a title naming it and how many of its slots are
 * filled, above its row of boxes (each empty box also names its slot on
 * hover). A section can hold several groups' boxes (Body: the Equipment,
 * Back and Feet). While a card that belongs here is dragged, the row is
 * tinted, and the one box it would land in lights up. */
function DeckGroup({
  label,
  groups,
  className,
  ...handlers
}: SlotHandlers & {
  label: string;
  groups: DeckSlotGroup[];
  className?: string;
}) {
  const { equipped, drag } = handlers;
  const target =
    drag !== null && groups.some((g) => groupAccepts(g, drag.equipSlot));
  const filled = groups.reduce(
    (n, group) =>
      n +
      (group.slots === "modifier"
        ? (equipped.modifier?.length ?? 0)
        : group.slots.filter((slot) => equipped[slot]).length),
    0,
  );
  const count = groups.reduce((n, g) => n + g.count, 0);

  return (
    <div className={className}>
      <div className="mb-1 text-[10px] text-text-dim">
        {label} ({filled}/{count})
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
        {groups.flatMap((group) =>
          Array.from({ length: group.count }, (_, i) => {
            const box = deckBox(group, i, equipped, drag);
            return (
              <DeckSlot
                key={`${group.label}${i}`}
                {...box}
                size="sm"
                {...handlers}
                onPlaceRequest={(x, y) =>
                  handlers.onPlaceRequest({
                    equipSlot: box.equipSlot,
                    side: box.side,
                    label: EQUIP_SLOT_LABELS[box.equipSlot],
                    x,
                    y,
                  })
                }
              />
            );
          }),
        )}
      </div>
    </div>
  );
}

/** The deck, in its own window: its sections in two
 * equal columns. */
export function DeckOverlay({ showInstrument, ...props }: DeckOverlayProps) {
  return (
    <div className="pointer-events-auto grid w-full grid-cols-2 gap-x-4 gap-y-1.5 pt-1.5 pb-4">
      {DECK_SECTIONS.filter(
        ([label]) => label !== "Instrument" || showInstrument,
      ).map(([label, groups]) => (
        <DeckGroup
          key={label}
          label={label}
          groups={groups.map(groupByLabel)}
          {...props}
        />
      ))}
    </div>
  );
}

/** The big window's character screen: the herzie (`center`) in the middle,
 * what it wears down the left (head to feet, then the scenery behind it), what
 * it holds and its look down the right, and the Modifiers in a row beneath.
 * Each box is `[group label, index in the group]`. */
const PAPERDOLL_LEFT: [string, number][] = [
  ["Equipment", 0],
  ["Equipment", 1],
  ["Equipment", 2],
  ["Back", 0],
  ["Feet", 0],
  ["Scenery", 0],
];
const PAPERDOLL_RIGHT: [string, number][] = [
  ["Instrument", 0],
  ["Instrument", 1],
  ["Accessories", 0],
  ["Accessories", 1],
  ["Skin", 0],
  ["Spirit", 0],
];

export function DeckPaperdoll({
  showInstrument,
  center,
  ...handlers
}: DeckOverlayProps & { center: ReactNode }) {
  const { equipped, drag } = handlers;
  const modifiers = groupByLabel("Modifiers");
  const bottom: [string, number][] = Array.from(
    { length: modifiers.count },
    (_, i) => ["Modifiers", i],
  );
  const right = PAPERDOLL_RIGHT.filter(
    ([label]) => label !== "Instrument" || showInstrument,
  );

  /** A column of boxes, tinted while a card that belongs in it is dragged. */
  const column = (boxes: [string, number][], className: string) => {
    const groups = boxes.map(([label]) => groupByLabel(label));
    const target =
      drag !== null && groups.some((g) => groupAccepts(g, drag.equipSlot));
    return (
      <div
        className={cn(
          "flex",
          className,
          target && (drag.inZone ? "bg-cyan/15" : "bg-cyan/5"),
        )}
      >
        {boxes.map(([label, i], n) => {
          const box = deckBox(groups[n], i, equipped, drag);
          return (
            <DeckSlot
              key={`${label}${i}`}
              {...box}
              size="sm"
              {...handlers}
              onPlaceRequest={(x, y) =>
                handlers.onPlaceRequest({
                  equipSlot: box.equipSlot,
                  side: box.side,
                  label: EQUIP_SLOT_LABELS[box.equipSlot],
                  x,
                  y,
                })
              }
            />
          );
        })}
      </div>
    );
  };

  return (
    <div className="pointer-events-auto flex w-full flex-col items-center gap-1 py-1">
      <div className="flex w-full items-stretch">
        {column(PAPERDOLL_LEFT, "flex-col gap-1 self-center")}
        <div className="relative min-w-0 flex-1">{center}</div>
        {column(right, "flex-col gap-1 self-center")}
      </div>
      {column(bottom, "flex-row gap-1")}
    </div>
  );
}

/** Reading order, two to a row: what's worn on the body first (the
 * Equipment, the Back's cloak and the Feet's shoes, as one row), the
 * class's Instrument (shown once there's a class) beside it, then the
 * herzie's look, then the Spirit and the Modifiers. Each section: its
 * title, and the groups whose boxes it shows. */
const DECK_SECTIONS: [label: string, groups: string[]][] = [
  ["Body", ["Equipment", "Back", "Feet"]],
  ["Instrument", ["Instrument"]],
  ["Accessories", ["Accessories"]],
  ["Skin", ["Skin"]],
  ["Scenery", ["Scenery"]],
  ["Spirit", ["Spirit"]],
  ["Modifiers", ["Modifiers"]],
];

function DeckSlot({
  itemId,
  fallbackType,
  equipSlot,
  side,
  slotNumber,
  slotCount,
  hovered,
  size,
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
  size: DeckSlotSize;
  onPlaceRequest: (x: number, y: number) => void;
}) {
  const dropAttrs = {
    [DECK_SLOT_ATTR]: equipSlot,
    ...(side ? { [DECK_SIDE_ATTR]: side } : {}),
  };
  // Lit on the square around the card rather than on the card itself, which
  // a filled box's icon would cover. (cn is plain clsx, so the two bg classes
  // mustn't both be present.)
  const hitClass = cn(
    SLOT_HIT,
    HIT_SIZE[size],
    hovered ? "bg-cyan/40" : "bg-transparent",
  );

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
              CARD_SIZE[size],
              "bg-text-dim/20 transition-colors group-hover:bg-text-dim/35",
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
          "relative flex items-center justify-center transition-opacity group-hover:opacity-75",
          CARD_SIZE[size],
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
