import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { refusal } from "@/lib/market";
import { isParseError, marketListingSchema, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Take a listing off the board. The copy doesn't come straight back: it waits
 * at the board with everything else, for /api/market/collect.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, marketListingSchema);
  if (isParseError(body)) return body;

  const { data, error } = await createAdminClient().rpc("market_cancel", {
    p_user_id: auth.userId,
    p_listing_id: body.listingId,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    listing?: unknown;
  } | null;

  if (error) {
    return NextResponse.json({ error: "Failed to cancel" }, { status: 500 });
  }
  if (!result?.ok) return refusal(result?.reason, "Failed to cancel");

  return NextResponse.json({ ok: true, listing: result.listing });
}
