import {
  bankCapacity,
  bankSlotsUsed,
  normalizeEquipped,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { isParseError, merchantBuySchema, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, { status: number; error: string }> = {
  "not-found": { status: 404, error: "Herzie not found" },
  "not-live": { status: 409, error: "They've packed up and left" },
  "not-sold-here": { status: 400, error: "That isn't for sale here" },
  "sold-out": { status: 409, error: "Sold out" },
  "limit-reached": { status: 409, error: "You've bought as many as you can" },
  "insufficient-funds": { status: 400, error: "Not enough currency" },
  "insufficient-treats": { status: 400, error: "Not enough treats" },
  "bad-quantity": { status: 400, error: "Invalid quantity" },
};

/**
 * Buy from a visiting merchant: Good ol' George (coins) or Nandor the
 * Treatless (treats — the RPC takes payment by event type). Same shape as
 * /api/inventory/buy, but the price and limits come from the live event
 * rather than the catalog. `newCurrency` is absent when paid in treats.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, merchantBuySchema);
  if (isParseError(body)) return body;

  const { eventId, itemId, quantity } = body;

  const admin = createAdminClient();

  const { data: herzie } = await admin
    .from("herzies")
    .select("inventory_v2, equipped, bank_expansions")
    .eq("user_id", auth.userId)
    .single();

  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  // Same bank-space rule as /api/inventory/buy, for the same reason: a copy
  // past the bank's capacity would be paid for and never render. Treats spent
  // are not counted as freed: the check stays conservative by one tile at
  // most, when a purchase uses up the last of them.
  const inv = (herzie.inventory_v2 ?? {}) as Record<string, number>;
  const next = { ...inv, [itemId]: (inv[itemId] ?? 0) + quantity };
  if (
    bankSlotsUsed(next, normalizeEquipped(herzie.equipped)) >
    bankCapacity(herzie.bank_expansions)
  ) {
    return NextResponse.json(
      { error: "Your bank is full — sell something first" },
      { status: 409 },
    );
  }

  const { data, error } = await admin.rpc("buy_from_merchant", {
    p_user_id: auth.userId,
    p_event_id: eventId,
    p_item_id: itemId,
    p_quantity: quantity,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    spent?: number;
    newCurrency?: number | null;
    state?: ItemState;
  } | null;

  if (error) {
    return NextResponse.json({ error: "Failed to buy" }, { status: 500 });
  }
  if (!result?.ok || !result.state) {
    const known = REASONS[result?.reason ?? ""];
    return NextResponse.json(
      { error: known?.error ?? "Failed to buy", reason: result?.reason },
      { status: known?.status ?? 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    spent: result.spent,
    ...(result.newCurrency != null ? { newCurrency: result.newCurrency } : {}),
    ...itemResponse(result.state),
  });
}
