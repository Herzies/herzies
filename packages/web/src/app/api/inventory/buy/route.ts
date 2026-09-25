import {
  BANK_SLOT_COUNT,
  bankSlotsUsed,
  normalizeEquipped,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { buyItemSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, { status: number; error: string }> = {
  "not-found": { status: 404, error: "Herzie not found" },
  "not-for-sale": { status: 400, error: "Item cannot be bought" },
  "insufficient-funds": { status: 400, error: "Not enough currency" },
  "bad-quantity": { status: 400, error: "Invalid quantity" },
};

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, buyItemSchema);
  if (isParseError(body)) return body;

  const { itemId, quantity } = body;

  const admin = createAdminClient();

  const { data: item } = await admin
    .from("items")
    .select("id, buy_price, stackable")
    .eq("id", itemId)
    .single();

  if (!item?.buy_price) {
    return NextResponse.json(
      { error: "Item cannot be bought" },
      { status: 400 },
    );
  }

  const { data: herzie } = await admin
    .from("herzies")
    .select("inventory_v2, equipped")
    .eq("user_id", auth.userId)
    .single();

  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  const inv = (herzie.inventory_v2 ?? {}) as Record<string, number>;

  // Duplicates are allowed: items are tradable, so a spare is a legitimate
  // thing to buy. What is not allowed is buying one with nowhere to put it —
  // the bank is a fixed BANK_SLOT_COUNT slots and anything past that simply
  // does not render, so it would be paid for and invisible. This check is the
  // reason the one-per-item rule could be lifted at all.
  //
  // It stays here rather than in the RPC because slot counting lives in
  // @herzies/shared — one implementation, not a second copy in SQL to drift.
  const next = { ...inv, [itemId]: (inv[itemId] ?? 0) + quantity };
  if (
    bankSlotsUsed(next, normalizeEquipped(herzie.equipped)) > BANK_SLOT_COUNT
  ) {
    return NextResponse.json(
      { error: "Your bank is full — sell something first" },
      { status: 409 },
    );
  }

  // Price, funds check, charge and the new copies in one locked transaction.
  // This was a read followed by a separate write, so two racing buys could
  // both see the same balance and both spend it.
  const { data, error } = await admin.rpc("buy_item_units", {
    p_user_id: auth.userId,
    p_item_id: itemId,
    p_quantity: quantity,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    spent?: number;
    newCurrency?: number;
    state?: ItemState;
  } | null;

  if (error) {
    return NextResponse.json({ error: "Failed to buy" }, { status: 500 });
  }
  if (!result?.ok || !result.state) {
    const known = REASONS[result?.reason ?? ""];
    return NextResponse.json(
      { error: known?.error ?? "Failed to buy" },
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
