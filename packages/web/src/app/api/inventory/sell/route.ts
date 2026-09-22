import { applySell, normalizeEquipped } from "@herzies/shared";
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

  // Fetch player's inventory, currency, equip state, and dice-upgrade levels
  const { data: herzie } = await admin
    .from("herzies")
    .select("inventory_v2, currency, equipped, item_upgrades")
    .eq("user_id", auth.userId)
    .single();

  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  // The sale rules live in @herzies/shared so the desktop client can predict
  // this exact result optimistically (see handleSell in InventoryView).
  const outcome = applySell(
    (herzie.inventory_v2 ?? {}) as Record<string, number>,
    (herzie.currency as number) ?? 0,
    normalizeEquipped(herzie.equipped),
    itemId,
    quantity,
    item.sell_price as number,
    (herzie.item_upgrades ?? {}) as Record<string, number>,
  );

  if (!outcome.ok) {
    const messages: Record<typeof outcome.reason, string> = {
      "not-sellable": "Item cannot be sold",
      "not-enough": "Not enough items",
    };
    return NextResponse.json(
      { error: messages[outcome.reason] },
      { status: 400 },
    );
  }

  const { earned, newCurrency, inventory, equipped, itemUpgrades } = outcome;

  const { error } = await admin
    .from("herzies")
    .update({
      inventory_v2: inventory,
      currency: newCurrency,
      equipped,
      item_upgrades: itemUpgrades,
    })
    .eq("user_id", auth.userId);

  if (error) {
    return NextResponse.json({ error: "Failed to sell" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    earned,
    newCurrency,
    inventory,
    equipped,
    itemUpgrades,
  });
}
