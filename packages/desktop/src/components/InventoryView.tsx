import type {
  BankTile,
  Equipped,
  EquipSlot,
  GroundSide,
  Herzie,
  ItemType,
  ItemUnit,
  ItemUpgradeRejection,
  ItemUpgradeResult,
  Rarity,
} from "@herzies/shared";
import {
  applyEquip,
  applyItemUpgrade,
  applySell,
  BANK_SLOT_COUNT,
  bankCapacity,
  bankTiles,
  bestUnitOf,
  DECK_SLOT_GROUPS,
  DICE_TIERS,
  getHerzieStatsFromUnits,
  getItem,
  getItemType,
  groundSlot,
  MAX_MODIFIERS,
  meetsMinStage,
  RARITY_COLORS,
  RARITY_LABELS,
  requiredDiceForLevel,
  unitsBestFirst,
} from "@herzies/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  pickGroundSide,
  type ToggleEquipResult,
} from "../hooks/useOptimisticUnits";
import { useAlignToHomeStage } from "../hooks/useStageAlignment";
import { cn, formatAmount } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { Coin } from "./Coin";
import { ContextMenu } from "./ContextMenu";
import {
  DECK_SIDE_ATTR,
  DECK_SLOT_ATTR,
  DECK_UNIT_ATTR,
  type DeckBox,
  type DeckDragState,
  DeckOverlay,
  type EmptySlotTarget,
} from "./DeckOverlay";
import { DeckSlotPicker, type PickerOption } from "./DeckSlotPicker";
import { DiceUpgradeOverlay } from "./DiceUpgradeOverlay";
import { HERZIE_STAGE_HEIGHT, Herzie3D } from "./Herzie3D";
import { type Flight, ItemFlights } from "./ItemFlight";
import ItemInspectOverlay, { CompactItemPreview } from "./ItemInspectOverlay";
import { DuplicatesIcon } from "./icons/DuplicatesIcon";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { SortIcon } from "./icons/SortIcon";
import { List } from "./List";
import { NumberTicker } from "./NumberTicker";
import { PromptOverlay } from "./PromptOverlay";
import { StatsPanel } from "./StatsPanel";
import { HoverPreview, Tooltip } from "./Tooltip";

/** Rarities worth a second look before they're sold for coin. */
const CONFIRM_SELL_RARITIES: ReadonlySet<Rarity> = new Set([
  "rare",
  "legendary",
  "mythic",
]);

/** Non-stackable items cap out at 1 per sell action regardless of how many
 * are owned — each grid tile already represents exactly one copy (see
 * `bankTiles`), so "sell 2 equipables at once" isn't a meaningful action even
 * when you own 2. Only stackable items (artefacts) get the quantity ticker. */
function SellControls({
  qty,
  price,
  stackable,
  onSell,
  stacked = false,
}: {
  qty: number;
  price: number;
  stackable: boolean;
  /** How many to sell; the caller decides WHICH copies that means. */
  onSell: (qty: number) => void;
  /** Ticker row above a full-width Sell button instead of side by side —
   * for the compact SellBox popover, which isn't wide enough to fit the
   * ticker's three segments and the Sell button in one row. */
  stacked?: boolean;
}) {
  const maxQty = stackable ? qty : 1;
  const [sellAmount, setSellAmount] = useState(1);
  const clamped = Math.max(1, Math.min(sellAmount, maxQty));

  return (
    <div
      className={cn(
        "flex gap-1",
        stacked ? "flex-col" : "w-full items-stretch",
      )}
    >
      {stackable && maxQty > 1 && (
        <div className="flex items-stretch gap-1">
          <NumberTicker
            value={clamped}
            min={1}
            max={maxQty}
            onChange={setSellAmount}
            fullWidth
          />
        </div>
      )}
      <button
        type="button"
        // flex-1 only in the row layout, to stretch width. In the stacked
        // (column) layout, flex-1's flex-basis: 0 hijacks the main axis —
        // now vertical — and overrides .btn's fixed height, squashing the
        // button; full width there instead comes for free from the column
        // container's default align-items: stretch.
        className={cn("btn", !stacked && "flex-1")}
        onClick={() => onSell(clamped)}
      >
        Sell (<Coin amount={clamped * price} />)
      </button>
    </div>
  );
}

/** Compact floating sell action anchored at a point (e.g. a right-click
 * position) — item name + SellControls, no art/description/set-info. Shares
 * ContextMenu's anchor-and-dismiss behaviour (outside click, Escape,
 * scroll) but isn't built on it directly since it needs its own content
 * layout rather than a list of menu items. */
