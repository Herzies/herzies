"use client";

import { GENRES, type Genre } from "@herzies/shared";
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
  hatedGenres: Genre[];
  /** Empty = scale with active players (series templates only). */
  maxHp: string;
  rewardItemId: string;
  topRewardItemId: string;
  topCount: string;
};

export function defaultBossFightConfig(): BossFightConfigForm {
  return {
    hatedGenres: [],
    maxHp: "900",
    rewardItemId: "cd",
    topRewardItemId: "cd",
    topCount: "3",
  };
}

export function bossFightConfigFromRecord(
  config: Record<string, unknown>,
  liveMaxHp?: number,
): BossFightConfigForm {
  const maxHp =
    liveMaxHp ?? (typeof config.maxHp === "number" ? config.maxHp : undefined);
  return {
    hatedGenres: Array.isArray(config.hatedGenres)
      ? (config.hatedGenres.filter((g) =>
          (GENRES as readonly unknown[]).includes(g),
        ) as Genre[])
      : [],
    maxHp: maxHp != null ? String(maxHp) : "",
    rewardItemId:
      typeof config.rewardItemId === "string" ? config.rewardItemId : "",
    topRewardItemId:
      typeof config.topRewardItemId === "string" ? config.topRewardItemId : "",
    topCount:
      typeof config.topCount === "number" ? String(config.topCount) : "3",
  };
}

/**
 * Form → config, or an error message. A template may leave genres and HP
 * empty: each occurrence then rolls its own genres and scales HP with the
 * player count when it is generated.
 */
export function bossFightFormToConfig(
  boss: BossFightConfigForm,
  { template = false }: { template?: boolean } = {},
): Record<string, unknown> | string {
  if (boss.hatedGenres.length === 0 && !template) {
    return "Pick at least one hated genre";
  }
  const hasHp = boss.maxHp.trim() !== "";
  const maxHp = Number(boss.maxHp);
  if ((!hasHp && !template) || (hasHp && !(maxHp > 0))) {
    return "Boss HP must be a positive number";
  }
  if (!boss.rewardItemId) return "Reward item is required";
  const topCount = Number.parseInt(boss.topCount, 10);
  if (!Number.isFinite(topCount) || topCount < 0) {
    return "Top count must be zero or more";
  }
  return {
    ...(boss.hatedGenres.length > 0 ? { hatedGenres: boss.hatedGenres } : {}),
    ...(hasHp ? { maxHp } : {}),
    rewardItemId: boss.rewardItemId,
    ...(boss.topRewardItemId ? { topRewardItemId: boss.topRewardItemId } : {}),
    topCount,
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
  /** Series template: genres and HP may be left empty for "roll / auto". */
  template?: boolean;
}) {
  const toggleGenre = (genre: Genre) => {
    update({
      hatedGenres: boss.hatedGenres.includes(genre)
        ? boss.hatedGenres.filter((g) => g !== genre)
        : [...boss.hatedGenres, genre],
    });
  };

  return (
    <div className="space-y-4 border border-border rounded-sm p-4 bg-bg">
      <p className="text-xs text-cyan">boss fight config</p>
      <fieldset>
        <legend className="block text-xs text-text-dim mb-2">
          hated genres (listening to these deals damage)
          {template && " — leave empty to roll 3 at random each week"}
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {GENRES.map((genre) => (
            <label
              key={genre}
              className="flex items-center gap-1.5 text-xs cursor-pointer"
            >
              <input
                type="checkbox"
                checked={boss.hatedGenres.includes(genre)}
                onChange={() => toggleGenre(genre)}
              />
              {genre}
            </label>
          ))}
        </div>
        {boss.hatedGenres.includes("pop") && (
          <p className="text-yellow text-xs mt-2">
            Pop is the fallback genre for unmatched tags — nearly every listen
            will hit this boss.
          </p>
        )}
      </fieldset>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-boss-hp`}
          >
            max hp
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
              : template
                ? "empty = 35 per active player (900–50000), sized when each boss is scheduled"
                : null}
          </p>
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-boss-top-count`}
          >
            top dealers who get the top reward
          </label>
          <input
            id={`${fieldIdPrefix}-boss-top-count`}
            type="number"
            min={0}
            required
            value={boss.topCount}
            onChange={(e) => update({ topCount: e.target.value })}
            className={INPUT}
          />
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-boss-reward`}
          >
            reward item (everyone who dealt damage)
          </label>
          <CatalogItemSelect
            id={`${fieldIdPrefix}-boss-reward`}
            value={boss.rewardItemId}
            onChange={(rewardItemId) => update({ rewardItemId })}
            catalogItems={catalogItems}
            required
          />
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-boss-top-reward`}
          >
            top reward item (optional, on top of the reward)
          </label>
          <CatalogItemSelect
            id={`${fieldIdPrefix}-boss-top-reward`}
            value={boss.topRewardItemId}
            onChange={(topRewardItemId) => update({ topRewardItemId })}
            catalogItems={catalogItems}
            emptyLabel="none"
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
}: {
  merchant: MerchantConfigForm;
  setMerchant: (next: MerchantConfigForm) => void;
  catalogItems: CatalogItem[];
  fieldIdPrefix: string;
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
      <p className="text-xs text-cyan">Good ol&apos; George&apos;s stock</p>
      {merchant.stock.length === 0 && (
        <p className="text-xs text-purple">
          Nothing stocked — George won&apos;t show up until he has something to
          sell.
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
              price
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
