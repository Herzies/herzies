import { getItem } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { isParseError, parseBody, upgradeItemSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, upgradeItemSchema);
  if (isParseError(body)) return body;

  const { diceItemId, targetItemId } = body;

  // "Is this a dice" and "is this a statted card" can only be checked
  // against the TS catalog — the DB `items` table has no `stats` column at
  // all. apply_item_upgrade (the RPC) re-checks ownership and the level cap
  // under a row lock; it does NOT re-check either of these, since it can't.
  const diceDef = getItem(diceItemId);
  if (!diceDef?.dice) {
    return NextResponse.json({ error: "Not a dice item" }, { status: 400 });
  }
  const targetDef = getItem(targetItemId);
  if (!targetDef?.stats || Object.keys(targetDef.stats).length === 0) {
    return NextResponse.json(
      { error: "Target card has no stats to upgrade" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("apply_item_upgrade", {
    p_user_id: auth.userId,
    p_dice_item_id: diceItemId,
    p_target_item_id: targetItemId,
  });

  const row = (data ?? [])[0] as
    | { ok: boolean; reason: string | null; new_level: number | null }
    | undefined;

  if (error || !row?.ok) {
    const messages: Record<string, string> = {
      "not-found": "Herzie not found",
      "dice-not-owned": "You don't have that dice",
      "target-not-owned": "You don't own that card",
      "max-level": "That card is already fully upgraded",
    };
    return NextResponse.json(
      { error: messages[row?.reason ?? ""] ?? "Upgrade failed" },
      { status: 400 },
    );
  }

  // Re-fetch the authoritative inventory/item_upgrades so the response
  // shape matches /api/inventory's, rather than hand-reconstructing it here.
  const { data: herzie } = await admin
    .from("herzies")
    .select("inventory_v2, item_upgrades")
    .eq("user_id", auth.userId)
    .single();

  return NextResponse.json({
    ok: true,
    newLevel: row.new_level,
    inventory: (herzie?.inventory_v2 ?? {}) as Record<string, number>,
    itemUpgrades: (herzie?.item_upgrades ?? {}) as Record<string, number>,
  });
}
