import {
  applyEquip,
  type EquipRejection,
  type EquipSlot,
  normalizeEquipped,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { equipItemSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, equipItemSchema);
  if (isParseError(body)) return body;

  const { itemId, action, side } = body;

  const admin = createAdminClient();

  // Verify item is equipable
  const { data: item } = await admin
    .from("items")
    .select("id, equipable, equip_slot")
    .eq("id", itemId)
    .single();

  if (!item || !item.equipable) {
    return NextResponse.json(
      { error: "Item is not equipable" },
      { status: 400 },
    );
  }

  // Fetch player data
  const { data: herzie } = await admin
    .from("herzies")
    .select("inventory_v2, equipped")
    .eq("user_id", auth.userId)
    .single();

  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  const inv = (herzie.inventory_v2 ?? {}) as Record<string, number>;
  const current = normalizeEquipped(herzie.equipped);

  // Ownership is the one rule applyEquip can't check — it only sees Equipped.
  if (action === "equip" && (inv[itemId] ?? 0) < 1) {
    return NextResponse.json(
      { error: "Item not in inventory" },
      { status: 400 },
    );
  }

  // The slot rules themselves live in @herzies/shared so the desktop client can
  // predict this exact result optimistically (see useOptimisticEquipped).
  const outcome = applyEquip(
    current,
    itemId,
    action,
    (item.equip_slot ?? undefined) as EquipSlot | undefined,
    side,
  );

  if (!outcome.ok) {
    const messages: Record<EquipRejection, string> = {
      "already-equipped": "Already equipped",
      "not-equipped": "Item not equipped",
      "max-modifiers": "Maximum modifiers equipped",
      "missing-side": "side (left|right) is required for ground items",
      // Equipable with no slot — treat as unique by id only (no dedicated key).
      "no-slot": "Item has no equip slot",
    };
    return NextResponse.json(
      { error: messages[outcome.reason] },
      { status: 400 },
    );
  }

  const updated = outcome.equipped;

  const { error } = await admin
    .from("herzies")
    .update({ equipped: updated })
    .eq("user_id", auth.userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, equipped: updated });
}
