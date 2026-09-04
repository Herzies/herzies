import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { equipItemSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";
import {
  type Equipped,
  type EquippedSlot,
  findEquippedSlot,
  groundSlot,
  isModifierEquipped,
  normalizeEquipped,
} from "@herzies/shared";

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
  let updated: Equipped;

  if (action === "equip") {
    if ((inv[itemId] ?? 0) < 1) {
      return NextResponse.json(
        { error: "Item not in inventory" },
        { status: 400 },
      );
    }

    const existingSlot = findEquippedSlot(current, itemId);
    if (existingSlot || isModifierEquipped(current, itemId)) {
      return NextResponse.json({ error: "Already equipped" }, { status: 400 });
    }

    updated = { ...current };

    if (item.equip_slot === "ground") {
      if (side !== "left" && side !== "right") {
        return NextResponse.json(
          { error: "side (left|right) is required for ground items" },
          { status: 400 },
        );
      }
      const target = groundSlot(side);
      updated[target] = itemId;
    } else if (item.equip_slot === "modifier") {
      // Unlimited — accumulate rather than occupy a single-value slot.
      updated.modifier = [...(current.modifier ?? []), itemId];
    } else if (item.equip_slot) {
      const slot = item.equip_slot as EquippedSlot;
      updated[slot] = itemId;
    } else {
      // Equipable with no slot — treat as unique by id only (no dedicated key).
      return NextResponse.json(
        { error: "Item has no equip slot" },
        { status: 400 },
      );
    }
  } else {
    const slot = findEquippedSlot(current, itemId);
    if (!slot && !isModifierEquipped(current, itemId)) {
      return NextResponse.json({ error: "Item not equipped" }, { status: 400 });
    }
    updated = { ...current };
    if (slot) {
      delete updated[slot];
    } else {
      updated.modifier = (current.modifier ?? []).filter((id) => id !== itemId);
    }
  }

  const { error } = await admin
    .from("herzies")
    .update({ equipped: updated })
    .eq("user_id", auth.userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, equipped: updated });
}
