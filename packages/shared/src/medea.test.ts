import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getItem, ITEMS } from "./items.js";
import { MEDEA_STOCK } from "./medea.js";

const sql = readFileSync(
  new URL(
    "../../../supabase/migrations/00113_medea_star_candy.sql",
    import.meta.url,
  ),
  "utf8",
);

/** The `(VALUES ...)` rows in the SQL function `fn`. */
function valuesIn(fn: string): { itemId: string; n: number }[] {
  const start = sql.indexOf(`FUNCTION public.${fn}(`);
  const end = sql.indexOf("$$;", start);
  return [...sql.slice(start, end).matchAll(/\('([a-z-]+)', (\d+)\)/g)].map(
    ([, itemId, n]) => ({ itemId, n: Number(n) }),
  );
}

describe("Medea's stock", () => {
  it("is consumables, each costing more than it sells for", () => {
    for (const { itemId, price } of MEDEA_STOCK) {
      const def = getItem(itemId);
      expect(def?.consumable, itemId).toBeTruthy();
      expect(def?.stackable, itemId).toBe(true);
      expect(price).toBeGreaterThan(def?.sellPrice ?? 0);
    }
  });

  it("matches buy_from_medea's price list", () => {
    expect(
      valuesIn("buy_from_medea").map(({ itemId, n }) => ({
        itemId,
        price: n,
      })),
    ).toEqual(MEDEA_STOCK);
  });
});

describe("consumables", () => {
  it("heal what eat_item heals", () => {
    const catalog = ITEMS.filter((i) => i.consumable).map((i) => ({
      itemId: i.id,
      n: i.consumable?.heal ?? 0,
    }));
    expect(valuesIn("eat_item")).toEqual(catalog);
  });

  it("star candy heals 100", () => {
    expect(getItem("star-candy")?.consumable?.heal).toBe(100);
  });
});
