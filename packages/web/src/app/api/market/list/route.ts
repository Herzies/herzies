import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { refusal } from "@/lib/market";
import { isParseError, marketListSchema, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Put one copy up on the market board at a fixed price. The copy leaves the
 * bank (market_list, 00126) and waits on the board until someone buys it, the
 * seller cancels, or its 48 hours run out.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, marketListSchema);
  if (isParseError(body)) return body;

  const { data, error } = await createAdminClient().rpc("market_list", {
    p_user_id: auth.userId,
    p_unit_id: body.unitId,
    p_price: body.price,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    listing?: unknown;
    state?: ItemState;
  } | null;

  if (error) {
    return NextResponse.json({ error: "Failed to list" }, { status: 500 });
  }
  if (!result?.ok || !result.state) {
    return refusal(result?.reason, "Failed to list");
  }

  return NextResponse.json({
    ok: true,
    listing: result.listing,
    ...itemResponse(result.state),
  });
}
