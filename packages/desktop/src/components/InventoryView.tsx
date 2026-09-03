import type {
  Equipped,
  GroundSide,
  Herzie,
  Inventory,
  ItemCategory,
} from "@herzies/shared";
import {
  findEquippedSlot,
  getItem,
  getItemCategory,
  groundSlot,
  normalizeEquipped,
  RARITY_COLORS,
  RARITY_LABELS,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn, formatAmount } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { Coin } from "./Coin";
import { Herzie3D } from "./Herzie3D";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { NumberTicker } from "./NumberTicker";
import { Tooltip } from "./Tooltip";

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer border-none bg-transparent px-1.5 pb-1.5 pt-0.5 text-ui",
        active ? "font-bold text-cyan" : "text-text-dim hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

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
      {qty > 1 && (
        <div className="mb-1 flex items-center gap-1">
          <NumberTicker
            value={clamped}
            min={1}
            max={qty}
            onChange={setSellAmount}
            fullWidth
          />
        </div>
      )}
      <div className="flex items-center justify-center gap-1">
        <button
          type="button"
          className="btn"
          onClick={() => onSell(itemId, clamped)}
        >
          Sell (<Coin amount={clamped * price} />)
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

function pickGroundSide(equipped: Equipped): GroundSide {
  if (!equipped.ground_left) return "left";
  if (!equipped.ground_right) return "right";
  return "left"; // both occupied → replace left
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
  const [tab, setTab] = useState<ItemCategory>("deck");

  useEffect(() => {
    setInventory(cachedInventory);
    setCurrency(cachedCurrency || herzie.currency);
    setEquipped(normalizeEquipped(cachedEquipped));
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
      if (itemId === inspectItem && (result.inventory[itemId] ?? 0) === 0) {
        setInspectItem(null);
      }
    }
  };

  const handleEquip = async (itemId: string) => {
    const existing = findEquippedSlot(equipped, itemId);
    const action = existing ? "unequip" : "equip";
    const item = getItem(itemId);
    const name = item?.name ?? itemId;
    let side: GroundSide | undefined;
    if (action === "equip" && item?.equipSlot === "ground") {
      side = pickGroundSide(equipped);
    }
    try {
      const result = await herzies.equipItem(itemId, action, side);
      setEquipped(normalizeEquipped(result.equipped));
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
        .filter(([itemId, qty]) => {
          if (qty <= 0) return false;
          const def = getItem(itemId);
          return (def ? getItemCategory(def) : "deck") === tab;
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
  const loading = inventory === null;

  const isItemEquipped = (itemId: string) =>
    findEquippedSlot(equipped, itemId) !== null;

  const inspected = inspectItem ? getItem(inspectItem) : null;
  const inspectedQty = inspectItem ? (inventory?.[inspectItem] ?? 0) : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="z-50 mb-1 flex items-center justify-between">
        <h1 className="text-ui-lg font-bold text-cyan">Inventory</h1>
        <Tooltip label={`${formatAmount(currency)} herzie coins`}>
          <div className="text-ui text-cyan">
            <Coin amount={currency} />
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

      {/* Item list — bottom ~40% */}
      <div className="z-10 flex h-[40%] min-h-0 shrink-0 flex-col border-t border-border">
        <div className="flex gap-1 border-b border-border">
          <Tooltip label="Cards give bonuses or change appearance">
            <TabButton active={tab === "deck"} onClick={() => setTab("deck")}>
              Deck
            </TabButton>
          </Tooltip>
          <TabButton active={tab === "misc"} onClick={() => setTab("misc")}>
            Misc
          </TabButton>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="pt-5 text-center text-ui text-text-dim">
              Loading...
            </div>
          ) : items.length === 0 ? (
            <div className="pt-5 text-center text-ui text-text-dim">
              {tab === "deck"
                ? "No cards yet. Keep listening to earn drops!"
                : "No misc items yet."}
            </div>
          ) : (
            items.map(([itemId, qty]) => {
              const def = getItem(itemId);
              const name = def?.name ?? itemId;
              const isEquipped = isItemEquipped(itemId);
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
                    <div className="truncate text-ui hover:underline">
                      {name}
                    </div>
                    <div className="text-[10px] text-text-dim">
                      <span
                        style={{
                          color: RARITY_COLORS[def?.rarity ?? "common"],
                        }}
                      >
                        {RARITY_LABELS[def?.rarity ?? "common"]}
                      </span>{" "}
                      · x{qty}
                      {isEquipped && def?.equipSlot === "ground"
                        ? ` · ${findEquippedSlot(equipped, itemId) === groundSlot("left") ? "L" : "R"}`
                        : ""}
                    </div>
                  </button>
                  {def?.equipable && (
                    <button
                      type="button"
                      className={cn("btn shrink-0")}
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
      </div>

      {inspectItem && inspected && (
        <ItemInspectOverlay
          itemId={inspectItem}
          onClose={() => setInspectItem(null)}
          meta={inspectedQty > 0 ? `x${inspectedQty}` : undefined}
          footer={
            <>
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
