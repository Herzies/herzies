import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MARKET_FEE_PERCENT,
  MARKET_LISTING_HOURS,
  MARKET_MAX_LISTINGS,
  MARKET_MAX_PRICE,
  MARKET_MAX_STACK,
  MARKET_MIN_EACH,
  marketCost,
  marketFee,
  marketMinPrice,
  marketPayout,
  marketPriceEach,
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
  });

  it("are never under 2 coins a copy, so the cut is less than the price", () => {
    expect(marketMinPrice(undefined)).toBe(2);
    expect(marketMinPrice(0, 4)).toBe(8);
    expect(marketMinPrice(1)).toBe(2);
  });

  it("scale with the stack", () => {
    expect(marketMinPrice(5, 3)).toBe(18);
  });
});

describe("buying part of a stack", () => {
  it("costs the price each when the price splits evenly", () => {
    const l = { price: 120, quantity: 10 };
    expect(marketPriceEach(l)).toBe(12);
    expect(marketCost(l, 3)).toBe(36);
    expect(marketCost(l, 10)).toBe(120);
  });

  it("isn't possible on a lot priced as a whole", () => {
    expect(marketPriceEach({ price: 121, quantity: 10 })).toBeNull();
    expect(marketPriceEach({ price: 10, quantity: 10 })).toBeNull();
    expect(marketCost({ price: 121, quantity: 10 }, 10)).toBe(121);
  });

  it("is just the price for a single copy", () => {
    expect(marketPriceEach({ price: 7, quantity: 1 })).toBe(7);
  });
});

describe("the SQL side", () => {
  it("uses the same rules as market.ts", () => {
    const sql = readFileSync(
      new URL(
        "../../../supabase/migrations/00146_market_partial_buys.sql",
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
    expect(constant("c_max_stack")).toBe(MARKET_MAX_STACK);
    expect(constant("c_min_each")).toBe(MARKET_MIN_EACH);
  });
});
