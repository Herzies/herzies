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
    .select("inventory_v2, currency")
    .eq("user_id", auth.userId)
    .single();

  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  const inv = (herzie.inventory_v2 ?? {}) as Record<string, number>;
  const owned = inv[itemId] ?? 0;

  if (!item.stackable && (quantity > 1 || owned > 0)) {
    return NextResponse.json(
      { error: "You already own this item" },
      { status: 400 },
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
