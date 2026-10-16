import {
  bankCapacity,
  bankSlotsUsed,
  normalizeEquipped,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { isParseError, medeaBuySchema, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, { status: number; error: string }> = {
  "not-found": { status: 404, error: "Herzie not found" },
  "not-sold-here": { status: 400, error: "Medea doesn't sell that" },
  "insufficient-funds": { status: 400, error: "Not enough currency" },
  "bad-quantity": { status: 400, error: "Invalid quantity" },
};

/**
 * Buy sweets and potions from Medea, who's always in Town. Boboku's route
 * with her own price list, in buy_from_medea (00113), mirroring MEDEA_STOCK.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, medeaBuySchema);
  if (isParseError(body)) return body;

  const { itemId, quantity } = body;

  const admin = createAdminClient();

  const { data: herzie } = await admin
    .from("herzies")
    .select("inventory_v2, equipped, bank_expansions")
    .eq("user_id", auth.userId)
    .single();

  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  // Same bank-space rule as the merchant: a copy past the bank's capacity
  // would be paid for and never render.
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

  const { data, error } = await admin.rpc("buy_from_medea", {
    p_user_id: auth.userId,
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
    newCurrency: result.newCurrency,
    ...itemResponse(result.state),
  });
}
