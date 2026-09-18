import {
  BANK_SLOT_COUNT,
  bankSlotsUsed,
  normalizeEquipped,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { buyItemSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

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
    .select("inventory_v2, currency, equipped")
    .eq("user_id", auth.userId)
    .single();

  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  const inv = (herzie.inventory_v2 ?? {}) as Record<string, number>;
  const owned = inv[itemId] ?? 0;

  // Duplicates are allowed: items are tradable, so a spare is a legitimate
  // thing to buy. What is not allowed is buying one with nowhere to put it —
  // the bank is a fixed BANK_SLOT_COUNT slots and anything past that simply
  // does not render, so it would be paid for and invisible. This check is the
  // reason the one-per-item rule could be lifted at all.
  const next = { ...inv, [itemId]: owned + quantity };
  if (
    bankSlotsUsed(next, normalizeEquipped(herzie.equipped)) > BANK_SLOT_COUNT
  ) {
    return NextResponse.json(
      { error: "Your bank is full — sell something first" },
      { status: 409 },
    );
  }

  const cost = quantity * (item.buy_price as number);
  const currency = (herzie.currency as number) ?? 0;

  if (currency < cost) {
    return NextResponse.json({ error: "Not enough currency" }, { status: 400 });
  }

  inv[itemId] = owned + quantity;
  const newCurrency = currency - cost;

  const { error } = await admin
    .from("herzies")
    .update({ inventory_v2: inv, currency: newCurrency })
    .eq("user_id", auth.userId);

  if (error) {
    return NextResponse.json({ error: "Failed to buy" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    spent: cost,
    newCurrency,
    inventory: inv,
  });
}
