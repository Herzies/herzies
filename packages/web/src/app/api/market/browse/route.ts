import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { LISTING_COLUMNS, toListing } from "@/lib/market";
import { createAdminClient } from "@/lib/supabase-admin";

const PAGE_SIZE = 50;
/** The most items one search can ask for: about the whole catalog. */
const MAX_ITEM_IDS = 100;

/**
 * What's for sale on the market board, cheapest first. `?itemId=` narrows it
 * to one item, `?itemIds=a,b,c` to several (a search, matched to items on the
 * client); `?offset=` pages.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const params = new URL(request.url).searchParams;
  const itemIds = [
    params.get("itemId"),
    ...(params.get("itemIds")?.split(",") ?? []),
  ]
    .map((id) => id?.trim())
    .filter((id): id is string => !!id)
    .slice(0, MAX_ITEM_IDS);
  const offset = Math.max(0, Number(params.get("offset")) || 0);

  let query = createAdminClient()
    .from("market_listings")
    .select(LISTING_COLUMNS)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("price")
    .order("created_at")
    .range(offset, offset + PAGE_SIZE - 1);
  if (itemIds.length > 0) query = query.in("item_id", itemIds);

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
