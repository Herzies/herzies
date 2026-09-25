import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import {
  type ItemState,
  itemResponse,
  loadUnits,
  unitsForLegacyCount,
} from "@/lib/item-units";
import { isParseError, parseBody, sellItemSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, { status: number; error: string }> = {
  "not-found": { status: 404, error: "Herzie not found" },
  "not-sellable": { status: 400, error: "Item cannot be sold" },
  "not-enough": { status: 400, error: "Not enough items" },
};

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, sellItemSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();

  // Named copies, or — from a client that only knew item ids — "N of this
  // item", which we resolve to the plainest copies so a spare goes before one
  // you've upgraded or are wearing.
  let unitIds: string[];
  if ("unitIds" in body) {
    unitIds = body.unitIds;
  } else {
    const picked = unitsForLegacyCount(
      await loadUnits(admin, auth.userId),
      body.itemId,
      body.quantity,
    );
    if (!picked) {
      return NextResponse.json(
        { error: REASONS["not-enough"].error },
        { status: 400 },
      );
    }
    unitIds = picked;
  }

  // One locked transaction: ownership, price, coins and removal together. This
  // used to be a read, a computation here, and a separate write — two racing
  // sells could both read the same inventory and the second write clobber the
  // first. The rules live in sell_units (00079_item_units.sql); the desktop
  // predicts the same result with applySell in @herzies/shared.
  const { data, error } = await admin.rpc("sell_units", {
    p_user_id: auth.userId,
    p_unit_ids: unitIds,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    earned?: number;
    newCurrency?: number;
    state?: ItemState;
  } | null;

  if (error) {
    return NextResponse.json({ error: "Failed to sell" }, { status: 500 });
  }
  if (!result?.ok || !result.state) {
    const known = REASONS[result?.reason ?? ""];
    return NextResponse.json(
      { error: known?.error ?? "Failed to sell" },
      { status: known?.status ?? 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    earned: result.earned,
    newCurrency: result.newCurrency,
    ...itemResponse(result.state),
  });
}
