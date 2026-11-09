import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { fitsInBank, refusal } from "@/lib/market";
import { isParseError, marketBuySchema, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Buy a listing off the market board, or `quantity` copies of a stack whose
 * price splits evenly. The buyer pays now and gets the copies now; the
 * seller's coins wait at the board (market_buy, 00146).
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, marketBuySchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();

  const { data: listing } = await admin
    .from("market_listings")
    .select("item_id, quantity")
    .eq("id", body.listingId)
    .maybeSingle();
  if (!listing) return refusal("gone", "Failed to buy");

  // Same bank-space rule as the NPC shops: a copy past the bank's capacity
  // would be paid for and never render.
  const fits = await fitsInBank(admin, auth.userId, {
    [listing.item_id]: Math.min(
      body.quantity ?? listing.quantity,
      listing.quantity,
    ),
  });
  if (fits === null) return refusal("not-found", "Failed to buy");
  if (!fits) {
    return NextResponse.json(
      { error: "Your bank is full — sell something first" },
      { status: 409 },
    );
  }

  const { data, error } = await admin.rpc("market_buy", {
    p_user_id: auth.userId,
    p_listing_id: body.listingId,
    p_quantity: body.quantity ?? null,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    spent?: number;
    quantity?: number;
    newCurrency?: number;
    listing?: unknown;
    state?: ItemState;
  } | null;

  if (error) {
    return NextResponse.json({ error: "Failed to buy" }, { status: 500 });
  }
  if (!result?.ok || !result.state) {
    return refusal(result?.reason, "Failed to buy");
  }

  return NextResponse.json({
    ok: true,
    spent: result.spent,
    quantity: result.quantity,
    newCurrency: result.newCurrency,
    listing: result.listing,
    ...itemResponse(result.state),
  });
}
