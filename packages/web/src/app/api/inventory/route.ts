import { normalizeEquipped } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { loadUnits } from "@/lib/item-units";
import { createAdminClient } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("herzies")
    .select("inventory_v2, currency, equipped, item_upgrades")
    .eq("user_id", auth.userId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  const inventory: Record<string, number> = data.inventory_v2 ?? {};

  // Fetch item details for all owned items
  const itemIds = Object.keys(inventory).filter((id) => inventory[id] > 0);
  const { data: items } = await admin
    .from("items")
    .select("*")
    .in("id", itemIds.length > 0 ? itemIds : ["__none__"]);

  return NextResponse.json({
    // Every owned copy, with its own upgrade level and worn slot. The three
    // id-keyed fields below are derived from these, kept for older clients.
    units: await loadUnits(admin, auth.userId),
    inventory,
    currency: data.currency ?? 0,
    items: items ?? [],
    equipped: normalizeEquipped(data.equipped),
    itemUpgrades: (data.item_upgrades ?? {}) as Record<string, number>,
  });
}
