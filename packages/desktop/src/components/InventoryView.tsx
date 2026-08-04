import type {
  Equipped,
  EquippedSlot,
  GroundSide,
  Herzie,
  Inventory,
  ItemDef,
} from "@herzies/shared";
import {
  findEquippedSlot,
  getItem,
  groundSlot,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  ItemPreview,
  normalizeEquipped,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { Herzie3D } from "./Herzie3D";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { NumberTicker } from "./NumberTicker";
import { Tooltip } from "./Tooltip";

/** Wearable areas shown as overlays on the 3D render. */
const WEARABLE_AREAS: {
  slot: EquippedSlot;
  label: string;
  side: "left" | "right";
}[] = [
  { slot: "scenery", label: "scene", side: "left" },
  { slot: "ground_left", label: "ground L", side: "left" },
  { slot: "ground_right", label: "ground R", side: "left" },
  { slot: "head", label: "head", side: "right" },
  { slot: "face", label: "face", side: "right" },
  { slot: "body", label: "body", side: "right" },
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
            className="flex cursor-pointer items-center justify-center overflow-hidden rounded border border-border bg-bg-panel"
            style={{
              width: SLOT_SIZE,
              height: SLOT_SIZE,
              borderColor: ITEM_RARITY_COLORS[item.rarity],
            }}
          >
            {/* pointer-events-none: the animated art swaps DOM nodes every
                frame, which otherwise breaks click events mid-press. */}
            <span className="pointer-events-none">
              <ItemPreview item={item} box={SLOT_SIZE} animate={animate} />
            </span>
          </button>
        </Tooltip>
      ) : (
        <div
          className="rounded border border-dashed border-border bg-bg-panel"
          style={{ width: SLOT_SIZE, height: SLOT_SIZE }}
        />
      )}
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

  const equippedInSlot = (slot: EquippedSlot): ItemDef | null => {
    const id = equipped[slot];
    return id ? (getItem(id) ?? null) : null;
  };

  const isItemEquipped = (itemId: string) =>
    findEquippedSlot(equipped, itemId) !== null;

  const inspected = inspectItem ? getItem(inspectItem) : null;
  const inspectedQty = inspectItem ? (inventory?.[inspectItem] ?? 0) : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="z-50 mb-1 flex items-center justify-between">
        <h1 className="text-ui-lg font-bold text-cyan">Inventory</h1>
        <div className="text-ui text-cyan">${currency}</div>
      </div>

      {/* 3D render with wearable-area overlays */}
      <div className="relative min-h-0 flex-1">
        <div className="flex h-full items-center justify-center">
          <Herzie3D
            userId={herzie.friendCode}
            stage={herzie.stage}
            equipped={equipped}
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
                  <div className="truncate text-ui hover:underline">{name}</div>
                  <div className="text-[10px] text-text-dim">
                    x{qty}
                    {def?.sellPrice ? ` · $${def.sellPrice} each` : ""}
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
                    isItemEquipped(inspectItem) ? "text-red" : "text-green",
                  )}
                  onClick={() => handleEquip(inspectItem)}
                >
                  {isItemEquipped(inspectItem) ? "Unequip" : "Equip"}
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
