import type { Herzie, Inventory } from "@herzies/shared";
import {
  getItem,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  ItemDisplay,
  RARITY_LABELS,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { BackButton } from "./BackButton";
import { NumberTicker } from "./NumberTicker";
import { View } from "./View";

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

export function InventoryView({
  herzie,
  initialItem,
  onLog,
  inventory: cachedInventory,
  currency: cachedCurrency,
  equipped: cachedEquipped,
}: {
  herzie: Herzie;
  initialItem?: string | null;
  onLog?: (msg: string) => void;
  inventory: Inventory | null;
  currency: number;
  equipped: string[];
}) {
  const [inventory, setInventory] = useState<Inventory | null>(
    cachedInventory,
  );
  const [currency, setCurrency] = useState(cachedCurrency || herzie.currency);
  const [equipped, setEquipped] = useState(cachedEquipped);
  const [selectedItem, setSelectedItem] = useState<string | null>(
    initialItem ?? null,
  );

  useEffect(() => {
    setInventory(cachedInventory);
    setCurrency(cachedCurrency || herzie.currency);
    setEquipped(cachedEquipped);
  }, [cachedInventory, cachedCurrency, cachedEquipped, herzie.currency]);

  useEffect(() => {
    if (initialItem) setSelectedItem(initialItem);
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
  const selected = selectedItem ? getItem(selectedItem) : null;
  const loading = inventory === null;

  if (selected && selectedItem) {
    const qty = inventory?.[selectedItem] ?? 0;
    return (
      <div className="flex h-full flex-col">
        <div className="mb-2 flex items-center justify-between">
          <BackButton onClick={() => setSelectedItem(null)} />
          <div className="text-ui text-yellow">${currency}</div>
        </div>

        <div className="mb-2 flex justify-center py-2">
          <ItemDisplay item={selected} size={9} />
        </div>

        <div
          className="text-sm font-bold"
          style={{ color: ITEM_RARITY_COLORS[selected.rarity] }}
        >
          {selected.name}
        </div>
        <div className="mb-1 text-ui text-text-dim">
          {RARITY_LABELS[selected.rarity]} · x{qty}
        </div>
        <div className="mb-3 text-ui text-text-dim">{selected.description}</div>

        {selected.equipable && (
          <button
            type="button"
            className={cn(
              "btn mb-2 self-start",
              equipped.includes(selectedItem) ? "text-red" : "text-green",
            )}
            onClick={() => handleEquip(selectedItem)}
          >
            {equipped.includes(selectedItem) ? "Unequip" : "Equip"}
          </button>
        )}

        {selected.sellPrice && qty > 0 && (
          <SellControls
            itemId={selectedItem}
            qty={qty}
            price={selected.sellPrice}
            onSell={handleSell}
          />
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <View title="Inventory" colour="yellow">
        <div className="pt-5 text-center text-ui text-text-dim">Loading...</div>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View title="Inventory" colour="yellow">
        <div className="pt-5 text-center text-ui text-text-dim">
          No items yet. Keep listening to earn drops!
        </div>
      </View>
    );
  }

  return (
    <View
      title="Inventory"
      colour="yellow"
      action={<div className="text-ui text-yellow">${currency}</div>}
    >
      <div className="min-h-0 flex-1 overflow-auto">
        {items.map(([itemId, qty]) => {
          const def = getItem(itemId);
          const name = def?.name ?? itemId;
          const rarity = def?.rarity ?? "common";
          return (
            <button
              type="button"
              key={itemId}
              onClick={() => setSelectedItem(itemId)}
              className="w-full text-left flex cursor-pointer items-center justify-between border-b border-[#222] py-1.5"
            >
              <div>
                <div
                  className="text-ui"
                  style={{ color: ITEM_RARITY_COLORS[rarity] }}
                >
                  {name}
                </div>
                <div className="text-[10px] text-text-dim">
                  x{qty}
                  {def?.sellPrice ? ` · $${def.sellPrice} each` : ""}
                  {equipped.includes(itemId) && (
                    <span className="ml-1 text-green">[equipped]</span>
                  )}
                </div>
              </div>
              <span className="text-ui text-text-dim">→</span>
            </button>
          );
        })}
      </div>
    </View>
  );
}
