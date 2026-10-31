import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { LISTING_COLUMNS, toListing } from "@/lib/market";
import { createAdminClient } from "@/lib/supabase-admin";

const PAGE_SIZE = 50;

/**
 * What's for sale on the market board, cheapest first. `?itemId=` narrows it
 * to one item; `?offset=` pages.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const params = new URL(request.url).searchParams;
  const itemId = params.get("itemId");
  const offset = Math.max(0, Number(params.get("offset")) || 0);

  let query = createAdminClient()
    .from("market_listings")
    .select(LISTING_COLUMNS)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("price")
    .order("created_at")
    .range(offset, offset + PAGE_SIZE - 1);
  if (itemId) query = query.eq("item_id", itemId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }

  return NextResponse.json({
    listings: (data ?? []).map((r) =>
      toListing(r as Parameters<typeof toListing>[0]),
    ),
  });
}
