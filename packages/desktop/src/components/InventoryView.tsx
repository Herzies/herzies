import type { Equipped, GroundSide, Herzie, Inventory } from "@herzies/shared";
import {
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
 * (see InventoryView's slotKeyFor), so "sell 2 equipables at once" isn't a
 * meaningful action even when you own 2. Only stackable items (artefacts)
 * get the quantity ticker. */
function SellControls({
  itemId,
  qty,
  price,
  stackable,
  onSell,
}: {
  itemId: string;
  qty: number;
  price: number;
  stackable: boolean;
  onSell: (itemId: string, qty: number) => void;
}) {
  const maxQty = stackable ? qty : 1;
  const [sellAmount, setSellAmount] = useState(1);
  const clamped = Math.max(1, Math.min(sellAmount, maxQty));

  return (
    <div className="flex w-full items-stretch gap-1">
      {stackable && maxQty > 1 && (
        <NumberTicker
          value={clamped}
          min={1}
          max={maxQty}
          onChange={setSellAmount}
          fullWidth
        />
      )}
      <button
        type="button"
        className="btn flex-1"
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

  const BOX_WIDTH = 170;
  const EDGE_PADDING = 8;
  const left = Math.min(x, window.innerWidth - BOX_WIDTH - EDGE_PADDING);
  const top = Math.min(y, window.innerHeight - 80 - EDGE_PADDING);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-150 flex w-[170px] flex-col gap-2 border border-border bg-bg-panel p-2 shadow-lg"
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
 * including swapping two filled ones. */
const TOTAL_SLOTS = GRID_COLS * GRID_ROWS;

const slotStorageKey = (friendCode: string) =>
  `herzies:inventory-slots:${friendCode}`;

/** Non-stackable items (everything but artefacts — see ItemDef.stackable)
 * occupy one grid slot per unit owned instead of one shared slot with a
 * count badge, so N copies show as N separate cards. Each per-unit slot key
 * carries a synthetic instance suffix so multiple copies of the same item
 * can coexist in `slotOrder`; stackable items skip this and use the bare
 * item id as their single slot key. */
const SLOT_KEY_SEP = "::";

function slotKeyFor(itemId: string, instanceIndex: number): string {
  return `${itemId}${SLOT_KEY_SEP}${instanceIndex}`;
}

/** Recovers the real item id from a slot key — a no-op for stackable items,
 * which use the bare item id as their key (see slotKeyFor). */
function slotKeyItemId(key: string): string {
  const i = key.indexOf(SLOT_KEY_SEP);
  return i === -1 ? key : key.slice(0, i);
}

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

/** Reconciles the saved slot arrangement against what's actually owned:
 * drops a slot's key if it's no longer owned (sold, or never really
 * there — e.g. corrupted storage), then fills the first empty slot for each
 * owned key not already placed somewhere. `ownedKeys` is expected in the
 * order fresh items should be placed (rarity, then name) — see slotKeyFor
 * for how non-stackable items expand into multiple keys. */
function reconcileSlotOrder(
  prev: (string | null)[],
  ownedKeys: string[],
): (string | null)[] {
  const owned = new Set(ownedKeys);
  const next = prev.map((id) => (id && owned.has(id) ? id : null));
  const placed = new Set(next.filter((id): id is string => id !== null));
  for (const id of ownedKeys) {
    if (placed.has(id)) continue;
    const emptyIndex = next.indexOf(null);
    // No room left — over-capacity items simply don't show (not handled
    // yet; see TOTAL_SLOTS).
    if (emptyIndex === -1) break;
    next[emptyIndex] = id;
    placed.add(id);
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
 * category — see getItemColor), a stack-count badge, and an equipped ring.
 * Hovering shows the full item preview (art, rarity, description, set
 * progress — no equip/sell actions); clicking places (or returns) the item
 * directly; right-clicking a sellable item opens a Sell menu. Press-and-drag
 * onto any other slot (empty or filled — filled swaps the two items).
 *
 * `border-r`/`border-b` only draw on non-edge cells (see `isLastCol`/
 * `isLastRow`) — the grid should show inner divider lines only, not an
 * outer frame around the whole thing. */
function ItemGridCell({
  index,
  itemId,
  qty,
  isEquipped,
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
  isEquipped: boolean;
  isLastCol: boolean;
  isLastRow: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  inventory: Inventory | null;
  onPlace: (itemId: string) => void;
  onSellRequest: (itemId: string, x: number, y: number) => void;
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
          if (def?.sellPrice) onSellRequest(itemId, e.clientX, e.clientY);
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
          isEquipped && "ring-1 ring-inset ring-cyan/60",
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
    x: number;
    y: number;
  } | null>(null);
  const [sellMenu, setSellMenu] = useState<{
    itemId: string;
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
    const slotKey = slotOrder[index];
    if (!slotKey) return;
    dragRef.current = {
      index,
      itemId: slotKeyItemId(slotKey),
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

  const handleSell = async (itemId: string, qty: number) => {
    const result = await herzies.sellItem(itemId, qty);
    if (result) {
      setInventory(result.inventory);
      setCurrency(result.newCurrency);
      // Selling the last one leaves nothing to preview — close it.
      if ((result.inventory[itemId] ?? 0) === 0 && itemId === inspectItem) {
        setInspectItem(null);
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
  // Equipped items live only in the Deck tab, not the Cards bank — an item
  // disappears from here the moment it's placed, and reappears once
  // returned.
  const items = inventory
    ? Object.entries(inventory)
        .filter(([itemId, qty]) => {
          if (qty <= 0) return false;
          if (isItemEquipped(itemId)) return false;
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
  // Non-stackable items expand into one slot key per unit owned (see
  // slotKeyFor) instead of one key for the whole stack, so N copies occupy
  // N separate grid slots.
  const ownedSlotKeys = items.flatMap(([itemId, qty]) =>
    getItem(itemId)?.stackable
      ? [itemId]
      : Array.from({ length: qty }, (_, i) => slotKeyFor(itemId, i)),
  );
  const loading = inventory === null;

  // Keep the saved slot arrangement in sync with what's actually owned —
  // see reconcileSlotOrder. Keyed on the joined key list (not
  // `ownedSlotKeys`, a new array every render) so this only runs when
  // ownership actually changes.
  const ownedSlotKeysJoined = ownedSlotKeys.join(",");
  useEffect(() => {
    setSlotOrder((prev) =>
      reconcileSlotOrder(
        prev,
        ownedSlotKeysJoined ? ownedSlotKeysJoined.split(",") : [],
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownedSlotKeysJoined]);

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
            {slotOrder.map((slotKey, i) => {
              const isLastCol = i % GRID_COLS === GRID_COLS - 1;
              const isLastRow = i >= TOTAL_SLOTS - GRID_COLS;
              const itemId = slotKey ? slotKeyItemId(slotKey) : null;
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
                  isEquipped={isItemEquipped(itemId)}
                  isLastCol={isLastCol}
                  isLastRow={isLastRow}
                  isDragging={dragVisual?.index === i}
                  isDragOver={dragVisual?.overIndex === i}
                  inventory={inventory}
                  onPlace={handleGridClick}
                  onSellRequest={(id, x, y) =>
                    setSellMenu({ itemId: id, x, y })
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
                handleSell(id, n);
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