function SellBox({
  itemId,
  x,
  y,
  qty,
  price,
  stackable,
  onSell,
  onClose,
}: {
  itemId: string;
  x: number;
  y: number;
  qty: number;
  price: number;
  stackable: boolean;
  onSell: (qty: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const item = getItem(itemId);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  if (!item) return null;

  const BOX_WIDTH = 180;
  // Stacked SellControls adds a row (ticker above the Sell button instead of
  // beside it) versus the row-layout estimate this would otherwise need.
  const BOX_HEIGHT = 110;
  const EDGE_PADDING = 8;
  const left = Math.min(x, window.innerWidth - BOX_WIDTH - EDGE_PADDING);
  const top = Math.min(y, window.innerHeight - BOX_HEIGHT - EDGE_PADDING);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-150 flex w-[180px] flex-col gap-2 border border-border bg-bg-panel p-2 shadow-lg"
      style={{ left, top }}
    >
      <div className="flex items-center gap-1.5 text-ui-sm text-text">
        <ItemTypeIcon item={item} className="h-4 w-4 shrink-0" />
        <span className="truncate">{item.name}</span>
      </div>
      <SellControls
        qty={qty}
        price={price}
        stackable={stackable}
        onSell={onSell}
        stacked
      />
    </div>,
    document.body,
  );
}

const GRID_COLS = 6;
/** Rows visible at once. Capacity starts at BANK_SLOT_COUNT (3 rows of 6) and
 * grows by whole rows per Inventory Expansion, so the grid scrolls once it has
 * more than this — see the row sizing below. */
const VISIBLE_ROWS = 3;
/** How close to the viewport's top/bottom edge a drag starts scrolling it.
 * Narrow: a row is only ~36px tall, and a wider band set the grid scrolling
 * while the card was simply being held over the first or last row. Past the
 * edge (onto the bag's title, or below the grid) it keeps scrolling. */
const AUTOSCROLL_EDGE_PX = 10;
/** How long a card has to stay at the edge before the grid starts scrolling,
 * so passing over it on the way somewhere else doesn't move the grid. */
const AUTOSCROLL_DELAY_MS = 250;
const AUTOSCROLL_STEP_PX = 10;

// Capacity is `bankCapacity(...)` from @herzies/shared — every slot shown
// whether filled or empty. A freshly-seen item fills the first empty slot (in
// current sort order); from there the player can drag items to any slot,
// including swapping two filled ones. Sourced from @herzies/shared so non-UI
// code (deciding whether to warn before a purchase or pickup) agrees with this
// grid's actual capacity.

/** v2: the arrangement is now keyed by tile (a copy's own id, or `stack:<item>`)
 * rather than by item id, so an arrangement saved under the old key — plain
 * item ids, repeated once per copy — is simply never read. It only ever
 * recorded where cards sat in a per-device layout, and re-laying it out once
 * is cheaper than trying to map ids that were never unique onto ones that are. */
const slotStorageKey = (friendCode: string) =>
  `herzies:inventory-slots:v2:${friendCode}`;

/** Pads a slot arrangement out to `capacity`, and trims empty slots off the end
 * beyond it — but never a filled one. Capacity only ever grows, yet the view can
 * briefly be handed a smaller one than the arrangement it saved (the app's state
 * starts at zero expansions until the first sync lands), and truncating then
 * would throw away where the player had put their cards. */
function fitSlotOrder(
  order: (string | null)[],
  capacity: number,
): (string | null)[] {
  let length = order.length;
  while (length > capacity && order[length - 1] === null) length--;
  const fitted = order.slice(0, length);
  while (fitted.length < capacity) fitted.push(null);
  return fitted;
}

/** Loads the saved slot arrangement, fitted to `capacity` (see fitSlotOrder)
 * and with anything that isn't a string coerced to an empty slot. */
function loadSlotOrder(
  friendCode: string,
  capacity: number,
): (string | null)[] {
  try {
    const raw = localStorage.getItem(slotStorageKey(friendCode));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return Array(capacity).fill(null);
    return fitSlotOrder(
      parsed.map((k) => (typeof k === "string" ? k : null)),
      capacity,
    );
  } catch {
    return Array(capacity).fill(null);
  }
}

/** Reconciles the saved slot arrangement against the tiles that exist.
 * `tileKeys` is every current tile's key in the order fresh tiles should be
 * placed (rarity, then name).
 *
 * Every key is unique — a copy's own id, or one key per stack — so this is a
 * plain set match, with none of the counting the old per-item-id arrangement
 * needed to guess which of several identical cards was meant: a tile that's
 * gone (sold, worn) empties exactly its own slot and nothing else moves.
 *
 * A tile that newly appears takes a slot freed in this same pass before any
 * other empty one. That is what makes equipping into an occupied slot feel
 * right: the copy you clicked leaves the grid and whatever it displaced lands
 * where it was, rather than in the first hole the grid happens to have. */
function reconcileSlotOrder(
  prev: (string | null)[],
  tileKeys: string[],
  /** A card dragged out of the deck onto an empty bag slot lands there. */
  preferred?: { key: string; index: number } | null,
): (string | null)[] {
  const present = new Set(tileKeys);
  const next = prev.map((key) =>
    key !== null && present.has(key) ? key : null,
  );
  const freed: number[] = [];
  prev.forEach((key, i) => {
    if (key !== null && next[i] === null) freed.push(i);
  });
  const placed = new Set(next.filter((k): k is string => k !== null));

  for (const key of tileKeys) {
    if (placed.has(key)) continue;
    const slot =
      preferred?.key === key && next[preferred.index] === null
        ? preferred.index
        : (freed.shift() ?? next.indexOf(null));
    // No room left — over-capacity tiles simply don't show (the player is
    // warned separately — see isBankFull — before this can normally happen).
    if (slot === -1) break;
    next[slot] = key;
    placed.add(key);
  }
  return next;
}

/** Rank per item type for the quick sort, taken from the deck's own
 * left-to-right grouping so a sorted grid reads in the same order as the
 * deck it fills, instead of a second ordering invented here that could drift
 * from it. A type with no deck slot of its own — artefacts, which aren't
 * equipable — has no rank there and sorts last.
 *
 * Note this groups by `ItemType` (Equipable, Accessory, Scenery, Modifier,
 * Skin, Artefact), not by `ItemCategory`: every unit in this grid is already
 * filtered to the "deck" category, so ranking by that would be a no-op. */
const TYPE_RANK = new Map<ItemType, number>(
  DECK_SLOT_GROUPS.map((group, i) => [group.itemType, i]),
);

/** Types with no deck slot, in the order they follow the deck groups: the
 * upgrade kit (dice, then the Safety Pick that goes with them) before plain
 * artefacts. */
const UNSLOTTED_TYPE_ORDER: ItemType[] = ["dice", "charm"];

function typeRank(itemId: string): number {
  const def = getItem(itemId);
  if (!def) return TYPE_RANK.size + UNSLOTTED_TYPE_ORDER.length;
  const type = getItemType(def);
  const slotted = TYPE_RANK.get(type);
  if (slotted !== undefined) return slotted;
  const unslotted = UNSLOTTED_TYPE_ORDER.indexOf(type);
  return (
    TYPE_RANK.size +
    (unslotted === -1 ? UNSLOTTED_TYPE_ORDER.length : unslotted)
  );
}

/** Dice read in tier order — Power Dice 1, 2, 3 — the order they're spent
 * in, rather than by rarity (which would put 3 first). Everything else ties. */
function diceTierRank(itemId: string): number {
  const tier = DICE_TIERS.findIndex((t) => t.diceItemId === itemId);
  return tier === -1 ? 0 : tier;
}

/** Re-lays every tile out from the first slot, grouped by item type — the
 * quick sort. Built from the current tiles rather than by permuting the
 * arrangement, so it also heals any drift (gaps left by sells, say) in one go.
 *
 * `tiles` already arrives rarity-then-name sorted (see InventoryView's
 * `compareTiles`) and `sort` is stable, so ranking by type yields type →
 * rarity → name, except dice, which go by tier (see diceTierRank). Anything past `slotCount` drops
 * off the grid, the same way `reconcileSlotOrder` drops it. */
function sortSlotsByType(
  tiles: BankTile[],
  slotCount: number,
): (string | null)[] {
  const sorted = [...tiles].sort(
    (a, b) =>
      typeRank(a.itemId) - typeRank(b.itemId) ||
      diceTierRank(a.itemId) - diceTierRank(b.itemId),
  );
  return Array.from({ length: slotCount }, (_, i) => sorted[i]?.key ?? null);
}

/** Shared by both cell kinds: only the dragged cell dims, only the one
 * currently dragged over gets the drop-target ring. */
function dragVisualClasses(isDragging: boolean, isDragOver: boolean) {
  return cn(
    isDragging && "opacity-30",
    isDragOver && "ring-1 ring-inset ring-cyan",
  );
}

/** `data-slot-index` on every cell lets the global pointermove handler find
 * which slot the cursor is over via `elementFromPoint` — plain hit-testing
 * rather than native HTML5 drag-and-drop, which Tauri's webview doesn't
 * reliably deliver events for. */
const SLOT_INDEX_ATTR = "data-slot-index";

/** The copies behind a tile, space-separated — what a card flying back from
 * the deck finds its landing tile by (`~=` matches one word of it, so a copy
 * returning onto an existing stack finds the stack). */
const TILE_UNITS_ATTR = "data-tile-units";

/** Wraps the herzie and the deck laid over it: dropping a card anywhere in here
 * places it (see handleDeckDrop). */
const HERZIE_ZONE_ATTR = "data-herzie-zone";

/** Where a flight lands (see ItemFlight): a worn copy's deck box, or the bag
 * tile holding a copy. */
const toDeck = (unitId: string) => `[${DECK_UNIT_ATTR}="${unitId}"]`;
const toBank = (unitId: string) => `[${TILE_UNITS_ATTR}~="${unitId}"]`;

/** The middle of an element, for a flight to take off from. */
function centre(el: Element | null) {
  const r = el?.getBoundingClientRect();
  return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Where a drag is: over a bank slot, and/or over the herzie — and if so, over
 * which deck box, if any. */
interface DragHit {
  overIndex: number | null;
  inZone: boolean;
  overDeck: DeckBox | null;
}

/** Where a drag started: a bag tile, or a worn card in the deck. */
type DragSource =
  | { kind: "bag"; index: number; tile: BankTile }
  | { kind: "deck"; unitId: string; itemId: string };

const sourceItemId = (source: DragSource) =>
  source.kind === "bag" ? source.tile.itemId : source.itemId;

function hitTest(x: number, y: number): DragHit {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const slotEl = el?.closest<HTMLElement>(`[${SLOT_INDEX_ATTR}]`);
  const deckEl = el?.closest<HTMLElement>(`[${DECK_SLOT_ATTR}]`);
  return {
    overIndex: slotEl ? Number(slotEl.getAttribute(SLOT_INDEX_ATTR)) : null,
    inZone: !!el?.closest(`[${HERZIE_ZONE_ATTR}]`),
    overDeck: deckEl
      ? {
          equipSlot: deckEl.getAttribute(DECK_SLOT_ATTR) as EquipSlot,
          side: (deckEl.getAttribute(DECK_SIDE_ATTR) ?? undefined) as
            | GroundSide
            | undefined,
        }
      : null,
  };
}

/** One grid cell: just the item's icon (coloured by its own art, not its
 * category — see getItemColor), a "+N" badge when the copy is upgraded and a
 * stack-count badge on a stack. No equipped ring — the bank only ever shows
 * unworn copies (wearing one takes it off the grid — see `bankTiles`), so
 * there's never a specific card here to mark as equipped; that's the deck
 * overlay's job. Hovering shows the full item preview (art, rarity, description, set
 * progress — no equip/sell actions); clicking places the copy directly;
 * right-clicking a sellable item opens a Sell menu. Press-and-drag onto any
 * other slot (empty or filled — filled swaps the two items), or onto the
 * herzie to place it.
 *
 * `border-r`/`border-b` only draw on non-edge cells (see `isLastCol`/
 * `isLastRow`) — the grid should show inner divider lines only, not an
 * outer frame around the whole thing. */
function ItemGridCell({
  index,
  itemId,
  unitIds,
  level,
  isLastCol,
  isLastRow,
  isDragging,
  isDragOver,
  flying,
  equipped,
  onPlace,
  onMenuRequest,
  onDragPointerDown,
}: {
  index: number;
  itemId: string;
  /** Copies behind the tile: more than one only for a stack. */
  unitIds: string[];
  /** This copy's dice-upgrade level (0 for a stack) — see CompactItemPreview. */
  level: number;
  isLastCol: boolean;
  isLastRow: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  /** A copy is flying back onto this tile: hold its icon until it lands. */
  flying: boolean;
  equipped: Equipped;
  /** The tile is the exact copy that was clicked — there is no "which of the
   * identical cards" to work out — so no slot index has to be threaded through. */
  onPlace: () => void;
  /** Right-click: the tile's menu (Inspect, and Sell where it sells). */
  onMenuRequest: (x: number, y: number) => void;
  onDragPointerDown: (index: number, e: React.PointerEvent) => void;
}) {
  const def = getItem(itemId);
  const qty = unitIds.length;

  return (
    // The condensed card: browsing the bag wants a glance, not the full art.
    // Right-click → Inspect opens the full one.
    <HoverPreview
      estWidth={180}
      estHeight={80}
      content={
        <CompactItemPreview itemId={itemId} equipped={equipped} level={level} />
      }
    >
      <button
        type="button"
        data-slot-index={index}
        {...{ [TILE_UNITS_ATTR]: unitIds.join(" ") }}
        onPointerDown={(e) => onDragPointerDown(index, e)}
        onClick={onPlace}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenuRequest(e.clientX, e.clientY);
        }}
        className={cn(
          // w-full/h-full: Tooltip's trigger span is a flex item's only
          // child, so without explicit sizing it shrinks to the icon's own
          // content size instead of filling the grid cell — which also left
          // the divider line only wrapping that shrunk square instead of
          // the full cell, and the icon sitting off-centre.
          "relative flex h-full w-full cursor-grab items-center justify-center bg-bg-panel/50 transition-colors hover:bg-white/5 active:cursor-grabbing",
          !isLastCol && "border-r border-border",
          !isLastRow && "border-b border-border",
          dragVisualClasses(isDragging, isDragOver),
        )}
      >
        {/* While a card flies back onto this tile, its icon waits for the
            landing and the badges fade in during the flight. */}
        <span
          className={cn("contents", flying && "[&>*]:animate-flight-meta-in")}
        >
          {def && (
            // Rarity, as a small right triangle in the bottom-left corner, inset
            // by the same 2px as the +N and xN badges, in the rarity's own colour (the same one the preview card
            // and the item's name use). Grid only — the deck's boxes are too
            // small to carry one.
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0.5 left-0.5 h-1.5 w-1.5"
              style={{
                background: RARITY_COLORS[def.rarity],
                clipPath: "polygon(0 0, 0 100%, 100% 100%)",
              }}
            />
          )}
          {level > 0 && (
            <span className="absolute top-0.5 left-0.5 rounded bg-black/60 px-1 text-[9px] text-cyan">
              +{level}
            </span>
          )}
          {def?.stackable && qty > 1 && (
            <span className="absolute top-0.5 right-0.5 rounded bg-black/60 px-1 text-[9px] text-text-dim">
              x{qty}
            </span>
          )}
        </span>
        {def && (
          <ItemTypeIcon
            item={def}
            className={cn("h-4 w-4", flying && "invisible")}
          />
        )}
      </button>
    </HoverPreview>
  );
}

