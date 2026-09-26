import type {
  BankTile,
  Equipped,
  GroundSide,
  Herzie,
  ItemType,
  ItemUnit,
  ItemUpgradeRejection,
  Rarity,
} from "@herzies/shared";
import {
  applyItemUpgrade,
  applySell,
  BANK_SLOT_COUNT,
  bankCapacity,
  bankTiles,
  bestUnitOf,
  DECK_SLOT_GROUPS,
  getItem,
  getItemType,
  MAX_MODIFIERS,
  pickPlainestUnitIds,
  RARITY_COLORS,
  RARITY_LABELS,
  unitsBestFirst,
} from "@herzies/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ToggleEquipResult } from "../hooks/useOptimisticUnits";
import { cn, formatAmount } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { Coin } from "./Coin";
import { ContextMenu } from "./ContextMenu";
import { DeckRow, type EmptySlotTarget } from "./DeckRow";
import { DeckSlotPicker, type PickerOption } from "./DeckSlotPicker";
import { DiceUpgradeOverlay } from "./DiceUpgradeOverlay";
import { Herzie3D } from "./Herzie3D";
import ItemInspectOverlay, { ItemPreviewCard } from "./ItemInspectOverlay";
import { DuplicatesIcon } from "./icons/DuplicatesIcon";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { SortIcon } from "./icons/SortIcon";
import { List } from "./List";
import { NumberTicker } from "./NumberTicker";
import { PromptOverlay } from "./PromptOverlay";
import { TabButton } from "./TabButton";
import { HoverPreview, Tooltip } from "./Tooltip";

/** Rarities worth a second look before they're sold for coin. */
const CONFIRM_SELL_RARITIES: ReadonlySet<Rarity> = new Set([
  "rare",
  "legendary",
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

/** The Misc category (see `ItemCategory` in @herzies/shared) has no catalog
 * items yet and no tab of its own — this view's second tab shows the
 * equipped deck instead. */
type InventoryTab = "cards" | "deck";

const GRID_COLS = 6;
/** Rows visible at once. Capacity starts at BANK_SLOT_COUNT (3 rows of 6) and
 * grows by whole rows per Inventory Expansion, so the grid scrolls once it has
 * more than this — see the row sizing below. */
const VISIBLE_ROWS = 3;
/** Row height to fall back on until the viewport has been measured (it is 0
 * while this tab is hidden). */
const FALLBACK_ROW_PX = 40;
/** How close to the viewport's top/bottom edge a drag starts scrolling it. */
const AUTOSCROLL_EDGE_PX = 28;
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
    const slot = freed.shift() ?? next.indexOf(null);
    // No room left — over-capacity tiles simply don't show (the player is
    // warned separately — see isBankFull — before this can normally happen).
    if (slot === -1) break;
    next[slot] = key;
    placed.add(key);
  }
  return next;
}

/** Rank per item type for the quick sort, taken from the Deck tab's own
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

function typeRank(itemId: string): number {
  const def = getItem(itemId);
  const rank = def ? TYPE_RANK.get(getItemType(def)) : undefined;
  return rank ?? TYPE_RANK.size;
}

/** Re-lays every tile out from the first slot, grouped by item type — the
 * quick sort. Built from the current tiles rather than by permuting the
 * arrangement, so it also heals any drift (gaps left by sells, say) in one go.
 *
 * `tiles` already arrives rarity-then-name sorted (see InventoryView's
 * `compareTiles`) and `sort` is stable, so ranking by type alone yields type →
 * rarity → name without a second comparator. Anything past `slotCount` drops
 * off the grid, the same way `reconcileSlotOrder` drops it. */
