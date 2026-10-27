"use client";

import { BOSS_HP_PER_PLAYER } from "@herzies/shared";
import { type CatalogItem, INPUT } from "./admin-shared";

/** Item picker limited to the catalog — boss rewards are never auto-created. */
export function CatalogItemSelect({
  id,
  value,
  onChange,
  catalogItems,
  required,
  emptyLabel = "select item…",
}: {
  id: string;
  value: string;
  onChange: (itemId: string) => void;
  catalogItems: CatalogItem[];
  required?: boolean;
  emptyLabel?: string;
}) {
  const missing = !!value && !catalogItems.some((i) => i.id === value);
  return (
    <>
      <select
        id={id}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      >
        <option value="">{emptyLabel}</option>
        {missing && <option value={value}>{value} (not in catalog)</option>}
        {catalogItems.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} ({item.id})
          </option>
        ))}
      </select>
      {missing && (
        <p className="text-red text-xs mt-1">
          Item not in catalog — saving will be refused.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Boss fight
// ---------------------------------------------------------------------------

export type BossFightConfigForm = {
  /** Health before the roster locks (a placeholder: the lock sets it from
   * the roster). Empty = the default (series templates only). */
  maxHp: string;
  /** Health per herzie in the roster; empty = the tuned default. */
  hpPerPlayer: string;
  /** Minions' strength as a Tower floor; empty = from the raid's level. */
  minionFloor: string;
  rewardItemId: string;
};

export function defaultBossFightConfig(): BossFightConfigForm {
  return {
    maxHp: String(BOSS_HP_PER_PLAYER),
    hpPerPlayer: "",
    minionFloor: "",
    rewardItemId: "cd",
  };
}

export function bossFightConfigFromRecord(
  config: Record<string, unknown>,
  liveMaxHp?: number,
): BossFightConfigForm {
  const maxHp =
    liveMaxHp ?? (typeof config.maxHp === "number" ? config.maxHp : undefined);
  return {
    maxHp: maxHp != null ? String(maxHp) : "",
    hpPerPlayer:
      typeof config.hpPerPlayer === "number" ? String(config.hpPerPlayer) : "",
    minionFloor:
      typeof config.minionFloor === "number" ? String(config.minionFloor) : "",
    rewardItemId:
      typeof config.rewardItemId === "string" ? config.rewardItemId : "",
  };
}

/**
 * Form → config, or an error message. A template may leave HP empty: each
 * occurrence then scales it with the player count when it is generated.
 * (No genres: the boss hates all music.)
 */
export function bossFightFormToConfig(
  boss: BossFightConfigForm,
  { template = false }: { template?: boolean } = {},
): Record<string, unknown> | string {
  const hasHp = boss.maxHp.trim() !== "";
  const maxHp = Number(boss.maxHp);
  if ((!hasHp && !template) || (hasHp && !(maxHp > 0))) {
    return "Boss HP must be a positive number";
  }
  if (!boss.rewardItemId) return "Reward item is required";
  const hasPer = boss.hpPerPlayer.trim() !== "";
  const hpPerPlayer = Number(boss.hpPerPlayer);
  if (hasPer && !(hpPerPlayer >= 100)) {
    return "HP per herzie must be at least 100";
  }
  const hasFloor = boss.minionFloor.trim() !== "";
  const minionFloor = Number(boss.minionFloor);
  if (hasFloor && !(Number.isInteger(minionFloor) && minionFloor >= 1)) {
    return "Minion floor must be a whole number from 1";
  }
  return {
    ...(hasHp ? { maxHp } : {}),
    ...(hasPer ? { hpPerPlayer } : {}),
    ...(hasFloor ? { minionFloor } : {}),
    rewardItemId: boss.rewardItemId,
  };
}

export function BossFightConfigFields({
  boss,
  update,
  catalogItems,
  fieldIdPrefix,
  live,
  template = false,
}: {
  boss: BossFightConfigForm;
  update: (patch: Partial<BossFightConfigForm>) => void;
  catalogItems: CatalogItem[];
  fieldIdPrefix: string;
  live?: { hp: number; maxHp: number; killed: boolean; escaped: boolean };
  /** Series template: HP may be left empty for "auto". */
  template?: boolean;
}) {
  return (
    <div className="space-y-4 border border-border rounded-sm p-4 bg-bg">
      <p className="text-xs text-cyan">boss fight config</p>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-boss-hp`}
          >
            hp before the lock (placeholder)
          </label>
          <input
            id={`${fieldIdPrefix}-boss-hp`}
            type="number"
            min={1}
            required={!template}
            placeholder={template ? "auto" : undefined}
            value={boss.maxHp}
            onChange={(e) => update({ maxHp: e.target.value })}
            className={INPUT}
          />
          <p className="text-xs text-text-dim mt-1">
            {live
              ? `current: ${Math.round(live.hp)} / ${Math.round(live.maxHp)}${live.killed ? " (killed)" : live.escaped ? " (escaped)" : ""} — damage already dealt is kept`
              : "at the lock the boss gets hp per herzie × roster^0.9"}
          </p>
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-boss-hp-per`}
          >
            hp per herzie in the roster
          </label>
          <input
            id={`${fieldIdPrefix}-boss-hp-per`}
            type="number"
            min={100}
            placeholder={String(BOSS_HP_PER_PLAYER)}
            value={boss.hpPerPlayer}
            onChange={(e) => update({ hpPerPlayer: e.target.value })}
            className={INPUT}
          />
          <p className="text-xs text-text-dim mt-1">
            empty = {BOSS_HP_PER_PLAYER.toLocaleString()} (about 6–8 minutes)
          </p>
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-boss-minion-floor`}
          >
            minion strength (tower floor)
          </label>
          <input
            id={`${fieldIdPrefix}-boss-minion-floor`}
            type="number"
            min={1}
            placeholder="auto"
            value={boss.minionFloor}
            onChange={(e) => update({ minionFloor: e.target.value })}
            className={INPUT}
          />
          <p className="text-xs text-text-dim mt-1">
            empty = 75% of the raid's average level
          </p>
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-boss-reward`}
          >
            reward item (everyone still in when it falls)
          </label>
          <CatalogItemSelect
            id={`${fieldIdPrefix}-boss-reward`}
            value={boss.rewardItemId}
            onChange={(rewardItemId) => update({ rewardItemId })}
            catalogItems={catalogItems}
            required
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Good ol' George (merchant)
// ---------------------------------------------------------------------------

export type MerchantStockForm = {
  itemId: string;
  price: string;
  perPlayerLimit: string;
  totalStock: string;
};

export type MerchantConfigForm = { stock: MerchantStockForm[] };

export function defaultMerchantConfig(): MerchantConfigForm {
  return { stock: [] };
}

export function merchantConfigFromRecord(
  config: Record<string, unknown>,
): MerchantConfigForm {
  const stock = Array.isArray(config.stock) ? config.stock : [];
  const str = (v: unknown) => (typeof v === "number" ? String(v) : "");
  return {
    stock: stock.map((raw) => {
      const entry = raw as Record<string, unknown>;
      return {
        itemId: typeof entry.itemId === "string" ? entry.itemId : "",
        price: str(entry.price),
        perPlayerLimit: str(entry.perPlayerLimit),
        totalStock: str(entry.totalStock),
      };
    }),
  };
}

export function merchantFormToConfig(
  form: MerchantConfigForm,
): Record<string, unknown> | string {
  const stock: Record<string, unknown>[] = [];
  const optional = (v: string) =>
    v.trim() === "" ? undefined : Number.parseInt(v, 10);
  for (const [i, line] of form.stock.entries()) {
    if (!line.itemId) return `Stock line ${i + 1}: pick an item`;
    const price = Number.parseInt(line.price, 10);
    if (!(price > 0)) return `Stock line ${i + 1}: price must be positive`;
    const perPlayerLimit = optional(line.perPlayerLimit);
    const totalStock = optional(line.totalStock);
    for (const v of [perPlayerLimit, totalStock]) {
      if (v !== undefined && !(v > 0)) {
        return `Stock line ${i + 1}: limits must be positive or empty`;
      }
    }
    stock.push({
      itemId: line.itemId,
      price,
      ...(perPlayerLimit !== undefined ? { perPlayerLimit } : {}),
      ...(totalStock !== undefined ? { totalStock } : {}),
    });
  }
  return { stock };
}

export function MerchantConfigFields({
  merchant,
  setMerchant,
  catalogItems,
  fieldIdPrefix,
  priceLabel = "price",
}: {
  merchant: MerchantConfigForm;
  setMerchant: (next: MerchantConfigForm) => void;
  catalogItems: CatalogItem[];
  fieldIdPrefix: string;
  /** "price (treats)" for Nandor, whose stock is priced in treats. */
  priceLabel?: string;
}) {
  const updateLine = (i: number, patch: Partial<MerchantStockForm>) => {
    setMerchant({
      stock: merchant.stock.map((line, j) =>
        j === i ? { ...line, ...patch } : line,
      ),
    });
  };

  return (
    <div className="space-y-3 border border-border rounded-sm p-4 bg-bg">
      <p className="text-xs text-cyan">Stock</p>
      {merchant.stock.length === 0 && (
        <p className="text-xs text-purple">
          Nothing stocked — the visit won&apos;t go live until there&apos;s
          something to sell.
        </p>
      )}
      {merchant.stock.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until an item is picked
          key={i}
          className="grid grid-cols-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] gap-2 items-end"
        >
          <div className="col-span-2 sm:col-span-1">
            <label
              className="block text-xs text-text-dim mb-1"
              htmlFor={`${fieldIdPrefix}-stock-${i}-item`}
            >
              item
            </label>
            <CatalogItemSelect
              id={`${fieldIdPrefix}-stock-${i}-item`}
              value={line.itemId}
              onChange={(itemId) => updateLine(i, { itemId })}
              catalogItems={catalogItems}
              required
            />
          </div>
          <div>
            <label
              className="block text-xs text-text-dim mb-1"
              htmlFor={`${fieldIdPrefix}-stock-${i}-price`}
            >
              {priceLabel}
            </label>
            <input
              id={`${fieldIdPrefix}-stock-${i}-price`}
              type="number"
              min={1}
              required
              value={line.price}
              onChange={(e) => updateLine(i, { price: e.target.value })}
              className={INPUT}
            />
          </div>
          <div>
            <label
              className="block text-xs text-text-dim mb-1"
              htmlFor={`${fieldIdPrefix}-stock-${i}-limit`}
            >
              per player
            </label>
            <input
              id={`${fieldIdPrefix}-stock-${i}-limit`}
              type="number"
              min={1}
              placeholder="∞"
              value={line.perPlayerLimit}
              onChange={(e) =>
                updateLine(i, { perPlayerLimit: e.target.value })
              }
              className={INPUT}
            />
          </div>
          <div>
            <label
              className="block text-xs text-text-dim mb-1"
              htmlFor={`${fieldIdPrefix}-stock-${i}-total`}
            >
              total stock
            </label>
            <input
              id={`${fieldIdPrefix}-stock-${i}-total`}
              type="number"
              min={1}
              placeholder="∞"
              value={line.totalStock}
              onChange={(e) => updateLine(i, { totalStock: e.target.value })}
              className={INPUT}
            />
          </div>
          <button
            type="button"
            onClick={() =>
              setMerchant({ stock: merchant.stock.filter((_, j) => j !== i) })
            }
            className="text-red text-xs bg-transparent border-0 cursor-pointer py-2"
          >
            remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setMerchant({
            stock: [
              ...merchant.stock,
              { itemId: "", price: "", perPlayerLimit: "", totalStock: "" },
            ],
          })
        }
        className="text-xs text-purple bg-transparent border border-border px-3 py-1.5 rounded-sm cursor-pointer hover:border-purple"
      >
        + add item
      </button>
    </div>
  );
}
