import {
  bankCapacity,
  bankSlotsUsed,
  type MarketListing,
  type MarketStall,
  normalizeEquipped,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import type { createAdminClient } from "@/lib/supabase-admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Every reason a market RPC (00126) refuses, as the routes answer it. */
const REASONS: Record<string, { status: number; error: string }> = {
  "not-found": { status: 404, error: "Herzie not found" },
  "not-owned": { status: 404, error: "That isn't yours" },
  equipped: { status: 400, error: "Take it off before listing it" },
  bound: { status: 400, error: "That can't be sold to other players" },
  "price-too-low": {
    status: 400,
    error: "The game pays that much — sell it there instead",
  },
  "price-too-high": { status: 400, error: "That price is too high" },
  "too-many-listings": { status: 409, error: "Your stall is full" },
  gone: { status: 409, error: "That listing is no longer for sale" },
  "own-listing": { status: 400, error: "That's your own listing" },
  "insufficient-funds": { status: 400, error: "Not enough currency" },
};

/** The response for an RPC's `{ok: false, reason}`. */
export function refusal(reason: string | undefined, fallback: string) {
  const known = REASONS[reason ?? ""];
  return NextResponse.json(
    { error: known?.error ?? fallback, reason },
    { status: known?.status ?? 400 },
  );
}

/** What the board selects for a listing, with the seller's name. */
export const LISTING_COLUMNS =
  "id, seller_id, item_id, upgrade_level, price, fee, status, created_at, expires_at, sold_at, seller:herzies!market_listings_seller_id_fkey(name)";

interface ListingRow {
  id: string;
  seller_id: string;
  item_id: string;
  upgrade_level: number;
  price: number;
  fee: number;
  status: MarketListing["status"];
  created_at: string;
  expires_at: string;
  sold_at: string | null;
  seller?: { name: string } | { name: string }[] | null;
}

/** A row as a MarketListing. An 'active' row past its time is expired: the
 * table isn't swept, so every reader derives it (see 00126). */
export function toListing(row: ListingRow, now = Date.now()): MarketListing {
  const seller = Array.isArray(row.seller) ? row.seller[0] : row.seller;
  const expired = row.status === "active" && Date.parse(row.expires_at) <= now;
  return {
    id: row.id,
    sellerId: row.seller_id,
    sellerName: seller?.name ?? null,
    itemId: row.item_id,
    upgradeLevel: row.upgrade_level,
    price: row.price,
    fee: row.fee,
    status: expired ? "expired" : row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    soldAt: row.sold_at,
  };
}

/** The player's own listings: what's up and what's waiting to collect. */
export async function loadStall(
  admin: Admin,
  userId: string,
): Promise<MarketStall> {
  const { data } = await admin
    .from("market_listings")
    .select(LISTING_COLUMNS)
    .eq("seller_id", userId)
    .is("collected_at", null)
    .order("created_at");
  const listings = ((data ?? []) as ListingRow[]).map((r) => toListing(r));
  const active = listings.filter((l) => l.status === "active");
  const uncollected = listings.filter((l) => l.status !== "active");
  return {
    active,
    uncollected,
    coinsWaiting: uncollected
      .filter((l) => l.status === "sold")
      .reduce((sum, l) => sum + (l.price - l.fee), 0),
    itemsWaiting: uncollected.filter((l) => l.status !== "sold").length,
  };
}

/** Whether `adding` more copies fit in the player's bank: null when the
 * herzie doesn't exist. */
export async function fitsInBank(
  admin: Admin,
  userId: string,
  adding: Record<string, number>,
): Promise<boolean | null> {
  const { data: herzie } = await admin
    .from("herzies")
    .select("inventory_v2, equipped, bank_expansions")
    .eq("user_id", userId)
    .single();
  if (!herzie) return null;
  const next = { ...((herzie.inventory_v2 ?? {}) as Record<string, number>) };
  for (const [itemId, qty] of Object.entries(adding)) {
    next[itemId] = (next[itemId] ?? 0) + qty;
  }
  return (
    bankSlotsUsed(next, normalizeEquipped(herzie.equipped)) <=
    bankCapacity(herzie.bank_expansions)
  );
}