/** An empty slot — still a valid drop destination (moves the dragged item
 * here) even though there's nothing to drag from it. Needs no pointer
 * handler of its own: the global pointermove handler finds it via
 * `data-slot-index` + `elementFromPoint`.
 *
 * `border-r`/`border-b` only draw on non-edge cells — see `ItemGridCell`. */
function EmptyGridCell({
  index,
  isLastCol,
  isLastRow,
  isDragOver,
}: {
  index: number;
  isLastCol: boolean;
  isLastRow: boolean;
  isDragOver: boolean;
}) {
  return (
    <div
      {...{ [SLOT_INDEX_ATTR]: index }}
      className={cn(
        "h-full w-full bg-bg-panel/50",
        !isLastCol && "border-r border-border",
        !isLastRow && "border-b border-border",
        dragVisualClasses(false, isDragOver),
      )}
    />
  );
}

// Typed on Rarity so a new tier can't be forgotten here again — mythic was,
// and fell through to common.
const RARITY_ORDER: Record<Rarity, number> = {
  mythic: 0,
  legendary: 1,
  rare: 2,
  uncommon: 3,
  common: 4,
};

/** Rarity, then name, then — so an upgraded copy leads its plainer twins —
 * highest level first. The order fresh tiles are placed in and the order the
 * quick sort starts from. */
function compareTiles(a: BankTile, b: BankTile): number {
  const ra = RARITY_ORDER[getItem(a.itemId)?.rarity ?? "common"];
  const rb = RARITY_ORDER[getItem(b.itemId)?.rarity ?? "common"];
  if (ra !== rb) return ra - rb;
  const byName = (getItem(a.itemId)?.name ?? a.itemId).localeCompare(
    getItem(b.itemId)?.name ?? b.itemId,
  );
  return byName || b.upgradeLevel - a.upgradeLevel;
}

