import type {
  Equipped,
  GroundSide,
  Herzie,
  Inventory,
  ItemType,
  ItemUpgradeRejection,
  Rarity,
} from "@herzies/shared";
import {
  applyItemUpgrade,
  applySell,
  BANK_SLOT_COUNT,
  DECK_SLOT_GROUPS,
  findEquippedSlot,
  getItem,
  getItemCategory,
  getItemType,
  groundSlot,
  isModifierEquipped,
  MAX_MODIFIERS,
  RARITY_COLORS,
  RARITY_LABELS,
} from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ToggleEquipResult } from "../hooks/useOptimisticEquipped";
import { cn, formatAmount } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { Coin } from "./Coin";
import { ContextMenu } from "./ContextMenu";
import { DeckRow, type EmptySlotTarget } from "./DeckRow";
import { DeckSlotPicker } from "./DeckSlotPicker";
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
 * are owned — each grid slot already represents exactly one physical unit
 * (see InventoryView's ownedBankUnits), so "sell 2 equipables at once" isn't
 * a meaningful action even when you own 2. Only stackable items (artefacts)
 * get the quantity ticker. */
function SellControls({
  itemId,
  qty,
  price,
  stackable,
  onSell,
  stacked = false,
}: {
  itemId: string;
  qty: number;
  price: number;
  stackable: boolean;
  onSell: (itemId: string, qty: number) => void;
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
        onClick={() => onSell(itemId, clamped)}
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
  onSell: (itemId: string, qty: number) => void;
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
        itemId={itemId}
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
const GRID_ROWS = 3;
/** Fixed inventory capacity — 18 slots (6×3) for now, always shown whether
 * filled or empty. A freshly-seen item fills the first empty slot (in
 * current sort order); from there the player can drag items to any slot,
 * including swapping two filled ones. Sourced from @herzies/shared so
 * non-UI code (deciding whether to warn before a purchase or pickup) agrees
 * with this grid's actual capacity. */
const TOTAL_SLOTS = BANK_SLOT_COUNT;

const slotStorageKey = (friendCode: string) =>
  `herzies:inventory-slots:${friendCode}`;

/** Loads the saved slot arrangement, padded/truncated to `TOTAL_SLOTS` and
 * with anything that isn't a string coerced to an empty slot. */
function loadSlotOrder(friendCode: string): (string | null)[] {
  try {
    const raw = localStorage.getItem(slotStorageKey(friendCode));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return Array(TOTAL_SLOTS).fill(null);
    return Array.from({ length: TOTAL_SLOTS }, (_, i) =>
      typeof parsed[i] === "string" ? parsed[i] : null,
    );
  } catch {
    return Array(TOTAL_SLOTS).fill(null);
  }
}

/** Reconciles the saved slot arrangement against what's actually owned.
 * `ownedIds` is a multiset (plain item ids, one entry per bank unit — see
 * `ownedBankUnits`) in the order fresh items should be placed (rarity, then
 * name); a non-stackable item with N copies simply appears N times.
 *
 * Slots are matched by count, not by a synthetic per-unit identity: a first
 * pass walks `prev` in slot order and keeps a slot's occupant as long as
 * there's still an un-spoken-for owned unit of that id left, decrementing a
 * running per-id budget as it goes — so if a copy was sold from one specific
 * slot (see `handleSell`'s targeted clear), that slot stays empty and every
 * *other* slot holding the same id is left untouched, instead of an
 * arbitrary same-id slot losing its card. Only once every existing slot has
 * had first claim does a second pass place any genuinely new units (more
 * owned than currently placed) into the remaining empty slots. */
function reconcileSlotOrder(
  prev: (string | null)[],
  ownedIds: string[],
): (string | null)[] {
  const remaining = new Map<string, number>();
  for (const id of ownedIds) remaining.set(id, (remaining.get(id) ?? 0) + 1);

  const next = prev.map((id) => {
    if (id === null) return null;
    const left = remaining.get(id) ?? 0;
    if (left <= 0) return null;
    remaining.set(id, left - 1);
    return id;
  });

  for (const id of ownedIds) {
    const left = remaining.get(id) ?? 0;
    if (left <= 0) continue;
    remaining.set(id, left - 1);
    const emptyIndex = next.indexOf(null);
    // No room left — over-capacity items simply don't show (the player is
    // warned separately — see isBankFull — before this can normally happen).
    if (emptyIndex === -1) break;
    next[emptyIndex] = id;
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

/** Re-lays every owned bank unit out from the first slot, grouped by item
 * type — the quick sort. Built from `ownedBankUnits` rather than by
 * permuting the current arrangement, so it also heals any drift (gaps left
 * by sells, say) in one go.
 *
 * `ownedIds` already arrives rarity-then-name sorted (see InventoryView's
 * `items`) and `sort` is stable, so ranking by type alone yields type →
 * rarity → name without a second comparator. Anything past `TOTAL_SLOTS`
 * drops off the grid, the same way `reconcileSlotOrder` drops it. */
function sortSlotsByType(ownedIds: string[]): (string | null)[] {
  const sorted = [...ownedIds].sort((a, b) => typeRank(a) - typeRank(b));
  return Array.from({ length: TOTAL_SLOTS }, (_, i) => sorted[i] ?? null);
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
 * category — see getItemColor) and a stack-count badge. No equipped ring —
 * equip state is per item id, not per physical copy, and the bank only ever
 * shows unequipped units to begin with (equipping reserves one unit as
 * "worn" and removes it from the bank — see ownedBankUnits), so there's
 * never a specific card here to correctly mark as equipped; that's the
 * Deck tab's job. Hovering shows the full item preview (art, rarity,
 * description, set progress — no equip/sell actions); clicking places (or
 * returns) the item directly; right-clicking a sellable item opens a Sell
 * menu. Press-and-drag onto any other slot (empty or filled — filled swaps
 * the two items).
 *
 * `border-r`/`border-b` only draw on non-edge cells (see `isLastCol`/
 * `isLastRow`) — the grid should show inner divider lines only, not an
 * outer frame around the whole thing. */
function ItemGridCell({
  index,
  itemId,
  qty,
  isLastCol,
  isLastRow,
  isDragging,
  isDragOver,
  equipped,
  level,
  onPlace,
  onSellRequest,
  onDragPointerDown,
}: {
  index: number;
  itemId: string;
  qty: number;
  isLastCol: boolean;
  isLastRow: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  equipped: Equipped;
  /** Current dice-upgrade level — see ItemPreviewCard. */
  level: number;
  /** Takes this cell's own slot index, not just the item id: with several
   * identical cards on the grid it's the only thing that says *which* copy
   * was clicked — see handleEquip. */
  onPlace: (itemId: string, slotIndex: number) => void;
  onSellRequest: (
    itemId: string,
    slotIndex: number,
    x: number,
    y: number,
  ) => void;
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
        onClick={() => onPlace(itemId, index)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (def?.sellPrice)
            onSellRequest(itemId, index, e.clientX, e.clientY);
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

export function InventoryView({
  herzie,
  initialItem,
  onLog,
  inventory: cachedInventory,
  currency: cachedCurrency,
  itemUpgrades: cachedItemUpgrades,
  equipped,
  onToggleEquip,
  onPredictUnequip,
  active = true,
}: {
  herzie: Herzie;
  initialItem?: string | null;
  onLog?: (msg: string) => void;
  inventory: Inventory | null;
  currency: number;
  /** Dice-upgrade levels (itemId -> 0-3) — see MAX_ITEM_UPGRADE_LEVEL. */
  itemUpgrades: Record<string, number>;
  /** Already optimistic — see useOptimisticEquipped in main.tsx. Held there
   * rather than here so the 3D herzie and deck row move in the same frame as
   * the grid; keeping a local copy in sync with it only ever reintroduced the
   * flicker the optimistic layer exists to remove. */
  equipped: Equipped;
  onToggleEquip: (
    itemId: string,
    side?: GroundSide,
  ) => Promise<ToggleEquipResult>;
  /** Register the unequip a sell performs server-side when the last copy goes. */
  onPredictUnequip?: (itemId: string, settled: Promise<unknown>) => void;
  /** False while another tab is shown — pauses the 3D render. */
  active?: boolean;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(cachedInventory);
  const [currency, setCurrency] = useState(cachedCurrency || herzie.currency);
  const [itemUpgrades, setItemUpgrades] = useState<Record<string, number>>(
    cachedItemUpgrades ?? {},
  );
  /** Unsettled sells. While non-zero, incoming snapshots are behind us. */
  const [sellsInFlight, setSellsInFlight] = useState(0);
  /** Unsettled dice upgrades — same reasoning as sellsInFlight. */
  const [upgradesInFlight, setUpgradesInFlight] = useState(0);
  // handleSell is recreated every render and handed to SellBox/SellControls,
  // which can be holding a render-old copy. Reading the latest values through
  // refs (the friendsRef pattern used in FriendsView) is what lets a second
  // sell compose on the first one's prediction instead of discarding it.
  const inventoryRef = useRef(inventory);
  inventoryRef.current = inventory;
  const currencyRef = useRef(currency);
  currencyRef.current = currency;
  const itemUpgradesRef = useRef(itemUpgrades);
  itemUpgradesRef.current = itemUpgrades;
  /** The dice whose upgrade-target picker is open, if any. */
  const [diceUpgradeItem, setDiceUpgradeItem] = useState<string | null>(null);
  const [inspectItem, setInspectItem] = useState<string | null>(
    initialItem ?? null,
  );
  const [sellBox, setSellBox] = useState<{
    itemId: string;
    /** The specific slot this sell was requested from — see handleSell. */
    slotIndex: number;
    x: number;
    y: number;
  } | null>(null);
  const [sellMenu, setSellMenu] = useState<{
    itemId: string;
    slotIndex: number;
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
    loadSlotOrder(herzie.friendCode),
  );
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
  } | null>(null);
  // Set right before a real drag's pointerup so the click that (in a
  // browser) follows it gets ignored instead of also placing the item. Set
  // only for a drag that changed slots, and cleared when the next gesture
  // starts — see handlePointerUp/handlePointerDown for why both matter.
  const suppressClickRef = useRef(false);

  // Adopt the shared AppState snapshot — except while a sell is in flight, when
  // it is known to be behind our prediction and would revert the grid and coin
  // mid-request. `sell_item` emits the updated state before its command
  // returns, so by the time the counter falls the snapshot already matches.
  useEffect(() => {
    if (sellsInFlight > 0 || upgradesInFlight > 0) return;
    setInventory(cachedInventory);
    setCurrency(cachedCurrency || herzie.currency);
    setItemUpgrades(cachedItemUpgrades ?? {});
  }, [
    cachedInventory,
    cachedCurrency,
    cachedItemUpgrades,
    herzie.currency,
    sellsInFlight,
    upgradesInFlight,
  ]);

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
      }
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
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  const handleDragPointerDown = (index: number, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const itemId = slotOrder[index];
    if (!itemId) return;
    dragRef.current = {
      index,
      itemId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      overIndex: null,
    };
  };

  // No fetch on mount: this view stays mounted when hidden, so it fired at
  // launch whether or not the player opened it — duplicating refresh_app_cache,
  // which already fills the cache at startup. /sync now carries the
  // authoritative inventory and currency every few seconds, so both the initial
  // fill and any later drift are covered without a dedicated request.

  /** `slotIndex`, when given, is the exact grid slot the sell was requested
   * from (see the grid's onSellRequest). For a non-stackable item — sold one
   * unit at a time (see SellControls) — clearing that specific slot on
   * success is what makes the card that visually disappears match the one
   * the player actually right-clicked: reconcileSlotOrder's count-based
   * matching only knows "one fewer of this item id is owned now", and with
   * several identical cards on the grid it has no way on its own to tell
   * *which* of them the player meant. Skipped for stackable items, which
   * share a single badge-counted slot regardless of quantity — clearing it
   * on a partial sell would wipe a stack that's still owned. */
  /** A rare-or-better sell waiting on the "are you sure?" prompt. */
  const [sellConfirm, setSellConfirm] = useState<{
    itemId: string;
    qty: number;
    slotIndex?: number;
  } | null>(null);

  /** Every sell entry point goes through here: rare and legendary items ask
   * first, anything else sells straight away. */
  const requestSell = (itemId: string, qty: number, slotIndex?: number) => {
    const rarity = getItem(itemId)?.rarity;
    if (rarity && CONFIRM_SELL_RARITIES.has(rarity)) {
      setSellConfirm({ itemId, qty, slotIndex });
      return;
    }
    handleSell(itemId, qty, slotIndex);
  };

  const handleSell = async (
    itemId: string,
    qty: number,
    slotIndex?: number,
  ) => {
    const item = getItem(itemId);
    const name = item?.name ?? itemId;

    // Predict with the same function the server applies, so the card leaves the
    // grid and the coin ticks up on click rather than a round trip later, and
    // the response lands as a no-op instead of a visible correction.
    const predicted = applySell(
      inventoryRef.current ?? {},
      currencyRef.current,
      equipped,
      itemId,
      qty,
      item?.sellPrice,
      itemUpgradesRef.current,
    );
    if (!predicted.ok) {
      onLog?.(
        predicted.reason === "not-sellable"
          ? `"${name}" can't be sold`
          : `Not enough "${name}" to sell`,
      );
      return;
    }

    setInventory(predicted.inventory);
    setCurrency(predicted.newCurrency);
    setItemUpgrades(predicted.itemUpgrades);
    // Also update the refs now, not just on the next render, so two sells
    // fired within a single tick still compose.
    inventoryRef.current = predicted.inventory;
    currencyRef.current = predicted.newCurrency;
    itemUpgradesRef.current = predicted.itemUpgrades;
    // Selling the last one leaves nothing to preview — close it.
    if (predicted.inventory[itemId] === undefined && itemId === inspectItem) {
      setInspectItem(null);
    }
    if (slotIndex !== undefined && !item?.stackable) {
      setSlotOrder((prev) => {
        if (prev[slotIndex] !== itemId) return prev;
        const next = [...prev];
        next[slotIndex] = null;
        return next;
      });
    }

    const request = herzies.sellItem(itemId, qty);
    // Selling the last copy unequips server-side. Route that through the shared
    // equip overlay so it can't fight an explicit unequip prediction.
    if (predicted.unequipped) onPredictUnequip?.(itemId, request);

    setSellsInFlight((n) => n + 1);
    try {
      const result = await request;
      if (result) {
        // Authoritative, and by construction equal to the prediction.
        setInventory(result.inventory);
        setCurrency(result.newCurrency);
        setItemUpgrades(result.itemUpgrades);
        inventoryRef.current = result.inventory;
        currencyRef.current = result.newCurrency;
        itemUpgradesRef.current = result.itemUpgrades;
      } else {
        onLog?.(`Failed to sell "${name}"`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`Failed to sell "${name}": ${msg}`);
    } finally {
      // No manual rollback on failure: once the last sell settles the gate
      // below lifts and the effect adopts the server snapshot, which for a
      // failed sell is still the pre-sell state. Restoring a value captured
      // before *this* sell would instead clobber any other sell still pending.
      setSellsInFlight((n) => Math.max(0, n - 1));
    }
  };

  /** Applies a dice item to a target card, mirroring handleSell's predict-
   * then-confirm shape: applyItemUpgrade is the same pure function the RPC
   * enforces server-side, so the "+N" badge and the consumed dice both
   * appear on click instead of after the round trip. */
  const handleApplyDiceUpgrade = async (
    diceItemId: string,
    targetItemId: string,
  ) => {
    const targetName = getItem(targetItemId)?.name ?? targetItemId;
    const predicted = applyItemUpgrade(
      inventoryRef.current ?? {},
      itemUpgradesRef.current,
      diceItemId,
      targetItemId,
    );
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

    setInventory(predicted.inventory);
    setItemUpgrades(predicted.itemUpgrades);
    inventoryRef.current = predicted.inventory;
    itemUpgradesRef.current = predicted.itemUpgrades;
    setDiceUpgradeItem(null);

    setUpgradesInFlight((n) => n + 1);
    try {
      const result = await herzies.applyDiceUpgrade(diceItemId, targetItemId);
      if (result) {
        setInventory(result.inventory);
        setItemUpgrades(result.itemUpgrades);
        inventoryRef.current = result.inventory;
        itemUpgradesRef.current = result.itemUpgrades;
        onLog?.(`Upgraded "${targetName}" to +${result.newLevel}`);
      } else {
        onLog?.(`Failed to apply "${getItem(diceItemId)?.name ?? diceItemId}"`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`Failed to apply dice: ${msg}`);
    } finally {
      setUpgradesInFlight((n) => Math.max(0, n - 1));
    }
  };

  const isItemEquipped = (itemId: string) =>
    findEquippedSlot(equipped, itemId) !== null ||
    isModifierEquipped(equipped, itemId);

  /** `fromSlot`, when given, is the exact grid slot the placed unit left from
   * (see handleGridClick) — the equip counterpart of handleSell's slotIndex,
   * and needed for the same reason. reconcileSlotOrder only learns that one
   * fewer unit of this id is in the bank, so with several identical cards on
   * the grid its count-based first pass keeps the earliest of them and empties
   * the *last*, whichever one the player actually clicked; whatever the equip
   * displaced then drops into that hole. Clearing the clicked slot here is
   * what makes the card that leaves the grid the one that was clicked, and
   * leaves that slot as the first empty one for the displaced item to land in.
   *
   * Done before awaiting, so it batches with the optimistic equip inside
   * onToggleEquip and the reconcile sees both at once — a clear afterwards
   * would arrive a render too late, with reconcile having already emptied
   * some other slot. */
  const handleEquip = async (
    itemId: string,
    fromSlot?: number,
    side?: GroundSide,
  ) => {
    const name = getItem(itemId)?.name ?? itemId;
    if (fromSlot !== undefined) {
      setSlotOrder((prev) => {
        if (prev[fromSlot] !== itemId) return prev;
        const next = [...prev];
        next[fromSlot] = null;
        return next;
      });
    }
    const result = await onToggleEquip(itemId, side);
    if (result.ok) {
      onLog?.(
        result.action === "equip" ? `Placed "${name}"` : `Returned "${name}"`,
      );
    } else {
      // Put the card back only for a toggle that never left the client (see
      // ToggleEquipResult.sent): nothing changed anywhere, and no ownership
      // change is coming to trigger a reconcile that would restore it. After
      // a failed *request* the overlay drop puts ownership back by itself, so
      // reconcile re-places the unit — writing the slot here too would race
      // that and could leave the displaced item with nowhere to land.
      if (fromSlot !== undefined && !result.sent) {
        setSlotOrder((prev) => {
          if (prev[fromSlot] !== null) return prev;
          const next = [...prev];
          next[fromSlot] = itemId;
          return next;
        });
      }
      const verb = result.action === "equip" ? "place" : "return";
      onLog?.(`Failed to ${verb} "${name}": ${result.error}`);
    }
  };

  // Grid click places an item directly — a no-op for non-equipable items
  // (e.g. plain collectible cards) rather than a doomed equip attempt. Also a
  // no-op right after a drag that moved the item to another slot, so dropping
  // it doesn't also place it (see suppressClickRef).
  //
  // Never a *return*, unlike the Deck tab and the inspect overlay: every unit
  // on this grid is by construction one that isn't being worn (equipping
  // reserves a unit out of the bank — see ownedBankUnits), so a click here can
  // only mean "place this copy". For a duplicate of something already placed
  // that's nothing at all, since equip state is per item id rather than per
  // physical copy — swapping the worn copy for this identical one is
  // unrepresentable, and indistinguishable from leaving it alone. Toggling
  // instead, as this used to, read the shared "is this id worn" bit and took
  // the *worn* copy off in response to a click on a different one.
  const handleGridClick = (itemId: string, slotIndex: number) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const def = getItem(itemId);
    // Dice don't equip — clicking one opens the upgrade-target picker
    // instead (see DiceUpgradeOverlay).
    if (def?.dice) {
      setDiceUpgradeItem(itemId);
      return;
    }
    if (!def?.equipable) return;
    if (isItemEquipped(itemId)) {
      onLog?.(`"${def.name}" is already placed`);
      return;
    }
    handleEquip(itemId, slotIndex);
  };

  const rarityOrder: Record<string, number> = {
    legendary: 0,
    rare: 1,
    uncommon: 2,
    common: 3,
  };
  const items = inventory
    ? Object.entries(inventory)
        .filter(([itemId, qty]) => {
          if (qty <= 0) return false;
          const def = getItem(itemId);
          return (def ? getItemCategory(def) : "deck") === "deck";
        })
        .sort((a, b) => {
          const ra = rarityOrder[getItem(a[0])?.rarity ?? "common"] ?? 3;
          const rb = rarityOrder[getItem(b[0])?.rarity ?? "common"] ?? 3;
          if (ra !== rb) return ra - rb;
          return (getItem(a[0])?.name ?? a[0]).localeCompare(
            getItem(b[0])?.name ?? b[0],
          );
        })
    : [];
  // Equipped items live only in the Deck tab, not the Cards bank. Equip
  // state is per item id, not per physical copy — there's no way to say
  // "this specific one is worn" — so both stackable and non-stackable items
  // reserve exactly one unit as equipped and still show any remaining
  // copies (owning 3, equipping 1, leaves 2 in the bank — as one stack
  // entry for a stackable item, or two separate cells for a non-stackable
  // one). Non-stackable items repeat their id once per bank unit (a
  // multiset, not a set of unique keys — see reconcileSlotOrder) instead of
  // contributing one entry for the whole stack, so N copies occupy N
  // separate grid slots.
  const ownedBankUnits = items.flatMap(([itemId, qty]) => {
    const def = getItem(itemId);
    const bankQty = isItemEquipped(itemId) ? qty - 1 : qty;
    if (def?.stackable) return bankQty > 0 ? [itemId] : [];
    return Array.from({ length: Math.max(0, bankQty) }, () => itemId);
  });
  /** Every copy beyond the first, of everything sellable in the bank — what
   * the Sell duplicates button offers.
   *
   * Keeps exactly one of each id *in total*, not one per bank slot, so an
   * item you are currently wearing counts as the copy you keep. That is also
   * what makes this safe: the remaining quantity never reaches zero, so
   * `applySell` never takes its unequip branch and nothing can be sold out
   * from under the deck.
   *
   * Built from `items` (one entry per id, already rarity-then-name sorted)
   * rather than `ownedBankUnits`, since the sale is per id with a quantity.
   * Anything with no sellPrice is skipped — `applySell` would refuse it.
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
   * you own (see ownedBankUnits), so selling its spares frees nothing — it
   * just converts them to coin, and a stack already has its own "Sell all" in
   * the right-click menu. Only non-stackable spares cost a slot each, and
   * they are the whole reason this button exists. */
  const duplicates = items
    .flatMap(([itemId, qty]) => {
      const def = getItem(itemId);
      if (!def || def.stackable || CONFIRM_SELL_RARITIES.has(def.rarity)) {
        return [];
      }
      return [{ itemId, qty: qty - 1, price: def.sellPrice ?? 0 }];
    })
    .filter((d) => d.qty > 0 && d.price > 0);
  const duplicatesTotal = duplicates.reduce(
    (sum, d) => sum + d.qty * d.price,
    0,
  );
  const duplicatesCount = duplicates.reduce((sum, d) => sum + d.qty, 0);

  /**
   * Sells the whole duplicate batch, one item id at a time.
   *
   * Sequential on purpose, and this is load-bearing rather than caution: the
   * sell route is a read-modify-write (fetch inventory_v2, applySell, update)
   * with no row lock, so two sells in flight at once both read the same
   * pre-sale inventory and the second write clobbers the first. Firing the
   * batch in parallel would silently pay out for a fraction of it. Awaiting
   * each one keeps every request reading the previous one's result.
   *
   * The extra in-flight count wraps the whole batch: each handleSell releases
   * its own, and without this the counter would touch zero between two items
   * and let the snapshot effect adopt a pre-batch `cachedInventory`, undoing
   * the optimistic state mid-run.
   */
  const sellDuplicates = async () => {
    const batch = duplicates;
    if (batch.length === 0) return;
    const count = duplicatesCount;
    const total = duplicatesTotal;
    setSellsInFlight((n) => n + 1);
    try {
      for (const d of batch) {
        await handleSell(d.itemId, d.qty);
      }
    } finally {
      setSellsInFlight((n) => Math.max(0, n - 1));
    }
    onLog?.(
      `Sold ${count} duplicate${count === 1 ? "" : "s"} for ${formatAmount(total)} coins`,
    );
  };

  const loading = inventory === null;

  /** What can go in the empty deck slot whose picker is open.
   *
   * Filtered on the item's own `equipSlot`, not on the group's broader
   * `itemType`: `applyEquip` routes by `equipSlot` and *displaces* whatever
   * the slot already holds, so offering a hat in the empty Face box would
   * silently take off the hat that's already on. That does mean the list
   * can come up empty while the player owns plenty of other Equipment —
   * which is what DeckSlotPicker's slot-name header is there to explain.
   *
   * Drawn from `items` (one entry per id, already rarity-then-name sorted)
   * rather than `ownedBankUnits` (a multiset), since equip state is per item
   * id: two copies of the same hat are one and the same move, and listing it
   * twice would just be a row that does nothing new. Anything already
   * equipped is dropped for the same reason — `applyEquip` would refuse it
   * with "already-equipped" no matter which copy was meant. */
  const slotPickerItems = slotPicker
    ? items
        .map(([itemId]) => itemId)
        .filter((itemId) => {
          const def = getItem(itemId);
          return (
            def?.equipSlot === slotPicker.equipSlot && !isItemEquipped(itemId)
          );
        })
    : [];

  // Keep the saved slot arrangement in sync with what's actually owned —
  // see reconcileSlotOrder. Keyed on the joined list (not `ownedBankUnits`,
  // a new array every render) so this only runs when ownership actually
  // changes.
  const ownedBankUnitsJoined = ownedBankUnits.join(",");
  useEffect(() => {
    setSlotOrder((prev) =>
      reconcileSlotOrder(
        prev,
        ownedBankUnitsJoined ? ownedBankUnitsJoined.split(",") : [],
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownedBankUnitsJoined]);

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

  const inspected = inspectItem ? getItem(inspectItem) : null;
  const inspectedQty = inspectItem ? (inventory?.[inspectItem] ?? 0) : 0;
  const inspectedEquipped = inspectItem ? isItemEquipped(inspectItem) : false;
  const inspectedModifierCapped =
    !inspectedEquipped &&
    inspected?.equipSlot === "modifier" &&
    (equipped.modifier?.length ?? 0) >= MAX_MODIFIERS;
  const inspectedGroundSide =
    inspectItem && inspectedEquipped && inspected?.equipSlot === "ground"
      ? findEquippedSlot(equipped, inspectItem) === groundSlot("left")
        ? "L"
        : "R"
      : null;
  // Quantity is only meaningful for stackable items — each non-stackable
  // card in the grid already represents exactly one unit, so showing "x2"
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
                    ? `Sell ${duplicatesCount} duplicate${duplicatesCount === 1 ? "" : "s"}, keeping one of each`
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
                  onClick={() => setSlotOrder(sortSlotsByType(ownedBankUnits))}
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
              inventory={inventory}
              itemUpgrades={itemUpgrades}
              onUnequip={handleEquip}
              onPlaceRequest={setSlotPicker}
            />
          </List>
        ) : loading ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            Loading...
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-6 grid-rows-3">
            {slotOrder.map((itemId, i) => {
              const isLastCol = i % GRID_COLS === GRID_COLS - 1;
              const isLastRow = i >= TOTAL_SLOTS - GRID_COLS;
              const rawQty = itemId ? (inventory?.[itemId] ?? 0) : 0;
              // A stackable item's bank quantity excludes the one unit
              // reserved as "worn" — see ownedBankUnits above.
              const qty =
                itemId && getItem(itemId)?.stackable && isItemEquipped(itemId)
                  ? Math.max(0, rawQty - 1)
                  : rawQty;
              if (!itemId || qty <= 0) {
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
                  itemId={itemId}
                  qty={qty}
                  isLastCol={isLastCol}
                  isLastRow={isLastRow}
                  isDragging={dragVisual?.index === i}
                  isDragOver={dragVisual?.overIndex === i}
                  equipped={equipped}
                  level={itemUpgrades[itemId] ?? 0}
                  onPlace={handleGridClick}
                  onSellRequest={(id, slotIndex, x, y) =>
                    setSellMenu({ itemId: id, slotIndex, x, y })
                  }
                  onDragPointerDown={handleDragPointerDown}
                />
              );
            })}
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
          level={itemUpgrades[inspectItem] ?? 0}
          meta={inspectedMeta || undefined}
          footer={
            <>
              {inspected.equipable &&
                (() => {
                  const button = (
                    <button
                      type="button"
                      className="btn"
                      disabled={inspectedModifierCapped}
                      onClick={() => handleEquip(inspectItem)}
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
                  itemId={inspectItem}
                  qty={inspectedQty}
                  price={inspected.sellPrice}
                  stackable={inspected.stackable ?? false}
                  onSell={requestSell}
                />
              ) : null}
            </>
          }
        />
      )}

      {diceUpgradeItem && (
        <DiceUpgradeOverlay
          diceItemId={diceUpgradeItem}
          inventory={inventory}
          itemUpgrades={itemUpgrades}
          onPick={(targetItemId) =>
            handleApplyDiceUpgrade(diceUpgradeItem, targetItemId)
          }
          onClose={() => setDiceUpgradeItem(null)}
        />
      )}

      {sellMenu &&
        (() => {
          const qty = inventory?.[sellMenu.itemId] ?? 0;
          const canSellAll =
            (getItem(sellMenu.itemId)?.stackable ?? false) && qty > 1;
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
                          requestSell(sellMenu.itemId, qty, sellMenu.slotIndex);
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
              <Coin amount={duplicatesTotal} />? One of each is kept, and rare
              and legendary items are never sold.
            </div>
            {/* The breakdown, since this is the one sell action where what
                goes is not the thing that was clicked. Capped so a bank full
                of odds and ends can't outgrow the dialog. Nothing valuable
                can hide behind "+N more": the batch is common and uncommon
                only (see `duplicates`), and `items` sorts rarity-first (see
                rarityOrder) so the uncommons are the rows that do show. */}
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
          itemIds={slotPickerItems}
          onPick={(itemId) => {
            // Closed before the await, as the sell menu does: the optimistic
            // equip fills the slot on the next render anyway, so leaving the
            // list up would only show a stale row for the item just placed.
            setSlotPicker(null);
            handleEquip(itemId, undefined, slotPicker.side);
          }}
          onClose={() => setSlotPicker(null)}
        />
      )}

      {sellBox &&
        (() => {
          const item = getItem(sellBox.itemId);
          const qty = inventory?.[sellBox.itemId] ?? 0;
          if (!item?.sellPrice || qty <= 0) return null;
          return (
            <SellBox
              itemId={sellBox.itemId}
              x={sellBox.x}
              y={sellBox.y}
              qty={qty}
              price={item.sellPrice}
              stackable={item.stackable ?? false}
              onSell={(id, n) => {
                requestSell(id, n, sellBox.slotIndex);
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
          const total = sellConfirm.qty * (item.sellPrice ?? 0);
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
                    handleSell(
                      sellConfirm.itemId,
                      sellConfirm.qty,
                      sellConfirm.slotIndex,
                    );
                    setSellConfirm(null);
                  },
                },
              ]}
            >
              Are you sure you want to sell{" "}
              {sellConfirm.qty > 1 ? `${sellConfirm.qty}x ` : ""}
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
