import { findEquippedSlot, normalizeEquipped } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { isParseError, parseBody, sellItemSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, sellItemSchema);
  if (isParseError(body)) return body;

  const { itemId, quantity } = body;

  const admin = createAdminClient();

  // Fetch item catalog entry
  const { data: item } = await admin
    .from("items")
    .select("id, sell_price, stackable")
    .eq("id", itemId)
    .single();

  if (!item?.sell_price) {
    return NextResponse.json({ error: "Item cannot be sold" }, { status: 400 });
  }

  // Fetch player's inventory, currency, and equip state
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

  if (owned < quantity) {
    return NextResponse.json({ error: "Not enough items" }, { status: 400 });
  }

  // Update inventory and currency
  const newQty = owned - quantity;
  let equipped = normalizeEquipped(herzie.equipped);
  if (newQty > 0) {
    inv[itemId] = newQty;
  } else {
    delete inv[itemId];
    // Selling the last copy of an equipped item can't leave it equipped —
    // unequip it in the same request so ownership and equip state never
    // drift apart.
    const slot = findEquippedSlot(equipped, itemId);
    if (slot) {
      equipped = { ...equipped };
      delete equipped[slot];
    }
  }

  const earned = quantity * (item.sell_price as number);
  const newCurrency = ((herzie.currency as number) ?? 0) + earned;

  const { error } = await admin
    .from("herzies")
    .update({ inventory_v2: inv, currency: newCurrency, equipped })
    .eq("user_id", auth.userId);

  if (error) {
    return NextResponse.json({ error: "Failed to sell" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    earned,
    newCurrency,
    inventory: inv,
    equipped,
  });
}
