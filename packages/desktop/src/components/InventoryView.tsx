import type { EquipSlot, Herzie, Inventory, ItemDef } from "@herzies/shared";
import {
  getItem,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  ItemDisplay,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { Herzie3D } from "./Herzie3D";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { NumberTicker } from "./NumberTicker";
import { Tooltip } from "./Tooltip";

/** Wearable areas shown as overlays on the 3D render. More slots stack per side. */
const WEARABLE_AREAS: { slot: EquipSlot; label: string; side: "left" | "right" }[] = [
  { slot: "scenery", label: "scene", side: "left" },
  { slot: "head", label: "head", side: "right" },
];

function SellControls({
  itemId,
  qty,
  price,
  onSell,
}: {
  itemId: string;
  qty: number;
  price: number;
  onSell: (itemId: string, qty: number) => void;
}) {
  const [sellAmount, setSellAmount] = useState(1);
  const clamped = Math.max(1, Math.min(sellAmount, qty));

  return (
    <div>
      <div className="mb-1 text-ui text-text-dim">Sell for ${price} each</div>
      <div className="flex items-center gap-1">
        <NumberTicker
          value={clamped}
          min={1}
          max={qty}
          onChange={setSellAmount}
        />
        <button
          type="button"
          className="btn"
          onClick={() => onSell(itemId, clamped)}
        >
          Sell (${clamped * price})
        </button>
        {qty > 1 && (
          <button
            type="button"
            className="btn"
            onClick={() => onSell(itemId, qty)}
          >
            Sell All ({qty})
          </button>
        )}
      </div>
    </div>
  );
}

/** Fixed square dimension for every wearable zone, regardless of item art. */
const SLOT_SIZE = 56;

/** Font size that fits the item's ASCII art inside the square zone. */
function slotPreviewSize(item: ItemDef): number {
  const lines = item.frames[0] ?? [];
  const rows = lines.length || 1;
  const cols = Math.max(
    1,
    ...lines.map((l) => l.replace(/<[^>]*>/g, "").length),
  );
  // ItemDisplay metrics: char width = size * 0.6, line height = size * 1.35.
  const fit = Math.min(SLOT_SIZE / (rows * 1.35), SLOT_SIZE / (cols * 0.6));
  return Math.min(7, Math.max(2, fit));
}

function WearableArea({
  label,
  item,
  animate,
  align,
  onUnequip,
}: {
  label: string;
  item: ItemDef | null;
  animate: boolean;
  align: "left" | "right";
  onUnequip: (itemId: string) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-ui-sm text-text-dim">{label}</span>
      {item ? (
        <Tooltip label={item.name} side="bottom" align={align}>
          <button
            type="button"
            onClick={() => onUnequip(item.id)}
            className="flex cursor-pointer items-center justify-center overflow-hidden rounded border border-border bg-black/40"
            style={{
              width: SLOT_SIZE,
              height: SLOT_SIZE,
              borderColor: ITEM_RARITY_COLORS[item.rarity],
            }}
          >
            {/* pointer-events-none: the animated art swaps DOM nodes every
                frame, which otherwise breaks click events mid-press. */}
            <span className="pointer-events-none">
              <ItemDisplay
                item={item}
                size={slotPreviewSize(item)}
                animate={animate}
              />
            </span>
          </button>
        </Tooltip>
      ) : (
        <div
          className="rounded border border-dashed border-border bg-black/20"
          style={{ width: SLOT_SIZE, height: SLOT_SIZE }}
        />
      )}
    </div>
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
  equipped: string[];
  /** False while another tab is shown — pauses the 3D render. */
  active?: boolean;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(cachedInventory);
  const [currency, setCurrency] = useState(cachedCurrency || herzie.currency);
  const [equipped, setEquipped] = useState(cachedEquipped);
  const [inspectItem, setInspectItem] = useState<string | null>(
    initialItem ?? null,
  );

  useEffect(() => {
    setInventory(cachedInventory);
    setCurrency(cachedCurrency || herzie.currency);
    setEquipped(cachedEquipped);
  }, [cachedInventory, cachedCurrency, cachedEquipped, herzie.currency]);

  useEffect(() => {
    if (initialItem) setInspectItem(initialItem);
  }, [initialItem]);

  // Stale-while-revalidate once on mount (view stays mounted when hidden).
  useEffect(() => {
    herzies.fetchInventory().then((data) => {
      if (data) {
        setInventory(data.inventory);
        setCurrency(data.currency);
        setEquipped(data.equipped ?? []);
      }
    });
  }, []);

  const handleSell = async (itemId: string, qty: number) => {
    const result = await herzies.sellItem(itemId, qty);
    if (result) {
      setInventory(result.inventory);
      setCurrency(result.newCurrency);
    }
  };

  const handleEquip = async (itemId: string) => {
    const isEquipped = equipped.includes(itemId);
    const action = isEquipped ? "unequip" : "equip";
    const item = getItem(itemId);
    const name = item?.name ?? itemId;
    try {
      const result = await herzies.equipItem(itemId, action);
      setEquipped(result.equipped);
      onLog?.(action === "equip" ? `Equipped ${name}` : `Unequipped ${name}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`Failed to ${action} ${name}: ${msg}`);
    }
  };

  const rarityOrder: Record<string, number> = {
    legendary: 0,
    rare: 1,
    uncommon: 2,
    common: 3,
  };
  const items = inventory
    ? Object.entries(inventory)
        .filter(([, qty]) => qty > 0)
        .sort((a, b) => {
          const ra = rarityOrder[getItem(a[0])?.rarity ?? "common"] ?? 3;
          const rb = rarityOrder[getItem(b[0])?.rarity ?? "common"] ?? 3;
          if (ra !== rb) return ra - rb;
          return (getItem(a[0])?.name ?? a[0]).localeCompare(
            getItem(b[0])?.name ?? b[0],
          );
        })
    : [];
  const loading = inventory === null;

  const equippedInSlot = (slot: EquipSlot): ItemDef | null => {
    for (const id of equipped) {
      const def = getItem(id);
      if (def?.equipSlot === slot) return def;
    }
    return null;
  };

  const inspected = inspectItem ? getItem(inspectItem) : null;
  const inspectedQty = inspectItem ? (inventory?.[inspectItem] ?? 0) : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="z-50 mb-1 flex items-center justify-between">
        <h1 className="text-ui-lg font-bold text-yellow">Inventory</h1>
        <div className="text-ui text-yellow">${currency}</div>
      </div>

      {/* 3D render with wearable-area overlays */}
      <div className="relative min-h-0 flex-1">
        <div className="flex h-full items-center justify-center">
          <Herzie3D
            userId={herzie.friendCode}
            stage={herzie.stage}
            wearables={equipped}
            paused={!active}
          />
        </div>
        <div className="absolute left-0 top-0 z-10 flex flex-col gap-2">
          {WEARABLE_AREAS.filter((a) => a.side === "left").map((area) => (
            <WearableArea
              key={area.slot}
              label={area.label}
              item={equippedInSlot(area.slot)}
              animate={active}
              align="left"
              onUnequip={handleEquip}
            />
          ))}
        </div>
        <div className="absolute right-0 top-0 z-10 flex flex-col items-end gap-2">
          {WEARABLE_AREAS.filter((a) => a.side === "right").map((area) => (
            <WearableArea
              key={area.slot}
              label={area.label}
              item={equippedInSlot(area.slot)}
              animate={active}
              align="right"
              onUnequip={handleEquip}
            />
          ))}
        </div>
      </div>

      {/* Item list — bottom ~40% */}
      <div className="z-10 h-[40%] min-h-0 shrink-0 overflow-auto border-t border-border">
        {loading ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            Loading...
          </div>
        ) : items.length === 0 ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            No items yet. Keep listening to earn drops!
          </div>
        ) : (
          items.map(([itemId, qty]) => {
            const def = getItem(itemId);
            const name = def?.name ?? itemId;
            const rarity = def?.rarity ?? "common";
            const isEquipped = equipped.includes(itemId);
            return (
              <div
                key={itemId}
                className="flex items-center justify-between gap-2 border-b border-[#222] py-1.5"
              >
                <button
                  type="button"
                  onClick={() => setInspectItem(itemId)}
                  className="min-w-0 flex-1 cursor-pointer text-left"
                  title="Inspect item"
                >
                  <div
                    className="truncate text-ui hover:underline"
                    style={{ color: ITEM_RARITY_COLORS[rarity] }}
                  >
                    {name}
                  </div>
                  <div className="text-[10px] text-text-dim">
                    x{qty}
                    {def?.sellPrice ? ` · $${def.sellPrice} each` : ""}
                    {isEquipped && (
                      <span className="ml-1 text-green">[equipped]</span>
                    )}
                  </div>
                </button>
                {def?.equipable && (
                  <button
                    type="button"
                    className={cn(
                      "btn shrink-0",
                      isEquipped ? "text-red" : "text-green",
                    )}
                    onClick={() => handleEquip(itemId)}
                  >
                    {isEquipped ? "Unequip" : "Equip"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {inspectItem && inspected && (
        <ItemInspectOverlay
          itemId={inspectItem}
          onClose={() => setInspectItem(null)}
          meta={inspectedQty > 0 ? `x${inspectedQty}` : undefined}
          footer={
            <>
              {inspected.equipable && (
                <button
                  type="button"
                  className={cn(
                    "btn",
                    equipped.includes(inspectItem)
                      ? "text-red"
                      : "text-green",
                  )}
                  onClick={() => handleEquip(inspectItem)}
                >
                  {equipped.includes(inspectItem) ? "Unequip" : "Equip"}
                </button>
              )}
              {inspected.sellPrice && inspectedQty > 0 ? (
                <SellControls
                  itemId={inspectItem}
                  qty={inspectedQty}
                  price={inspected.sellPrice}
                  onSell={handleSell}
                />
              ) : null}
            </>
          }
        />
      )}
    </div>
  );
}