function sortSlotsByType(
  tiles: BankTile[],
  slotCount: number,
): (string | null)[] {
  const sorted = [...tiles].sort(
    (a, b) => typeRank(a.itemId) - typeRank(b.itemId),
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

/** One grid cell: just the item's icon (coloured by its own art, not its
 * category — see getItemColor), a "+N" badge when the copy is upgraded and a
 * stack-count badge on a stack. No equipped ring — the bank only ever shows
 * unworn copies (wearing one takes it off the grid — see `bankTiles`), so
 * there's never a specific card here to mark as equipped; that's the Deck tab's
 * job. Hovering shows the full item preview (art, rarity, description, set
 * progress — no equip/sell actions); clicking places the copy directly;
 * right-clicking a sellable item opens a Sell menu. Press-and-drag onto any
 * other slot (empty or filled — filled swaps the two items).
 *
 * `border-r`/`border-b` only draw on non-edge cells (see `isLastCol`/
 * `isLastRow`) — the grid should show inner divider lines only, not an
 * outer frame around the whole thing. */
function ItemGridCell({
  index,
  itemId,
  qty,
  level,
  isLastCol,
  isLastRow,
  isDragging,
  isDragOver,
  equipped,
  onPlace,
  onSellRequest,
  onDragPointerDown,
}: {
  index: number;
  itemId: string;
  /** Copies behind the tile: more than one only for a stack. */
  qty: number;
  /** This copy's dice-upgrade level (0 for a stack) — see ItemPreviewCard. */
  level: number;
  isLastCol: boolean;
  isLastRow: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  equipped: Equipped;
  /** The tile is the exact copy that was clicked — there is no "which of the
   * identical cards" to work out — so no slot index has to be threaded through. */
  onPlace: () => void;
  onSellRequest: (x: number, y: number) => void;
  onDragPointerDown: (index: number, e: React.PointerEvent) => void;
}) {
  const def = getItem(itemId);

  return (
    <HoverPreview
      content={
        <ItemPreviewCard
          itemId={itemId}
          meta={def?.stackable ? `x${qty}` : undefined}
          box={100}
          equipped={equipped}
          level={level}
        />
      }
    >
      <button
        type="button"
        data-slot-index={index}
        onPointerDown={(e) => onDragPointerDown(index, e)}
        onClick={onPlace}
        onContextMenu={(e) => {
          e.preventDefault();
          if (def?.sellPrice) onSellRequest(e.clientX, e.clientY);
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
        {def && <ItemTypeIcon item={def} className="h-4 w-4" />}
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

const RARITY_ORDER: Record<string, number> = {
  legendary: 0,
  rare: 1,
  uncommon: 2,
  common: 3,
};

/** Rarity, then name, then — so an upgraded copy leads its plainer twins —
 * highest level first. The order fresh tiles are placed in and the order the
 * quick sort starts from. */
function compareTiles(a: BankTile, b: BankTile): number {
  const ra = RARITY_ORDER[getItem(a.itemId)?.rarity ?? "common"] ?? 3;
  const rb = RARITY_ORDER[getItem(b.itemId)?.rarity ?? "common"] ?? 3;
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
  /** Sell popover/menu, anchored where the right-click was. They name the TILE
   * (which is what says exactly which copies), not an item id. */
  const [sellBox, setSellBox] = useState<{
    tileKey: string;
    x: number;
    y: number;
  } | null>(null);
  const [sellMenu, setSellMenu] = useState<{
    tileKey: string;
    x: number;
    y: number;
  } | null>(null);
  /** Open when the Sell duplicates button is awaiting confirmation. The
   * batch it will sell is recomputed at confirm time from `duplicates`. */
  const [sellDupesConfirm, setSellDupesConfirm] = useState(false);
  /** The empty deck slot whose picker is open (see DeckSlotPicker). */
  const [slotPicker, setSlotPicker] = useState<EmptySlotTarget | null>(null);
  const [tab, setTab] = useState<InventoryTab>("cards");
  const [slotOrder, setSlotOrder] = useState<(string | null)[]>(() =>
    loadSlotOrder(herzie.friendCode, capacity),
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

  /** The grid's scroll viewport, measured so each row is exactly a third of it:
   * three rows fill the panel at any capacity and the rest scrolls. */
  const gridViewportRef = useRef<HTMLDivElement | null>(null);
  const [gridViewport, setGridViewport] = useState<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState(0);
  // A callback ref, not useRef + a mount effect: the viewport only exists on
  // the Cards tab once the inventory has loaded, so it appears late (first
  // load) and is replaced on every Deck -> Cards switch. Keying the observer on
  // the element itself re-attaches it to whichever one is current.
  const attachGridViewport = useCallback((el: HTMLDivElement | null) => {
    gridViewportRef.current = el;
    setGridViewport(el);
  }, []);
  useEffect(() => {
    if (!gridViewport) return;
    const measure = () =>
      setRowHeight(gridViewport.clientHeight / VISIBLE_ROWS);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(gridViewport);
    return () => observer.disconnect();
  }, [gridViewport]);
  // { index, itemId } once a drag has actually started (past DRAG_THRESHOLD)
  // — null while just holding the button down without having moved yet.
  const [dragVisual, setDragVisual] = useState<{
    index: number;
    itemId: string;
    overIndex: number | null;
    x: number;
    y: number;
  } | null>(null);
  // Mutable, not reactive — the pointermove/pointerup listeners below read
  // and mutate this directly rather than through React state, since they're
  // plain DOM listeners (not React event handlers) and fire far more often
  // than a render is needed for.
  const dragRef = useRef<{
    index: number;
    itemId: string;
    startX: number;
    startY: number;
    dragging: boolean;
    overIndex: number | null;
    /** Latest cursor Y, for the edge auto-scroll loop. */
    pointerY: number;
    lastX: number;
  } | null>(null);
  // Set right before a real drag's pointerup so the click that (in a
  // browser) follows it gets ignored instead of also placing the item. Set
  // only for a drag that changed slots, and cleared when the next gesture
  // starts — see handlePointerUp/handlePointerDown for why both matter.
  const suppressClickRef = useRef(false);

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
    if (initialItem) setInspectItem(initialItem);
  }, [initialItem]);

  // Custom press-and-drag instead of the native HTML5 Drag and Drop API —
  // Tauri's webview doesn't reliably fire dragstart/dragover/drop for
  // same-page drags, so this uses plain pointer events + `elementFromPoint`
  // hit-testing instead. Listens on the window (not the individual cells)
  // so the drag keeps tracking even once the cursor leaves the origin cell.
  useEffect(() => {
    const DRAG_THRESHOLD = 4;

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
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const slotEl = (el as HTMLElement | null)?.closest<HTMLElement>(
        `[${SLOT_INDEX_ATTR}]`,
      );
      const overIndex = slotEl
        ? Number(slotEl.getAttribute(SLOT_INDEX_ATTR))
        : null;
      state.overIndex = overIndex;
      setDragVisual({
        index: state.index,
        itemId: state.itemId,
        overIndex,
        x: e.clientX,
        y: e.clientY,
      });
    };

    // Scrolls the grid while a drag is held near its top or bottom edge, so a
    // card can be dropped on a row that is currently off-screen. Runs on a frame
    // loop rather than off pointermove: a cursor parked at the edge stops
    // firing pointermove but should keep scrolling.
    let frame = 0;
    const autoScroll = () => {
      const state = dragRef.current;
      // Ends with the drag, so nothing runs per-frame while idle (this view
      // stays mounted while another tab is showing).
      if (!state?.dragging) {
        frame = 0;
        return;
      }
      frame = requestAnimationFrame(autoScroll);
      const viewport = gridViewportRef.current;
      // The scroller is List's own element, the viewport's only child.
      const scroller = viewport?.firstElementChild;
      if (!viewport || !(scroller instanceof HTMLElement)) return;
      const rect = viewport.getBoundingClientRect();
      if (state.pointerY < rect.top + AUTOSCROLL_EDGE_PX) {
        scroller.scrollTop -= AUTOSCROLL_STEP_PX;
      } else if (state.pointerY > rect.bottom - AUTOSCROLL_EDGE_PX) {
        scroller.scrollTop += AUTOSCROLL_STEP_PX;
      } else {
        return;
      }
      // The cursor hasn't moved but the cell under it has: re-hit-test so the
      // drop target follows the scroll.
      const el = document.elementFromPoint(state.lastX, state.pointerY);
      const slotEl = (el as HTMLElement | null)?.closest<HTMLElement>(
        `[${SLOT_INDEX_ATTR}]`,
      );
      const overIndex = slotEl
        ? Number(slotEl.getAttribute(SLOT_INDEX_ATTR))
        : null;
      if (overIndex !== state.overIndex) {
        state.overIndex = overIndex;
        setDragVisual((prev) => (prev ? { ...prev, overIndex } : prev));
      }
    };

    const handlePointerUp = () => {
      const state = dragRef.current;
      dragRef.current = null;
      setDragVisual(null);
      if (!state?.dragging) return;
      // Only a drag that actually moved the item to a *different* slot is a
      // drop whose trailing click needs suppressing. Releasing on the slot you
      // pressed is a click by every platform convention — and since
      // DRAG_THRESHOLD is only 4px, a normal click with the faintest mouse or
      // trackpad drift lands here, so suppressing it swallowed the equip and
      // made items need clicking twice.
      const { index, overIndex } = state;
      if (overIndex === null || overIndex === index) return;
      suppressClickRef.current = true;
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
    dragRef.current = {
      index,
      itemId: tile.itemId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      overIndex: null,
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

  /** Applies a dice item to ONE named card, mirroring handleSell's predict-
   * then-confirm shape: applyItemUpgrade is the same pure function the RPC
   * enforces server-side, so the "+N" badge and the consumed dice both
   * appear on click instead of after the round trip. Its twin — another copy
   * of the same card — is untouched. */
  const handleApplyDiceUpgrade = async (
    diceItemId: string,
    targetUnitId: string,
  ) => {
    const target = units.find((u) => u.id === targetUnitId);
    const targetName = getItem(target?.itemId ?? "")?.name ?? "that card";
    const predicted = applyItemUpgrade(units, diceItemId, targetUnitId);
    if (!predicted.ok) {
      const messages: Record<ItemUpgradeRejection, string> = {
        "not-dice": "Not a dice item",
        "dice-not-owned": "You don't have that dice",
        "target-not-owned": "You don't own that card",
        "not-statted": `"${targetName}" has no stats to upgrade`,
        "max-level": `"${targetName}" is already fully upgraded`,
      };
      onLog?.(messages[predicted.reason]);
      return;
    }

    setDiceUpgradeItem(null);
    const request = herzies.applyDiceUpgrade(diceItemId, targetUnitId);
    onPredictUnits((base) => {
      const outcome = applyItemUpgrade(base, diceItemId, targetUnitId);
      return outcome.ok ? outcome.units : [...base];
    }, request);

    try {
      const result = await request;
      if (result) {
        onLog?.(`Upgraded "${targetName}" to +${result.newLevel}`);
      } else {
        onLog?.(`Failed to apply "${getItem(diceItemId)?.name ?? diceItemId}"`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`Failed to apply dice: ${msg}`);
    }
  };

  /** Wears or removes one specific copy. There is no slot bookkeeping here any
   * more: a copy is its own tile, so when it leaves the grid the tile's slot
   * empties on its own, and anything it displaces lands in that freed slot (see
   * reconcileSlotOrder) — which is what used to need the clicked slot cleared
   * by hand before the equip was sent, and restored by hand if it failed. */
  const handleEquip = async (unitId: string, side?: GroundSide) => {
    const unit = units.find((u) => u.id === unitId);
    const name = getItem(unit?.itemId ?? "")?.name ?? "item";
    const result = await onToggleEquip(unitId, side);
    if (result.ok) {
      onLog?.(
        result.action === "equip" ? `Placed "${name}"` : `Returned "${name}"`,
      );
    } else {
      const verb = result.action === "equip" ? "place" : "return";
      onLog?.(`Failed to ${verb} "${name}": ${result.error}`);
    }
  };

  // Grid click places a copy directly — a no-op for non-equipable items
  // (e.g. plain collectible cards) rather than a doomed equip attempt. Also a
  // no-op right after a drag that moved the item to another slot, so dropping
  // it doesn't also place it (see suppressClickRef).
  //
  // Never a *return*, unlike the Deck tab and the inspect overlay: every tile on
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
    setSlotOrder((prev) =>
      reconcileSlotOrder(prev, tileKeysJoined ? tileKeysJoined.split(",") : []),
    );
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

  // The overlay opens on an item id (a deep link from a notification), so it
  // shows the copy that id most plausibly means: the one worn, else the best.
  const inspected = inspectItem ? getItem(inspectItem) : null;
  const inspectUnit = inspectItem ? bestUnitOf(units, inspectItem) : undefined;
  const inspectedQty = inspectItem
    ? units.filter((u) => u.itemId === inspectItem).length
    : 0;
  const inspectedEquipped = inspectUnit?.equippedSlot != null;
  const inspectedModifierCapped =
    !inspectedEquipped &&
    inspected?.equipSlot === "modifier" &&
    (equipped.modifier?.length ?? 0) >= MAX_MODIFIERS;
  const inspectedGroundSide =
    inspected?.equipSlot === "ground"
      ? inspectUnit?.equippedSlot === "ground_left"
        ? "L"
        : inspectUnit?.equippedSlot === "ground_right"
          ? "R"
          : null
      : null;
  // Quantity is only meaningful for stackable items — each non-stackable
  // card in the grid already represents exactly one copy, so showing "x2"
  // while inspecting one of them would be misleading.
  const inspectedMeta = [
    inspected?.stackable ? `x${inspectedQty}` : null,
    inspectedGroundSide,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <div className="flex h-full flex-col">
      <div className="z-50 mb-1 flex items-center justify-between">
        <h1 className="text-ui-lg font-bold text-cyan">Inventory</h1>
        <Tooltip label={`${formatAmount(currency)} herzie coins`}>
          <div className="text-ui text-cyan">
            <Coin amount={currency} animate />
          </div>
        </Tooltip>
      </div>

      {/* 3D render */}
      <div className="min-h-0 flex-1">
        <div className="flex h-full items-center justify-center">
          <Herzie3D
            userId={herzie.friendCode}
            stage={herzie.stage}
            equipped={equipped}
            paused={!active}
          />
        </div>
      </div>

      {/* Item list — bottom ~48% */}
      <div className="z-10 flex h-[44%] min-h-0 shrink-0 flex-col">
        <div className="flex gap-1 border-b border-border">
          <TabButton
            active={tab === "cards"}
            onClick={() => setTab("cards")}
            colour="cyan"
          >
            Inventory
          </TabButton>
          <TabButton
            active={tab === "deck"}
            onClick={() => setTab("deck")}
            colour="cyan"
          >
            Deck
          </TabButton>
          {/* Cards only — the Deck tab has fixed slots, so there's neither an
              arrangement of its own to sort nor a bank to clear. Both live in
              one wrapper so they read as a pair: it carries the `ml-auto` that
              pushes them right, and it keeps the row's `gap-1` from opening a
              third gap between two buttons that already pad themselves. */}
          {tab === "cards" && (
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
                  // Same tight padding as the sort button beside it, so neither
                  // icon grows the tab row.
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
                  // Tighter vertical padding than TabButton's, so the taller
                  // icon doesn't grow the tab row: the flex row's default
                  // stretch sizes this button to the tabs anyway, and
                  // items-center then centres the icon against their text.
                  className="flex cursor-pointer items-center border-none bg-transparent px-1.5 py-0.5 text-text-dim hover:text-cyan"
                >
                  {/* 14px rather than the item pips' 16px: these are chrome
                    beside the tab labels, not content, and read better a
                    little smaller. A 16x16 PixelIcon only lands on whole
                    device pixels at 16px (or a multiple), so both glyphs are
                    drawn at 2px stroke weight to survive the fractional
                    scale — a 1px feature here would go visibly soft. */}
                  <SortIcon className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </div>
          )}
        </div>

        {tab === "deck" ? (
          <List className="min-h-0 flex-1">
            <DeckRow
              equipped={equipped}
              units={units}
              onUnequip={(unitId) => handleEquip(unitId)}
              onPlaceRequest={setSlotPicker}
            />
          </List>
        ) : loading ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            Loading...
          </div>
        ) : (
          // Three rows fill the panel; past that (each Inventory Expansion adds
          // two rows) it scrolls, with List's edge fades as the only hint —
          // scrollbars are hidden app-wide.
          <div ref={attachGridViewport} className="min-h-0 flex-1">
            <List className="h-full">
              <div
                className="grid grid-cols-6"
                style={{
                  gridAutoRows: `${rowHeight > 0 ? rowHeight : FALLBACK_ROW_PX}px`,
                }}
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
                      qty={tile.unitIds.length}
                      level={tile.upgradeLevel}
                      isLastCol={isLastCol}
                      isLastRow={isLastRow}
                      isDragging={dragVisual?.index === i}
                      isDragOver={dragVisual?.overIndex === i}
                      equipped={equipped}
                      onPlace={() => handleGridClick(tile)}
                      onSellRequest={(x, y) =>
                        setSellMenu({ tileKey: tile.key, x, y })
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
          meta={inspectedMeta || undefined}
          footer={
            <>
              {inspected.equipable &&
                (() => {
                  const button = (
                    <button
                      type="button"
                      className="btn"
                      disabled={inspectedModifierCapped || !inspectUnit}
                      onClick={() => inspectUnit && handleEquip(inspectUnit.id)}
                    >
                      {inspectedEquipped ? "Return" : "Place"}
                    </button>
                  );
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
              {inspected.sellPrice && inspectedQty > 0 ? (
                <SellControls
                  qty={inspectedQty}
                  price={inspected.sellPrice}
                  stackable={inspected.stackable ?? false}
                  onSell={(qty) => {
                    // The overlay only knows an item id, so which copies goes
                    // by the plainest-first rule: a spare, never the one worn.
                    const ids = pickPlainestUnitIds(units, inspectItem, qty);
                    if (ids) requestSell(inspectItem, ids);
                  }}
                />
              ) : null}
            </>
          }
        />
      )}

      {diceUpgradeItem && (
        <DiceUpgradeOverlay
          diceItemId={diceUpgradeItem}
          units={units}
          onPick={(targetUnitId) =>
            handleApplyDiceUpgrade(diceUpgradeItem, targetUnitId)
          }
          onClose={() => setDiceUpgradeItem(null)}
        />
      )}

      {sellMenu &&
        (() => {
          const tile = tileByKey.get(sellMenu.tileKey);
          if (!tile) return null;
          const qty = tile.unitIds.length;
          const canSellAll =
            (getItem(tile.itemId)?.stackable ?? false) && qty > 1;
          return (
            <ContextMenu
              x={sellMenu.x}
              y={sellMenu.y}
              onClose={() => setSellMenu(null)}
              items={[
                {
                  label: "Sell",
                  onClick: () => {
                    setSellBox(sellMenu);
                    setSellMenu(null);
                  },
                },
                // Skips the quantity popover and sells the whole stack.
                ...(canSellAll
                  ? [
                      {
                        label: "Sell all",
                        onClick: () => {
                          requestSell(tile.itemId, tile.unitIds);
                          setSellMenu(null);
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
          const draggedDef = getItem(dragVisual.itemId);
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