export function InventoryView({
  herzie,
  initialItem,
  onLog,
  loaded,
  units,
  currency: cachedCurrency,
  equipped,
  onToggleEquip,
  onPredictUnits,
  bankExpansions,
  active = true,
}: {
  herzie: Herzie;
  initialItem?: string | null;
  onLog?: (msg: string) => void;
  /** False until the first inventory has arrived — nothing to lay out before. */
  loaded: boolean;
  /** Every owned copy, already optimistic — see useOptimisticUnits in main.tsx.
   * Held there rather than here so the 3D herzie and deck row move in the same
   * frame as the grid; keeping a local copy in sync with it only ever
   * reintroduced the flicker the optimistic layer exists to remove. */
  units: ItemUnit[];
  currency: number;
  /** Also optimistic, from the same place. */
  equipped: Equipped;
  onToggleEquip: (
    unitId: string,
    side?: GroundSide,
    /** Move a worn Accessory to `side` rather than take it off. */
    move?: boolean,
  ) => Promise<ToggleEquipResult>;
  /** Show a change to the copies that a request issued here is performing (a
   * sell, a dice upgrade), held until that request settles. */
  onPredictUnits: (
    update: (units: readonly ItemUnit[]) => ItemUnit[],
    settled: Promise<unknown>,
  ) => void;
  /** Inventory Expansions bought — sets how many slots the grid has. */
  bankExpansions: number;
  /** False while another tab is shown — pauses the 3D render. */
  active?: boolean;
}) {
  const capacity = bankCapacity(bankExpansions);
  const [currency, setCurrency] = useState(cachedCurrency || herzie.currency);
  /** Unsettled sells. While non-zero, an incoming snapshot is behind us. */
  const [sellsInFlight, setSellsInFlight] = useState(0);
  // handleSell is recreated every render and handed to SellBox/SellControls,
  // which can be holding a render-old copy. Reading the latest coin through a
  // ref (the friendsRef pattern used in FriendsView) is what lets a second sell
  // compose on the first one's prediction instead of discarding it.
  const currencyRef = useRef(currency);
  currencyRef.current = currency;
  /** The dice whose upgrade-target picker is open, if any. */
  const [diceUpgradeItem, setDiceUpgradeItem] = useState<string | null>(null);
  const [inspectItem, setInspectItem] = useState<string | null>(
    initialItem ?? null,
  );
  /** The exact copy Inspect was opened on, so a plain copy doesn't show its
   * +3 twin's level. A deep link names only an item, and falls back to the
   * best copy. */
  const [inspectUnitId, setInspectUnitId] = useState<string | null>(null);
  /** Sell popover and the tile menu, anchored where the right-click was. They name the TILE
   * (which is what says exactly which copies), not an item id. */
  const [sellBox, setSellBox] = useState<{
    tileKey: string;
    x: number;
    y: number;
  } | null>(null);
  /** A filled deck box's right-click menu, naming the worn copy. */
  const [deckMenu, setDeckMenu] = useState<{
    unitId: string;
    x: number;
    y: number;
  } | null>(null);
  /** A bag tile's right-click menu. */
  const [tileMenu, setTileMenu] = useState<{
    tileKey: string;
    x: number;
    y: number;
  } | null>(null);
  /** Open when the Sell duplicates button is awaiting confirmation. The
   * batch it will sell is recomputed at confirm time from `duplicates`. */
  const [sellDupesConfirm, setSellDupesConfirm] = useState(false);
  /** The empty deck slot whose picker is open (see DeckSlotPicker). */
  const [slotPicker, setSlotPicker] = useState<EmptySlotTarget | null>(null);
  const [slotOrder, setSlotOrder] = useState<(string | null)[]>(() =>
    loadSlotOrder(herzie.friendCode, capacity),
  );
  /** Rows the grid has — capacity always lands on whole rows, and never fewer
   * than the three that fill the panel. */
  const gridRows = Math.max(
    VISIBLE_ROWS,
    Math.ceil(slotOrder.length / GRID_COLS),
  );
  // Capacity arrives after mount (from the first sync, or right after a
  // purchase), so the arrangement has to grow to meet it. Existing placements
  // are untouched; the new slots are simply empty.
  useEffect(() => {
    setSlotOrder((prev) => {
      const fitted = fitSlotOrder(prev, capacity);
      return fitted.length === prev.length ? prev : fitted;
    });
  }, [capacity]);

  /** The grid's scroll viewport — for the drag auto-scroll, which reaches its
   * scroller (List's own element) through it. Rows are sized in CSS (see the
   * grid below), not from this: a measurement reads 0 while the view is hidden
   * and then jumps when it is shown, which made the grid pop into place every
   * time the view was navigated to. */
  const gridViewportRef = useRef<HTMLDivElement | null>(null);
  // { index, itemId } once a drag has actually started (past DRAG_THRESHOLD)
  // — null while just holding the button down without having moved yet.
  const [dragVisual, setDragVisual] = useState<
    | (DragHit & {
        source: DragSource;
        x: number;
        y: number;
      })
    | null
  >(null);
  // Mutable, not reactive — the pointermove/pointerup listeners below read
  // and mutate this directly rather than through React state, since they're
  // plain DOM listeners (not React event handlers) and fire far more often
  // than a render is needed for.
  const dragRef = useRef<
    | (DragHit & {
        /** Captured at pointerdown: the listeners below outlive the render
         * they were made in, so they can't look the tile up in `slotOrder`. */
        source: DragSource;
        startX: number;
        startY: number;
        dragging: boolean;
        /** Latest cursor Y, for the edge auto-scroll loop. */
        pointerY: number;
        lastX: number;
      })
    | null
  >(null);
  // Set right before a real drag's pointerup so the click that (in a
  // browser) follows it gets ignored instead of also placing the item. Set
  // only for a drag that changed slots, and cleared when the next gesture
  // starts — see handlePointerUp/handlePointerDown for why both matter.
  const suppressClickRef = useRef(false);
  /** The latest handleDeckDrop, for the drag listeners (which are set up once
   * and would otherwise call a first-render copy with stale units). */
  const deckDropRef = useRef<
    (tile: BankTile, over: DeckBox | null, x: number, y: number) => void
  >(() => {});
  /** The latest handleReturnDrop, for the same reason. */
  const returnDropRef = useRef<
    (unitId: string, overIndex: number | null, x: number, y: number) => void
  >(() => {});
  /** The latest handleDeckMove, for the same reason. */
  const deckMoveRef = useRef<
    (unitId: string, over: DeckBox | null, x: number, y: number) => void
  >(() => {});
  /** Where a card dragged out of the deck asked to land in the bag, until
   * reconcileSlotOrder has seated it. */
  const preferredSlotRef = useRef<{ key: string; index: number } | null>(null);

  /** Cards in the air between the bank and the deck (see ItemFlight). A copy
   * in here is drawn invisible where it's landing until it arrives. */
  const [flights, setFlights] = useState<Flight[]>([]);
  const nextFlightId = useRef(0);
  const flyingUnitIds = useMemo(
    () => new Set(flights.map((f) => f.unitId)),
    [flights],
  );
  const endFlight = (id: number) =>
    setFlights((prev) => prev.filter((f) => f.id !== id));

  /** A short message over the herzie — why a place or return was refused. */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(id);
  }, [notice]);

  // What the grid shows: one tile per unworn copy, a stack folded into one.
  // Held behind `units`, which is identity-stable while its content is, so this
  // isn't rebuilt by an unrelated render.
  const tiles = useMemo(() => bankTiles(units).sort(compareTiles), [units]);
  const tileByKey = useMemo(
    () => new Map(tiles.map((t) => [t.key, t])),
    [tiles],
  );

  // Adopt the shared AppState's coin — except while a sell is in flight, when it
  // is known to be behind our prediction and would revert the coin mid-request.
  // (The copies need no such gate: they come through the optimistic layer, which
  // holds its own prediction until the server catches up.)
  useEffect(() => {
    if (sellsInFlight > 0) return;
    setCurrency(cachedCurrency || herzie.currency);
  }, [cachedCurrency, herzie.currency, sellsInFlight]);

  useEffect(() => {
    if (!initialItem) return;
    setInspectItem(initialItem);
    setInspectUnitId(null);
  }, [initialItem]);

  // Custom press-and-drag instead of the native HTML5 Drag and Drop API —
  // Tauri's webview doesn't reliably fire dragstart/dragover/drop for
  // same-page drags, so this uses plain pointer events + `elementFromPoint`
  // hit-testing instead. Listens on the window (not the individual cells)
  // so the drag keeps tracking even once the cursor leaves the origin cell.
  useEffect(() => {
    const DRAG_THRESHOLD = 6;

    const handlePointerMove = (e: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      if (!state.dragging) {
        const dx = e.clientX - state.startX;
        const dy = e.clientY - state.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        state.dragging = true;
        if (!frame) frame = requestAnimationFrame(autoScroll);
      }
      state.pointerY = e.clientY;
      state.lastX = e.clientX;
      const hit = hitTest(e.clientX, e.clientY);
      Object.assign(state, hit);
      setDragVisual({
        ...hit,
        source: state.source,
        x: e.clientX,
        y: e.clientY,
      });
    };

    // Scrolls the grid while a drag is held near its top or bottom edge, so a
    // card can be dropped on a row that is currently off-screen. Runs on a frame
    // loop rather than off pointermove: a cursor parked at the edge stops
    // firing pointermove but should keep scrolling.
    let frame = 0;
    /** When the card reached the edge it's at; 0 while it's at neither. */
    let edgeSince = 0;
    const autoScroll = () => {
      const state = dragRef.current;
      // Ends with the drag, so nothing runs per-frame while idle (this view
      // stays mounted while another tab is showing).
      if (!state?.dragging) {
        frame = 0;
        edgeSince = 0;
        return;
      }
      frame = requestAnimationFrame(autoScroll);
      const viewport = gridViewportRef.current;
      // The scroller is List's own element, the viewport's only child.
      const scroller = viewport?.firstElementChild;
      if (!viewport || !(scroller instanceof HTMLElement)) return;
      const rect = viewport.getBoundingClientRect();
      // Up past the grid's top edge is the herzie: a card carried there is
      // headed for the deck, not for a row scrolled out of sight.
      const step = state.inZone
        ? 0
        : state.pointerY < rect.top + AUTOSCROLL_EDGE_PX
          ? -AUTOSCROLL_STEP_PX
          : state.pointerY > rect.bottom - AUTOSCROLL_EDGE_PX
            ? AUTOSCROLL_STEP_PX
            : 0;
      if (step === 0) {
        edgeSince = 0;
        return;
      }
      const now = performance.now();
      if (edgeSince === 0) edgeSince = now;
      if (now - edgeSince < AUTOSCROLL_DELAY_MS) return;
      scroller.scrollTop += step;
      // The cursor hasn't moved but the cell under it has: re-hit-test so the
      // drop target follows the scroll.
      const { overIndex } = hitTest(state.lastX, state.pointerY);
      if (overIndex !== state.overIndex) {
        state.overIndex = overIndex;
        setDragVisual((prev) => (prev ? { ...prev, overIndex } : prev));
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      const state = dragRef.current;
      dragRef.current = null;
      setDragVisual(null);
      if (!state?.dragging) return;
      // Any drag that got this far ends in a click the item must not act on —
      // including one let go over the slot it started on, which is "picked it
      // up and put it back", not a request to equip. What keeps a click with a
      // little hand drift working is DRAG_THRESHOLD, not this: drift under it
      // never becomes a drag at all.
      const { source, overIndex } = state;
      suppressClickRef.current = true;
      if (source.kind === "deck") {
        // Let go over the herzie, it stays on — moving sides if it's an
        // Accessory dropped on the other one; anywhere else, it comes off.
        if (state.inZone) {
          deckMoveRef.current(
            source.unitId,
            state.overDeck,
            e.clientX,
            e.clientY,
          );
        } else {
          returnDropRef.current(source.unitId, overIndex, e.clientX, e.clientY);
        }
        return;
      }
      if (state.inZone) {
        deckDropRef.current(source.tile, state.overDeck, e.clientX, e.clientY);
        return;
      }
      const { index } = source;
      if (overIndex === null || overIndex === index) return;
      setSlotOrder((prev) => {
        const next = [...prev];
        [next[index], next[overIndex]] = [next[overIndex], next[index]];
        return next;
      });
    };

    // A drop's trailing click isn't guaranteed to arrive: when pointerup lands
    // on a different cell than pointerdown, the click fires on their common
    // ancestor, which is no slot at all. Clearing the flag when the next
    // gesture begins keeps an unconsumed suppression from eating a later,
    // unrelated click instead of lingering until something happens to claim it.
    const handlePointerDown = () => {
      suppressClickRef.current = false;
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  const handleDragPointerDown = (index: number, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const key = slotOrder[index];
    const tile = key ? tileByKey.get(key) : undefined;
    if (!tile) return;
    startDrag({ kind: "bag", index, tile }, e);
  };

  /** Pointer down on a worn card in the deck: the start of a drag out. */
  const handleDeckPointerDown = (unitId: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;
    startDrag({ kind: "deck", unitId, itemId: unit.itemId }, e);
  };

  const startDrag = (source: DragSource, e: React.PointerEvent) => {
    dragRef.current = {
      source,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      overIndex: null,
      inZone: false,
      overDeck: null,
      pointerY: e.clientY,
      lastX: e.clientX,
    };
  };

  // No fetch on mount: this view stays mounted when hidden, so it fired at
  // launch whether or not the player opened it — duplicating refresh_app_cache,
  // which already fills the cache at startup. /sync now carries the
  // authoritative inventory and currency every few seconds, so both the initial
  // fill and any later drift are covered without a dedicated request.

  /** A rare-or-better sell waiting on the "are you sure?" prompt. */
  const [sellConfirm, setSellConfirm] = useState<{
    itemId: string;
    unitIds: string[];
  } | null>(null);

  /** Every sell entry point goes through here: rare and legendary items ask
   * first, anything else sells straight away. `unitIds` are the exact copies —
   * what the sell removes and what it pays for. */
  const requestSell = (itemId: string, unitIds: string[]) => {
    if (unitIds.length === 0) return;
    const rarity = getItem(itemId)?.rarity;
    if (rarity && CONFIRM_SELL_RARITIES.has(rarity)) {
      setSellConfirm({ itemId, unitIds });
      return;
    }
    handleSell(unitIds, itemId);
  };

  /** Sells exactly these copies. Resolves whether it worked. `itemId`, when the
   * sale is of one kind of thing, is only for the wording of a message. */
  const handleSell = async (
    unitIds: string[],
    itemId?: string,
  ): Promise<boolean> => {
    const name = itemId
      ? (getItem(itemId)?.name ?? itemId)
      : `${unitIds.length} items`;

    // Predict with the same function the server applies, so the card leaves the
    // grid and the coin ticks up on click rather than a round trip later, and
    // the response lands as a no-op instead of a visible correction.
    const sell = (base: readonly ItemUnit[], coin: number) =>
      applySell(base, coin, unitIds, (id) => getItem(id)?.sellPrice);
    const predicted = sell(units, currencyRef.current);
    if (!predicted.ok) {
      onLog?.(
        predicted.reason === "not-sellable"
          ? `"${name}" can't be sold`
          : `Not enough "${name}" to sell`,
      );
      return false;
    }

    setCurrency(predicted.newCurrency);
    // Also update the ref now, not just on the next render, so two sells fired
    // within a single tick still compose.
    currencyRef.current = predicted.newCurrency;
    // Selling the last one leaves nothing to preview — close it.
    if (inspectItem && !predicted.units.some((u) => u.itemId === inspectItem)) {
      setInspectItem(null);
    }

    const request = herzies.sellItem(unitIds);
    // A worn copy that is sold stops being worn; the optimistic layer derives
    // that from the copies leaving, so the creature drops it in the same frame.
    onPredictUnits((base) => {
      const outcome = sell(base, currencyRef.current);
      return outcome.ok ? outcome.units : [...base];
    }, request);

    setSellsInFlight((n) => n + 1);
    try {
      const result = await request;
      if (result) {
        // Authoritative, and by construction equal to the prediction.
        setCurrency(result.newCurrency);
        currencyRef.current = result.newCurrency;
        return true;
      }
      onLog?.(`Failed to sell "${name}"`);
      return false;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`Failed to sell "${name}": ${msg}`);
      return false;
    } finally {
      // No manual rollback on failure: once the last sell settles the gate
      // above lifts and the effect adopts the server's coin, which for a
      // failed sell is still the pre-sell balance. Restoring a value captured
      // before *this* sell would instead clobber any other sell still pending.
      setSellsInFlight((n) => Math.max(0, n - 1));
    }
  };

  /** Rolls a dice item onto ONE named card for DiceUpgradeOverlay. Not
   * optimistic, unlike handleSell: the server rolls, and a risky roll can go
   * three ways, so the overlay shows "Upgrading…" until the answer lands (the
   * response's item state then replaces ours, a broken card included). The
   * pre-check still runs here so a doomed request never leaves. Its twin —
   * another copy of the same card — is untouched. */
  const handleApplyDiceUpgrade = async (
    diceItemId: string,
    targetUnitId: string,
    protectionItemId: string | null,
  ): Promise<{ result: ItemUpgradeResult; newLevel: number }> => {
    const target = units.find((u) => u.id === targetUnitId);
    const targetName = getItem(target?.itemId ?? "")?.name ?? "that card";
    const needed = getItem(
      requiredDiceForLevel(target?.upgradeLevel ?? 0) ?? "",
    )?.name;
    const checked = applyItemUpgrade(units, diceItemId, targetUnitId, {
      protectionItemId,
    });
    if (!checked.ok) {
      const messages: Record<ItemUpgradeRejection, string> = {
        "not-dice": "Not a dice item",
        "dice-not-owned": "You don't have that dice",
        "target-not-owned": "You don't own that card",
        "not-statted": `"${targetName}" has no stats to upgrade`,
        "max-level": `"${targetName}" is already fully upgraded`,
        "wrong-dice": `"${targetName}" needs ${needed ?? "a different dice"}`,
        "protection-not-owned": "You don't have a Safety Pick",
      };
      onLog?.(messages[checked.reason]);
      throw new Error(messages[checked.reason]);
    }

    try {
      const out = await herzies.applyDiceUpgrade(
        diceItemId,
        targetUnitId,
        protectionItemId,
      );
      if (!out) throw new Error("No response");
      onLog?.(
        out.result === "upgraded"
          ? `Upgraded "${targetName}" to +${out.newLevel}`
          : out.result === "kept"
            ? `Upgrade failed — "${targetName}" kept at +${out.newLevel} (Safety Pick used)`
            : `Upgrade failed — "${targetName}" broke`,
      );
      return { result: out.result, newLevel: out.newLevel };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`Failed to upgrade "${targetName}": ${msg}`);
      throw e;
    }
  };

  /** Wears or removes one specific copy, flying its card between the bank and
   * the deck. There is no slot bookkeeping here: a copy is its own tile, so
   * when it leaves the grid the tile's slot empties on its own, and anything it
   * displaces lands in that freed slot (see reconcileSlotOrder).
   *
   * Every way in — a grid click, a deck click, a drop on the herzie, the
   * inspect overlay — comes through here, so this is where a full bank refuses
   * a return. Nothing else would: the server takes a card back into a full bank
   * and the grid then simply has no slot to show it in.
   *
   * `from` is where the card should take off; without one it leaves from its
   * own tile or deck box. */
  const handleEquip = async (
    unitId: string,
    side?: GroundSide,
    from?: { x: number; y: number },
  ): Promise<boolean> => {
    const unit = units.find((u) => u.id === unitId);
    if (!unit) return false;
    const def = getItem(unit.itemId);
    const name = def?.name ?? "item";
    const returning = unit.equippedSlot !== null;

    // Whether the bank still fits once this lands — a return adds a tile, and
    // so does a place that knocks something else off. Only a move that grows
    // the bank past capacity is refused: a swap that nets out, a return onto
    // an existing stack, and a bank that is somehow already over (a snapshot
    // from before an expansion was counted) all go through.
    const predicted = applyEquip(
      units,
      unitId,
      returning ? "unequip" : "equip",
      def?.equipSlot,
      !returning && def?.equipSlot === "ground"
        ? (side ?? pickGroundSide(equipped))
        : undefined,
    );
    if (predicted.ok) {
      const after = bankTiles(predicted.units).length;
      if (after > capacity && after > tiles.length) {
        setNotice(
          returning
            ? `Inventory full — "${name}" can't be returned`
            : `Inventory full — no room for what "${name}" replaces`,
        );
        onLog?.(
          `Couldn't ${returning ? "return" : "place"} "${name}": inventory full`,
        );
        return false;
      }
    }

    // Only a move that will happen gets a flight — a refused one (a full
    // Modifier row, say) is known now, and has nowhere to fly to.
    const created: Flight[] = [];
    if (predicted.ok) {
      // Measured before the move: the tile or box it leaves is gone after it.
      const origin =
        from ??
        centre(
          document.querySelector(returning ? toDeck(unitId) : toBank(unitId)),
        );
      if (origin) {
        created.push({
          id: nextFlightId.current++,
          itemId: unit.itemId,
          unitId,
          from: origin,
          target: returning ? toBank(unitId) : toDeck(unitId),
        });
      }
      // Whatever a place knocks off flies back to the bank too — from its box,
      // which the incoming card is about to take over.
      if (!returning) {
        for (const before of units) {
          if (before.id === unitId || before.equippedSlot === null) continue;
          const after = predicted.units.find((u) => u.id === before.id);
          if (after?.equippedSlot !== null) continue;
          const boxAt = centre(document.querySelector(toDeck(before.id)));
          if (!boxAt) continue;
          created.push({
            id: nextFlightId.current++,
            itemId: before.itemId,
            unitId: before.id,
            from: boxAt,
            target: toBank(before.id),
          });
        }
      }
      // Set in the same tick as the optimistic move below, so each card's new
      // spot renders hidden on its very first frame rather than flashing in
      // before the flight gets there.
      if (created.length > 0) setFlights((prev) => [...prev, ...created]);
    }

    const result = await onToggleEquip(unitId, side);
    if (result.ok) {
      onLog?.(
        result.action === "equip" ? `Placed "${name}"` : `Returned "${name}"`,
      );
      return true;
    }
    // Nothing moved (or it moved back), so there's nothing to fly to.
    for (const f of created) endFlight(f.id);
    if (!result.sent) setNotice(result.error);
    const verb = result.action === "equip" ? "place" : "return";
    onLog?.(`Failed to ${verb} "${name}": ${result.error}`);
    return false;
  };

  /** The one deck box a card of `equipSlot` would land in if dropped now —
   * both what the drop does and what the deck lights up while dragging, so
   * the two can't disagree. `aimed` is the box under the cursor, if any.
   *
   *  - Modifiers go in the next free box, whichever one was aimed at; with
   *    none free there's nowhere to land (the equip refuses it).
   *  - Accessories go on the side aimed at if it's free. Aimed at a taken
   *    side while the other is free, they take the free one — replacing an
   *    Accessory means dropping on it with both sides full. Not aimed at all,
   *    the first free side, else the left.
   *  - Everything else has exactly one box. */
  const landingBox = (
    equipSlot: EquipSlot,
    aimed: DeckBox | null,
  ): DeckBox | null => {
    if (equipSlot === "modifier") {
      return (equipped.modifier?.length ?? 0) < MAX_MODIFIERS
        ? { equipSlot, side: undefined }
        : null;
    }
    if (equipSlot !== "ground") return { equipSlot, side: undefined };
    const free = (s: GroundSide) => !equipped[groundSlot(s)];
    const at = aimed?.equipSlot === "ground" ? aimed.side : undefined;
    const side: GroundSide =
      at && free(at)
        ? at
        : free("left")
          ? "left"
          : free("right")
            ? "right"
            : (at ?? "left");
    return { equipSlot, side };
  };

  /** A bag card let go over the herzie: anywhere on it counts, a box of the
   * wrong kind included, and it goes in its landingBox. A full Modifier row
   * is refused by the equip itself (see handleEquip's notice). Anything that
   * can't be worn — dice, charms, artefacts — does nothing. */
  const handleDeckDrop = (
    tile: BankTile,
    over: DeckBox | null,
    x: number,
    y: number,
  ) => {
    const def = getItem(tile.itemId);
    if (!def?.equipable || !def.equipSlot) return;
    handleEquip(tile.unitIds[0], landingBox(def.equipSlot, over)?.side, {
      x,
      y,
    });
  };
  deckDropRef.current = handleDeckDrop;

  /** A worn card dragged out of the deck and let go off the herzie: it comes
   * off, landing on the bag slot it was dropped on if that one is empty. */
  const handleReturnDrop = async (
    unitId: string,
    overIndex: number | null,
    x: number,
    y: number,
  ) => {
    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;
    const key = getItem(unit.itemId)?.stackable
      ? `stack:${unit.itemId}`
      : unitId;
    if (overIndex !== null && slotOrder[overIndex] === null) {
      preferredSlotRef.current = { key, index: overIndex };
    }
    const ok = await handleEquip(unitId, undefined, { x, y });
    if (!ok) preferredSlotRef.current = null;
  };
  returnDropRef.current = handleReturnDrop;

  /** The side a worn Accessory would move to if let go over `over` — the other
   * Accessory box, or nothing. It's the only move there is within the deck:
   * every other box takes a slot of its own, and Modifiers have no order to
   * keep. */
  const sideMoveTarget = (
    unitId: string,
    over: DeckBox | null,
  ): GroundSide | null => {
    const from = units.find((u) => u.id === unitId)?.equippedSlot;
    if (from !== "ground_left" && from !== "ground_right") return null;
    if (over?.equipSlot !== "ground" || !over.side) return null;
    return groundSlot(over.side) === from ? null : over.side;
  };

  /** A worn card let go over the herzie. An Accessory dropped on the other
   * Accessory box moves there, and whatever was in that box takes its old
   * side — a swap. Anything else stays where it was.
   *
   * Two requests, both sent at once: equip_unit moves a worn copy by freeing
   * its old slot and displacing the incumbent, so whichever lands first, the
   * pair ends with the two sides exchanged. No bank check either: the card
   * the first one displaces is back in the deck a moment later. */
  const handleDeckMove = async (
    unitId: string,
    over: DeckBox | null,
    x: number,
    y: number,
  ) => {
    const to = sideMoveTarget(unitId, over);
    const unit = units.find((u) => u.id === unitId);
    if (!to || !unit) return;
    const from: GroundSide = to === "left" ? "right" : "left";
    const other = units.find((u) => u.equippedSlot === groundSlot(to));

    const created: Flight[] = [
      {
        id: nextFlightId.current++,
        itemId: unit.itemId,
        unitId,
        from: { x, y },
        target: toDeck(unitId),
      },
    ];
    const otherAt = other && centre(document.querySelector(toDeck(other.id)));
    if (other && otherAt) {
      created.push({
        id: nextFlightId.current++,
        itemId: other.itemId,
        unitId: other.id,
        from: otherAt,
        target: toDeck(other.id),
      });
    }
    setFlights((prev) => [...prev, ...created]);

    const name = (u: ItemUnit) => getItem(u.itemId)?.name ?? "item";
    const results = await Promise.all([
      onToggleEquip(unitId, to, true),
      ...(other ? [onToggleEquip(other.id, from, true)] : []),
    ]);
    const failed = results.find((r) => !r.ok);
    if (!failed) {
      onLog?.(
        other
          ? `Swapped "${name(unit)}" and "${name(other)}"`
          : `Moved "${name(unit)}" to the ${to}`,
      );
      return;
    }
    for (const f of created) endFlight(f.id);
    if (!failed.ok) {
      if (!failed.sent) setNotice(failed.error);
      onLog?.(`Failed to move "${name(unit)}": ${failed.error}`);
    }
  };
  deckMoveRef.current = handleDeckMove;

  // Grid click places a copy directly — a no-op for non-equipable items
  // (e.g. plain collectible cards) rather than a doomed equip attempt. Also a
  // no-op right after a drag that moved the item to another slot, so dropping
  // it doesn't also place it (see suppressClickRef).
  //
  // Never a *return*, unlike the deck and the inspect overlay: every tile on
  // this grid is by construction a copy that isn't being worn, so a click here
  // can only mean "place this copy". If another copy of the same item is
  // already worn that's a swap — the worn one comes off, this one goes on — so
  // a +3 can replace a plain one just by clicking it.
  const handleGridClick = (tile: BankTile) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const def = getItem(tile.itemId);
    // Dice don't equip — clicking one opens the upgrade-target picker
    // instead (see DiceUpgradeOverlay).
    if (def?.dice) {
      setDiceUpgradeItem(tile.itemId);
      return;
    }
    if (!def?.equipable) return;
    handleEquip(tile.unitIds[0]);
  };

  /** Every spare copy, of everything sellable in the bank — what the Sell
   * duplicates button offers. For each item the best copy is kept — the worn
   * one, else the most upgraded — and the rest are the spares. So the one you'd
   * miss is never the one that goes, and since a worn copy is always the one
   * kept, nothing can be sold out from under the deck.
   *
   * Anything in CONFIRM_SELL_RARITIES — rare and legendary — is left out
   * however many you own, so this only ever clears common and uncommon
   * clutter. Spares of the good stuff are the likeliest to be wanted for a
   * trade, and are exactly the items that already demand a per-item "are you
   * sure" before they can be sold; a one-click bulk action has no business
   * turning them into coin. Reusing that same set rather than listing the
   * rarities again is what keeps the two from drifting apart: whatever is
   * worth a second look is, by definition, not bulk-sellable.
   *
   * Stackable items are left out too, which is what keeps this a decluttering
   * action rather than a payout. A stack occupies one grid cell however many
   * you own, so selling its spares frees nothing — it just converts them to
   * coin, and a stack already has its own "Sell all" in the right-click menu.
   * Only non-stackable spares cost a slot each, and they are the whole reason
   * this button exists. Anything with no sellPrice is skipped too — applySell
   * would refuse it. */
  const duplicates = [...new Set(tiles.map((t) => t.itemId))].flatMap(
    (itemId) => {
      const def = getItem(itemId);
      if (
        !def ||
        def.stackable ||
        !def.sellPrice ||
        CONFIRM_SELL_RARITIES.has(def.rarity)
      ) {
        return [];
      }
      const spares = unitsBestFirst(units, itemId).slice(1);
      return spares.length > 0
        ? [
            {
              itemId,
              unitIds: spares.map((u) => u.id),
              qty: spares.length,
              price: def.sellPrice,
            },
          ]
        : [];
    },
  );
  const duplicatesTotal = duplicates.reduce(
    (sum, d) => sum + d.qty * d.price,
    0,
  );
  const duplicatesCount = duplicates.reduce((sum, d) => sum + d.qty, 0);

  /** Sells the whole duplicate batch in one request. It used to go one item id
   * at a time, sequentially, because the sell route was a read-modify-write
   * with no lock and two in flight at once clobbered each other; selling is now
   * a single locked transaction that takes any number of copies, so one call
   * does it. */
  const sellDuplicates = async () => {
    const batch = duplicates;
    if (batch.length === 0) return;
    const count = duplicatesCount;
    const total = duplicatesTotal;
    const ok = await handleSell(batch.flatMap((d) => d.unitIds));
    if (ok) {
      onLog?.(
        `Sold ${count} duplicate${count === 1 ? "" : "s"} for ${formatAmount(total)} coins`,
      );
    }
  };

  const loading = !loaded;

  /** What can go in the empty deck slot whose picker is open.
   *
   * Filtered on the item's own `equipSlot`, not on the group's broader
   * `itemType`: equipping routes by `equipSlot` and *displaces* whatever the
   * slot already holds, so offering a hat in the empty Face box would silently
   * take off the hat that's already on. That does mean the list can come up
   * empty while the player owns plenty of other Equipment — which is what
   * DeckSlotPicker's slot-name header is there to explain.
   *
   * Drawn from the tiles (rarity-then-name sorted), one row per item at each
   * level: identical copies are one and the same move, a copy at another level
   * is a different one. An item that's already worn is left out — wearing a
   * second copy of it is a swap, which belongs to clicking that copy in the
   * bank, not to filling an empty box. */
  const wornItemIds = new Set(
    units.filter((u) => u.equippedSlot !== null).map((u) => u.itemId),
  );
  const slotPickerOptions: PickerOption[] = [];
  if (slotPicker) {
    const seen = new Set<string>();
    for (const tile of tiles) {
      const def = getItem(tile.itemId);
      if (def?.equipSlot !== slotPicker.equipSlot) continue;
      if (wornItemIds.has(tile.itemId)) continue;
      const key = `${tile.itemId}:${tile.upgradeLevel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slotPickerOptions.push({
        itemId: tile.itemId,
        unitId: tile.unitIds[0],
        upgradeLevel: tile.upgradeLevel,
      });
    }
  }

  // Keep the saved slot arrangement in sync with what's actually owned —
  // see reconcileSlotOrder. Keyed on the joined list (not `tiles`, a new array
  // whenever anything changes) so this only runs when the set of tiles does.
  const tileKeysJoined = tiles.map((t) => t.key).join(",");
  // `capacity` is a dependency too: tiles that didn't fit before an expansion
  // were left unplaced, and only a fresh reconcile seats them in the new slots.
  // (The effect that pads the arrangement to the new capacity is declared
  // earlier, so it has already run by the time this one reconciles.)
  useEffect(() => {
    const keys = tileKeysJoined ? tileKeysJoined.split(",") : [];
    const preferred = preferredSlotRef.current;
    setSlotOrder((prev) => reconcileSlotOrder(prev, keys, preferred));
    if (preferred && keys.includes(preferred.key)) {
      preferredSlotRef.current = null;
    }
  }, [tileKeysJoined, capacity]);

  useEffect(() => {
    try {
      localStorage.setItem(
        slotStorageKey(herzie.friendCode),
        JSON.stringify(slotOrder),
      );
    } catch {
      // Local-only convenience; fine to lose on a storage failure (private
      // browsing quotas, etc.) — the next reconcile just re-derives it.
    }
  }, [slotOrder, herzie.friendCode]);

  /** What the deck shows of a bag card being dragged: which cluster it
   * belongs in, and the box it would land in. Only for cards that can be worn. */
  const dragSource = dragVisual?.source;
  const draggedDef = dragSource ? getItem(sourceItemId(dragSource)) : undefined;
  // A worn card being dragged only has somewhere to land if it's an Accessory
  // over the other Accessory box (see sideMoveTarget).
  const deckMoveSide =
    dragVisual && dragSource?.kind === "deck"
      ? sideMoveTarget(dragSource.unitId, dragVisual.overDeck)
      : null;
  const deckDrag: DeckDragState | null =
    dragVisual && draggedDef?.equipable && draggedDef.equipSlot
      ? {
          equipSlot: draggedDef.equipSlot,
          landing:
            dragSource?.kind === "bag"
              ? landingBox(draggedDef.equipSlot, dragVisual.overDeck)
              : deckMoveSide
                ? { equipSlot: "ground", side: deckMoveSide }
                : null,
          inZone: dragVisual.inZone,
        }
      : null;
  const draggingOutUnitId =
    dragSource?.kind === "deck" ? dragSource.unitId : null;
  /** A deck card is being carried over the bag, where letting go returns it. */
  const returningOverBag = draggingOutUnitId !== null && !dragVisual?.inZone;

  // Read off the copies, so each worn one counts at its own upgrade level.
  const stats = getHerzieStatsFromUnits(units);
  /** What the stats would become if the card being dragged were let go now:
   * a bag card over the herzie going on, a deck card off it coming off. */
  const statsPreview = (() => {
    if (!dragVisual || !dragSource || !draggedDef) return null;
    if (dragSource.kind === "bag") {
      if (!deckDrag?.inZone || !deckDrag.landing) return null;
      const out = applyEquip(
        units,
        dragSource.tile.unitIds[0],
        "equip",
        draggedDef.equipSlot,
        deckDrag.landing.side,
      );
      return out.ok ? getHerzieStatsFromUnits(out.units) : null;
    }
    if (dragVisual.inZone) return null;
    const out = applyEquip(units, dragSource.unitId, "unequip", undefined);
    return out.ok ? getHerzieStatsFromUnits(out.units) : null;
  })();

  // The overlay opens on an item id (a deep link from a notification), so it
  // shows the copy that id most plausibly means: the one worn, else the best.
  const inspected = inspectItem ? getItem(inspectItem) : null;
  const inspectUnit = inspectItem
    ? (units.find((u) => u.id === inspectUnitId && u.itemId === inspectItem) ??
      bestUnitOf(units, inspectItem))
    : undefined;
  const inspectedEquipped = inspectUnit?.equippedSlot != null;
  const inspectedModifierCapped =
    !inspectedEquipped &&
    inspected?.equipSlot === "modifier" &&
    (equipped.modifier?.length ?? 0) >= MAX_MODIFIERS;
  const inspectedStageLocked =
    !inspectedEquipped &&
    !!inspected &&
    !meetsMinStage(inspected, herzie.stage);
  const inspectedGroundSide =
    inspected?.equipSlot === "ground"
      ? inspectUnit?.equippedSlot === "ground_left"
        ? "L"
        : inspectUnit?.equippedSlot === "ground_right"
          ? "R"
          : null
      : null;

  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const stagePad = useAlignToHomeStage(viewRef, stageRef, active);

  return (
    <div ref={viewRef} className="flex h-full flex-col">
      <div className="z-50 mb-1 flex items-center justify-between">
        {/* leading-5: a whole-pixel header height keeps the deck's pixel-art
            icons below it on whole pixels (see OVERLAY_TITLE). */}
        <h1 className="text-ui-lg leading-5 font-bold text-cyan">Herzie</h1>
        <Tooltip label={`${formatAmount(currency)} herzie coins`}>
          <div className="text-ui text-cyan">
            <Coin amount={currency} animate />
          </div>
        </Tooltip>
      </div>

      {/* Stats just under the title, flush left like the deck below. A
          zero-height row, so they float over the sky without pushing the
          stage down (which would undo its alignment with Home's). */}
      <div className="relative h-0 shrink-0">
        <div className="pointer-events-none absolute top-2 left-0 z-10">
          <StatsPanel stats={stats} preview={statsPreview} />
        </div>
      </div>

      {/* The herzie, then the deck beneath — so whatever goes on shows on the
          creature right there. The whole area, deck included, takes a
          dropped card. */}
      {/* Pads the stage down to where Home's sits, so the herzie doesn't jump
          when switching views (see useStageAlignment). */}
      <div className="shrink-0" style={{ height: stagePad }} />
      <div
        ref={stageRef}
        {...{ [HERZIE_ZONE_ATTR]: "" }}
        className="flex shrink-0 flex-col"
      >
        {/* The stage: HERZIE_STAGE_HEIGHT, the same as on Home, so the herzie
            doesn't move when switching between the two. */}
        <div className="relative" style={{ height: HERZIE_STAGE_HEIGHT }}>
          <div className="flex h-full items-center justify-center">
            <Herzie3D
              userId={herzie.friendCode}
              stage={herzie.stage}
              equipped={equipped}
              paused={!active}
              grounded
            />
          </div>
          {notice && (
            <div
              role="status"
              className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center"
            >
              <div className="border border-red/60 bg-bg-panel px-2 py-1 text-ui-sm text-red">
                {notice}
              </div>
            </div>
          )}
        </div>
        {/* Part of the content rather than laid over the herzie: its own
            strip between the herzie and the bag. */}
        <div className="z-10 shrink-0">
          <DeckOverlay
            equipped={equipped}
            units={units}
            flyingUnitIds={flyingUnitIds}
            drag={deckDrag}
            draggingUnitId={draggingOutUnitId}
            onUnequip={(unitId) => {
              // Dragged out and dropped straight back on its own box.
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              handleEquip(unitId);
            }}
            onDragStart={handleDeckPointerDown}
            onMenuRequest={(unitId, x, y) => setDeckMenu({ unitId, x, y })}
            onPlaceRequest={setSlotPicker}
          />
        </div>
      </div>

      {/* The bag: whatever the stage and deck leave. */}
      <div className="z-10 flex min-h-0 flex-1 flex-col">
        {/* Both buttons live in one wrapper so they read as a pair, and the
            wrapper's `ml-auto` pushes them right. */}
        <div className="mb-0.5 flex items-center border-b border-border">
          <span className="py-0.5 text-ui font-bold text-text-dim">Bag</span>
          <div className="ml-auto flex items-center">
            <Tooltip
              label={
                duplicatesCount > 0
                  ? `Sell ${duplicatesCount} duplicate${duplicatesCount === 1 ? "" : "s"}, keeping the best of each`
                  : "No duplicates to sell"
              }
            >
              <button
                type="button"
                aria-label="Sell duplicates"
                disabled={duplicatesCount === 0}
                onClick={() => setSellDupesConfirm(true)}
                className="flex cursor-pointer items-center border-none bg-transparent px-1.5 py-0.5 text-text-dim hover:text-cyan disabled:cursor-default disabled:opacity-40 disabled:hover:text-text-dim"
              >
                <DuplicatesIcon className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip label="Quick sort">
              <button
                type="button"
                aria-label="Quick sort"
                onClick={() =>
                  setSlotOrder(sortSlotsByType(tiles, slotOrder.length))
                }
                className="flex cursor-pointer items-center border-none bg-transparent px-1.5 py-0.5 text-text-dim hover:text-cyan"
              >
                {/* 14px rather than the item pips' 16px: these are chrome
                    beside the bar's label, not content, and read better a
                    little smaller. A 16x16 PixelIcon only lands on whole
                    device pixels at 16px (or a multiple), so both glyphs are
                    drawn at 2px stroke weight to survive the fractional
                    scale — a 1px feature here would go visibly soft. */}
                <SortIcon className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
        </div>

        {loading ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            Loading...
          </div>
        ) : (
          // Three rows fill the panel; past that (each Inventory Expansion adds
          // two rows) it scrolls. No fade hints at the edges, and scrollbars
          // are hidden app-wide.
          <div
            ref={gridViewportRef}
            className={cn(
              "min-h-0 flex-1",
              returningOverBag && "ring-1 ring-inset ring-cyan/50",
            )}
          >
            {/* Each row is a third of the visible height, in CSS, so the rows
                are right on the very first frame — no measuring, and nothing to
                jump when the view is shown. The content is `rows / 3` viewports
                tall (a percentage of the scroller) and the grid splits that
                evenly, which is what makes each row a third. */}
            <List
              className="h-full"
              fades={false}
              contentStyle={{
                height: `${(gridRows * 100) / VISIBLE_ROWS}%`,
              }}
            >
              <div
                className="grid h-full grid-cols-6"
                style={{ gridAutoRows: `${100 / gridRows}%` }}
              >
                {slotOrder.map((key, i) => {
                  const isLastCol = i % GRID_COLS === GRID_COLS - 1;
                  const isLastRow = i >= slotOrder.length - GRID_COLS;
                  const tile = key ? tileByKey.get(key) : undefined;
                  if (!tile) {
                    return (
                      <EmptyGridCell
                        key={`slot-${i}`}
                        index={i}
                        isLastCol={isLastCol}
                        isLastRow={isLastRow}
                        isDragOver={dragVisual?.overIndex === i}
                      />
                    );
                  }
                  return (
                    <ItemGridCell
                      key={`slot-${i}`}
                      index={i}
                      itemId={tile.itemId}
                      unitIds={tile.unitIds}
                      level={tile.upgradeLevel}
                      isLastCol={isLastCol}
                      isLastRow={isLastRow}
                      isDragging={
                        dragSource?.kind === "bag" && dragSource.index === i
                      }
                      // A card from the deck can only be dropped on an empty
                      // slot — dropped on a full one it finds its own.
                      isDragOver={
                        dragSource?.kind === "bag" &&
                        dragVisual?.overIndex === i
                      }
                      flying={tile.unitIds.some((id) => flyingUnitIds.has(id))}
                      equipped={equipped}
                      onPlace={() => handleGridClick(tile)}
                      onMenuRequest={(x, y) =>
                        setTileMenu({ tileKey: tile.key, x, y })
                      }
                      onDragPointerDown={handleDragPointerDown}
                    />
                  );
                })}
              </div>
            </List>
          </div>
        )}
      </div>

      <ItemFlights flights={flights} onDone={endFlight} />

      {inspectItem && inspected && (
        <ItemInspectOverlay
          itemId={inspectItem}
          // Escape reaches both this and the sell confirmation; let it only
          // dismiss the prompt, leaving the preview open underneath.
          onClose={() => {
            if (!sellConfirm) setInspectItem(null);
          }}
          equipped={equipped}
          level={inspectUnit?.upgradeLevel ?? 0}
          meta={inspectedGroundSide || undefined}
          footer={
            <>
              {inspected.equipable &&
                (() => {
                  const button = (
                    <button
                      type="button"
                      className="btn"
                      disabled={
                        inspectedModifierCapped ||
                        inspectedStageLocked ||
                        !inspectUnit
                      }
                      onClick={() => inspectUnit && handleEquip(inspectUnit.id)}
                    >
                      {inspectedEquipped ? "Return" : "Place"}
                    </button>
                  );
                  if (inspectedStageLocked) {
                    return (
                      <Tooltip
                        label={`Your herzie needs to reach stage ${inspected.minStage} to wear this`}
                      >
                        {button}
                      </Tooltip>
                    );
                  }
                  return inspectedModifierCapped ? (
                    <Tooltip
                      label={`Max modifiers placed (${MAX_MODIFIERS}/${MAX_MODIFIERS})`}
                    >
                      {button}
                    </Tooltip>
                  ) : (
                    button
                  );
                })()}
              {/* No Sell here: selling lives in the bag's right-click menu. */}
            </>
          }
        />
      )}

      {diceUpgradeItem && (
        <DiceUpgradeOverlay
          diceItemId={diceUpgradeItem}
          units={units}
          onRoll={(targetUnitId, protectionItemId) =>
            handleApplyDiceUpgrade(
              diceUpgradeItem,
              targetUnitId,
              protectionItemId,
            )
          }
          onClose={() => setDiceUpgradeItem(null)}
        />
      )}

      {deckMenu &&
        (() => {
          const unit = units.find((u) => u.id === deckMenu.unitId);
          if (!unit) return null;
          return (
            <ContextMenu
              x={deckMenu.x}
              y={deckMenu.y}
              onClose={() => setDeckMenu(null)}
              items={[
                {
                  label: "Inspect",
                  onClick: () => {
                    setInspectItem(unit.itemId);
                    setInspectUnitId(unit.id);
                    setDeckMenu(null);
                  },
                },
                // Sells exactly the worn copy — a box holds one, so there's no
                // quantity to pick. Selling it takes it off; rare and up still
                // ask first (see requestSell).
                ...(getItem(unit.itemId)?.sellPrice
                  ? [
                      {
                        label: "Sell",
                        onClick: () => {
                          requestSell(unit.itemId, [unit.id]);
                          setDeckMenu(null);
                        },
                      },
                    ]
                  : []),
              ]}
            />
          );
        })()}

      {tileMenu &&
        (() => {
          const tile = tileByKey.get(tileMenu.tileKey);
          if (!tile) return null;
          const qty = tile.unitIds.length;
          const def = getItem(tile.itemId);
          const canSellAll = (def?.stackable ?? false) && qty > 1;
          return (
            <ContextMenu
              x={tileMenu.x}
              y={tileMenu.y}
              onClose={() => setTileMenu(null)}
              items={[
                {
                  label: "Inspect",
                  onClick: () => {
                    setInspectItem(tile.itemId);
                    setInspectUnitId(tile.unitIds[0]);
                    setTileMenu(null);
                  },
                },
                ...(def?.sellPrice
                  ? [
                      {
                        label: "Sell",
                        onClick: () => {
                          setSellBox(tileMenu);
                          setTileMenu(null);
                        },
                      },
                    ]
                  : []),
                // Skips the quantity popover and sells the whole stack.
                ...(canSellAll
                  ? [
                      {
                        label: "Sell all",
                        onClick: () => {
                          requestSell(tile.itemId, tile.unitIds);
                          setTileMenu(null);
                        },
                      },
                    ]
                  : []),
              ]}
            />
          );
        })()}

      {sellDupesConfirm && (
        <PromptOverlay
          title="Sell duplicates?"
          titleId="confirm-sell-dupes-title"
          onEscape={() => setSellDupesConfirm(false)}
          actions={[
            {
              label: "Keep them",
              colour: "text-text-dim",
              onClick: () => setSellDupesConfirm(false),
            },
            {
              label: "Sell",
              colour: "text-red",
              onClick: () => {
                setSellDupesConfirm(false);
                sellDuplicates();
              },
            },
          ]}
        >
          <div className="flex flex-col gap-2">
            <div>
              Sell {duplicatesCount} duplicate
              {duplicatesCount === 1 ? "" : "s"} for{" "}
              <Coin amount={duplicatesTotal} />? The best copy of each is kept,
              and rare and legendary items are never sold.
            </div>
            {/* The breakdown, since this is the one sell action where what
                goes is not the thing that was clicked. Capped so a bank full
                of odds and ends can't outgrow the dialog. Nothing valuable
                can hide behind "+N more": the batch is common and uncommon
                only (see `duplicates`), and the tiles sort rarity-first (see
                RARITY_ORDER) so the uncommons are the rows that do show. */}
            <div className="flex flex-col gap-0.5 text-ui-sm text-text-dim">
              {duplicates.slice(0, 6).map((d) => {
                const def = getItem(d.itemId);
                return (
                  <div key={d.itemId} className="flex justify-between gap-3">
                    <span className="truncate">
                      {d.qty}x{" "}
                      <span
                        style={{
                          color: def ? RARITY_COLORS[def.rarity] : undefined,
                        }}
                      >
                        {def?.name ?? d.itemId}
                      </span>
                    </span>
                    <span className="shrink-0">
                      <Coin amount={d.qty * d.price} />
                    </span>
                  </div>
                );
              })}
              {duplicates.length > 6 && (
                <div>+{duplicates.length - 6} more</div>
              )}
            </div>
          </div>
        </PromptOverlay>
      )}

      {slotPicker && (
        <DeckSlotPicker
          x={slotPicker.x}
          y={slotPicker.y}
          slotLabel={slotPicker.label}
          options={slotPickerOptions}
          onPick={(unitId) => {
            // Closed before the await, as the sell menu does: the optimistic
            // equip fills the slot on the next render anyway, so leaving the
            // list up would only show a stale row for the item just placed.
            setSlotPicker(null);
            handleEquip(unitId, slotPicker.side);
          }}
          onClose={() => setSlotPicker(null)}
        />
      )}

      {sellBox &&
        (() => {
          const tile = tileByKey.get(sellBox.tileKey);
          const item = tile ? getItem(tile.itemId) : undefined;
          if (!tile || !item?.sellPrice) return null;
          return (
            <SellBox
              itemId={tile.itemId}
              x={sellBox.x}
              y={sellBox.y}
              qty={tile.unitIds.length}
              price={item.sellPrice}
              stackable={item.stackable ?? false}
              onSell={(qty) => {
                requestSell(tile.itemId, tile.unitIds.slice(0, qty));
                setSellBox(null);
              }}
              onClose={() => setSellBox(null)}
            />
          );
        })()}

      {sellConfirm &&
        (() => {
          const item = getItem(sellConfirm.itemId);
          if (!item) return null;
          const qty = sellConfirm.unitIds.length;
          const total = qty * (item.sellPrice ?? 0);
          return (
            <PromptOverlay
              title={`Sell ${RARITY_LABELS[item.rarity].toLowerCase()} item?`}
              titleId="confirm-sell-title"
              onEscape={() => setSellConfirm(null)}
              actions={[
                {
                  label: "Keep it",
                  colour: "text-text-dim",
                  onClick: () => setSellConfirm(null),
                },
                {
                  label: "Sell",
                  colour: "text-red",
                  onClick: () => {
                    handleSell(sellConfirm.unitIds, sellConfirm.itemId);
                    setSellConfirm(null);
                  },
                },
              ]}
            >
              Are you sure you want to sell {qty > 1 ? `${qty}x ` : ""}
              <span style={{ color: RARITY_COLORS[item.rarity] }}>
                "{item.name}"
              </span>{" "}
              for <Coin amount={total} />?
            </PromptOverlay>
          );
        })()}

      {dragVisual &&
        (() => {
          if (!draggedDef) return null;
          return createPortal(
            <div
              className="pointer-events-none fixed z-200 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
              style={{ left: dragVisual.x, top: dragVisual.y }}
            >
              <ItemTypeIcon
                item={draggedDef}
                className="h-6 w-6 drop-shadow-[0_0_4px_rgba(0,0,0,0.8)]"
              />
            </div>,
            document.body,
          );
        })()}
    </div>
  );
}
