import type { Herzie, Inventory } from "@herzies/shared";
import {
  getItem,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  ItemDisplay,
  RARITY_LABELS,
} from "@herzies/shared";
import { useCallback, useEffect, useState } from "react";
import { herzies } from "../tauri-bridge";
import { BackButton } from "./BackButton";
import { NumberTicker } from "./NumberTicker";
import { btnStyle } from "./styles";

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
      <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}>
        Sell for ${price} each
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <NumberTicker
          value={clamped}
          min={1}
          max={qty}
          onChange={setSellAmount}
        />
        <button style={btnStyle} onClick={() => onSell(itemId, clamped)}>
          Sell (${clamped * price})
        </button>
        {qty > 1 && (
          <button style={btnStyle} onClick={() => onSell(itemId, qty)}>
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
}: {
  herzie: Herzie;
  initialItem?: string | null;
  onLog?: (msg: string) => void;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [currency, setCurrency] = useState(herzie.currency);
  const [equipped, setEquipped] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<string | null>(
    initialItem ?? null,
  );

  const load = useCallback(async () => {
    const data = await herzies.fetchInventory();
    if (data) {
      setInventory(data.inventory);
      setCurrency(data.currency);
      setEquipped(data.equipped ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  // Detail view for selected item
  if (selected && selectedItem) {
    const qty = inventory?.[selectedItem] ?? 0;
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <BackButton onClick={() => setSelectedItem(null)} />
          <div style={{ fontSize: 12, color: "#facc15" }}>${currency}</div>
        </div>

        {/* Spinning 3D art */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "8px 0",
            marginBottom: 8,
          }}
        >
          <ItemDisplay item={selected} size={9} />
        </div>

        {/* Item info */}
        <div
          style={{
            fontSize: 14,
            fontWeight: "bold",
            color: ITEM_RARITY_COLORS[selected.rarity],
          }}
        >
          {selected.name}
        </div>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
          {RARITY_LABELS[selected.rarity]} · x{qty}
        </div>
        <div style={{ fontSize: 12, color: "#aaa", marginBottom: 12 }}>
          {selected.description}
        </div>

        {/* Equip/Unequip */}
        {selected.equipable && (
          <button
            style={{
              ...btnStyle,
              color: equipped.includes(selectedItem) ? "#f87171" : "#4ade80",
              marginBottom: 8,
              alignSelf: "flex-start",
            }}
            onClick={() => handleEquip(selectedItem)}
          >
            {equipped.includes(selectedItem) ? "Unequip" : "Equip"}
          </button>
        )}

        {/* Sell controls */}
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: "bold", color: "#facc15" }}>
          Inventory
        </div>
        <div style={{ fontSize: 12, color: "#facc15" }}>${currency}</div>
      </div>

      {loading ? (
        <div
          style={{
            fontSize: 12,
            color: "#555",
            textAlign: "center",
            paddingTop: 20,
          }}
        >
          Loading...
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: "#555",
            textAlign: "center",
            paddingTop: 20,
          }}
        >
          No items yet. Keep listening to earn drops!
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          {items.map(([itemId, qty]) => {
            const def = getItem(itemId);
            const name = def?.name ?? itemId;
            const rarity = def?.rarity ?? "common";
            return (
              <div
                key={itemId}
                onClick={() => setSelectedItem(itemId)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "6px 0",
                  borderBottom: "1px solid #222",
                  cursor: "pointer",
                }}
              >
                <div>
                  <div
                    style={{ fontSize: 12, color: ITEM_RARITY_COLORS[rarity] }}
                  >
                    {name}
                  </div>
                  <div style={{ fontSize: 10, color: "#666" }}>
                    x{qty}
                    {def?.sellPrice ? ` · $${def.sellPrice} each` : ""}
                    {equipped.includes(itemId) && (
                      <span style={{ color: "#4ade80", marginLeft: 4 }}>
                        [equipped]
                      </span>
                    )}
                  </div>
                </div>
                <span style={{ color: "#555", fontSize: 12 }}>→</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
