import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOBOKU_STOCK } from "./boboku.js";
import { getItem } from "./items.js";

describe("Boboku's stock", () => {
  it("is class instruments, each with stats", () => {
    for (const { itemId, price } of BOBOKU_STOCK) {
      const def = getItem(itemId);
      expect(def?.requiredClass, itemId).toBeTruthy();
      expect(Object.keys(def?.stats ?? {}).length, itemId).toBeGreaterThan(0);
      expect(price).toBeGreaterThan(def?.sellPrice ?? 0);
    }
  });

  it("matches buy_from_boboku's price list", () => {
    const sql = readFileSync(
      new URL("../../../supabase/migrations/00112_boboku.sql", import.meta.url),
      "utf8",
    );
    const rows = [...sql.matchAll(/\('([a-z-]+)', (\d+)\)/g)].map(
      ([, itemId, price]) => ({ itemId, price: Number(price) }),
    );
    expect(rows).toEqual(BOBOKU_STOCK);
  });
});
