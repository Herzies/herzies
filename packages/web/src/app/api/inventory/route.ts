import { normalizeEquipped } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { loadLoadouts, loadUnits } from "@/lib/item-units";
import { createAdminClient } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("herzies")
    .select(
      "inventory_v2, currency, equipped, item_upgrades, bank_expansions, emotes",
    )
    .eq("user_id", auth.userId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  const inventory: Record<string, number> = data.inventory_v2 ?? {};

  const [units, loadouts] = await Promise.all([
    loadUnits(admin, auth.userId),
    loadLoadouts(admin, auth.userId),
  ]);

  // Details for every owned item: the units too, since `inventory` leaves out
  // copies put away in the other loadout (00152), which are still owned.
  const itemIds = [
    ...new Set([
      ...Object.keys(inventory).filter((id) => inventory[id] > 0),
      ...units.map((u) => u.itemId),
    ]),
  ];
  const { data: items } = await admin
    .from("items")
    .select("*")
    .in("id", itemIds.length > 0 ? itemIds : ["__none__"]);

  return NextResponse.json({
    // Every owned copy, with its own upgrade level and worn slot. The three
    // id-keyed fields below are derived from these, kept for older clients.
    units,
    inventory,
    currency: data.currency ?? 0,
    items: items ?? [],
    equipped: normalizeEquipped(data.equipped),
    itemUpgrades: (data.item_upgrades ?? {}) as Record<string, number>,
    // Capacity has to arrive with the contents: the desktop judges "inventory
    // full" from both, and loads this one before any /sync has run.
    bankExpansions: data.bank_expansions ?? 0,
    // Emotes owned (EMOTES ids): unlocked for good, played from the Alt bar.
    emotes: (data.emotes ?? []) as string[],
    // The two loadouts (00152): which is worn, and the other one's pieces.
    loadouts,
  });
}
