import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MARKET_FEE_PERCENT,
  MARKET_LISTING_HOURS,
  MARKET_MAX_LISTINGS,
  MARKET_MAX_PRICE,
  marketFee,
  marketMinPrice,
  marketPayout,
} from "./market.js";

describe("the market's cut", () => {
  it("is 5% of the price, rounded down", () => {
    expect(marketFee(1000)).toBe(50);
    expect(marketFee(259)).toBe(12);
  });

  it("is never less than one coin", () => {
    expect(marketFee(2)).toBe(1);
    expect(marketFee(19)).toBe(1);
  });

  it("comes out of the seller's proceeds", () => {
    expect(marketPayout(1000)).toBe(950);
    expect(marketPayout(2)).toBe(1);
  });
});

describe("listing prices", () => {
  it("start above what the game pays, so listing beats selling", () => {
    expect(marketMinPrice(250)).toBe(251);
    expect(marketMinPrice(undefined)).toBe(1);
  });
});

describe("the SQL side", () => {
  it("uses the same rules as market.ts", () => {
    const sql = readFileSync(
      new URL(
        "../../../supabase/migrations/00126_market_board.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const constant = (name: string) =>
      Number(sql.match(new RegExp(`${name}\\s+constant int := (\\d+);`))?.[1]);
    expect(constant("c_max_listings")).toBe(MARKET_MAX_LISTINGS);
    expect(constant("c_listing_hours")).toBe(MARKET_LISTING_HOURS);
    expect(constant("c_max_price")).toBe(MARKET_MAX_PRICE);
    expect(constant("c_fee_percent")).toBe(MARKET_FEE_PERCENT);
  });
});
