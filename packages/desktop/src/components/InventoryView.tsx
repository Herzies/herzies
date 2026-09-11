import type { Equipped, GroundSide, Herzie, Inventory } from "@herzies/shared";
import {
  BANK_SLOT_COUNT,
  findEquippedSlot,
  getItem,
  getItemCategory,
  groundSlot,
  isModifierEquipped,
  MAX_MODIFIERS,
  normalizeEquipped,
} from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn, formatAmount } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { Coin } from "./Coin";
import { ContextMenu } from "./ContextMenu";
import { DeckRow } from "./DeckRow";
import { Herzie3D } from "./Herzie3D";
import ItemInspectOverlay, { ItemPreviewCard } from "./ItemInspectOverlay";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { List } from "./List";
import { NumberTicker } from "./NumberTicker";
import { TabButton } from "./TabButton";
import { HoverPreview, Tooltip } from "./Tooltip";

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
    <div className={cn("flex gap-1", stacked ? "flex-col" : "w-full items-stretch")}>
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

function pickGroundSide(equipped: Equipped): GroundSide {
  if (!equipped.ground_left) return "left";
  if (!equipped.ground_right) return "right";
  return "left"; // both occupied → replace left
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
  inventory,
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
  inventory: Inventory | null;
  onPlace: (itemId: string) => void;
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
          inventory={inventory}
        />
      }
    >
      <button
        type="button"
        data-slot-index={index}
        onPointerDown={(e) => onDragPointerDown(index, e)}
        onClick={() => onPlace(itemId)}
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
  equipped: cachedEquipped,
  active = true,
}: {
  herzie: Herzie;
  initialItem?: string | null;
  onLog?: (msg: string) => void;
  inventory: Inventory | null;
  currency: number;
  equipped: Equipped;
  /** False while another tab is shown — pauses the 3D render. */
  active?: boolean;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(cachedInventory);
  const [currency, setCurrency] = useState(cachedCurrency || herzie.currency);
  const [equipped, setEquipped] = useState(() =>
    normalizeEquipped(cachedEquipped),
  );
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
  // browser) follows it gets ignored instead of also placing the item.
  const suppressClickRef = useRef(false);

  useEffect(() => {
    setInventory(cachedInventory);
    setCurrency(cachedCurrency || herzie.currency);
    setEquipped(normalizeEquipped(cachedEquipped));
  }, [cachedInventory, cachedCurrency, cachedEquipped, herzie.currency]);

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
      if (!state?.dragging) return;
      suppressClickRef.current = true;
      if (state.overIndex !== null && state.overIndex !== state.index) {
        setSlotOrder((prev) => {
          const next = [...prev];
          [next[state.index], next[state.overIndex!]] = [
            next[state.overIndex!],
            next[state.index],
          ];
          return next;
        });
      }
      setDragVisual(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
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

  // Stale-while-revalidate once on mount (view stays mounted when hidden).
  useEffect(() => {
    herzies.fetchInventory().then((data) => {
      if (data) {
        setInventory(data.inventory);
        setCurrency(data.currency);
        setEquipped(normalizeEquipped(data.equipped));
      }
    });
  }, []);

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
  const handleSell = async (
    itemId: string,
    qty: number,
    slotIndex?: number,
  ) => {
    const result = await herzies.sellItem(itemId, qty);
    if (result) {
      setInventory(result.inventory);
      setCurrency(result.newCurrency);
      // Selling the last one leaves nothing to preview — close it.
      if ((result.inventory[itemId] ?? 0) === 0 && itemId === inspectItem) {
        setInspectItem(null);
      }
      if (slotIndex !== undefined && !getItem(itemId)?.stackable) {
        setSlotOrder((prev) => {
          if (prev[slotIndex] !== itemId) return prev;
          const next = [...prev];
          next[slotIndex] = null;
          return next;
        });
      }
    }
  };

  const handleEquip = async (itemId: string) => {
    const alreadyEquipped =
      findEquippedSlot(equipped, itemId) !== null ||
      isModifierEquipped(equipped, itemId);
    const action = alreadyEquipped ? "unequip" : "equip";
    const item = getItem(itemId);
    const name = item?.name ?? itemId;
    let side: GroundSide | undefined;
    if (action === "equip" && item?.equipSlot === "ground") {
      side = pickGroundSide(equipped);
    }
    const actionLabel = action === "equip" ? "place" : "return";
    try {
      const result = await herzies.equipItem(itemId, action, side);
      setEquipped(normalizeEquipped(result.equipped));
      onLog?.(action === "equip" ? `Placed ${name}` : `Returned ${name}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`Failed to ${actionLabel} ${name}: ${msg}`);
    }
  };

  // Grid click places (or returns) an item directly — a no-op for
  // non-equipable items (e.g. plain collectible cards) rather than a doomed
  // equip attempt. Also a no-op right after a drag-and-drop move, so
  // dropping an item doesn't also place it (see suppressClickRef).
  const handleGridClick = (itemId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (getItem(itemId)?.equipable) handleEquip(itemId);
  };

  const isItemEquipped = (itemId: string) =>
    findEquippedSlot(equipped, itemId) !== null ||
    isModifierEquipped(equipped, itemId);

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
  // "this specific one is worn" — so a non-stackable item reserves exactly
  // one unit as equipped and still shows any remaining copies (owning 2,
  // equipping 1, leaves 1 in the bank); a stackable item, if it were ever
  // equipable too, hides its whole stack instead (nothing today is both,
  // so this is just a safety fallback). Non-stackable items repeat their id
  // once per bank unit (a multiset, not a set of unique keys — see
  // reconcileSlotOrder) instead of contributing one entry for the whole
  // stack, so N copies occupy N separate grid slots.
  const ownedBankUnits = items.flatMap(([itemId, qty]) => {
    const def = getItem(itemId);
    if (def?.stackable) return isItemEquipped(itemId) ? [] : [itemId];
    const bankQty = isItemEquipped(itemId) ? qty - 1 : qty;
    return Array.from({ length: Math.max(0, bankQty) }, () => itemId);
  });
  const loading = inventory === null;

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
            Cards
          </TabButton>
          <TabButton
            active={tab === "deck"}
            onClick={() => setTab("deck")}
            colour="cyan"
          >
            Deck
          </TabButton>
        </div>

        {tab === "deck" ? (
          <List className="min-h-0 flex-1">
            <DeckRow
              equipped={equipped}
              inventory={inventory}
              onUnequip={handleEquip}
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
              const qty = itemId ? (inventory?.[itemId] ?? 0) : 0;
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
                  inventory={inventory}
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
          onClose={() => setInspectItem(null)}
          inventory={inventory}
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
                  onSell={handleSell}
                />
              ) : null}
            </>
          }
        />
      )}

      {sellMenu && (
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
          ]}
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
                handleSell(id, n, sellBox.slotIndex);
                setSellBox(null);
              }}
              onClose={() => setSellBox(null)}
            />
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
