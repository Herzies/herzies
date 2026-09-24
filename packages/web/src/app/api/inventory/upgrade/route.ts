import { getItem } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import {
  type ItemState,
  itemResponse,
  loadUnits,
  unitForLegacyUpgrade,
} from "@/lib/item-units";
import { isParseError, parseBody, upgradeItemSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, string> = {
  "not-found": "Herzie not found",
  "dice-not-owned": "You don't have that dice",
  "target-not-owned": "You don't own that card",
  "max-level": "That card is already fully upgraded",
};

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, upgradeItemSchema);
  if (isParseError(body)) return body;

  const { diceItemId } = body;

  // "Is this a dice" and "is this a statted card" can only be checked
  // against the TS catalog — the DB `items` table has no `stats` column at
  // all. apply_item_upgrade (the RPC) re-checks ownership and the level cap
  // under a row lock; it does NOT re-check either of these, since it can't.
  const diceDef = getItem(diceItemId);
  if (!diceDef?.dice) {
    return NextResponse.json({ error: "Not a dice item" }, { status: 400 });
  }

  const admin = createAdminClient();
  const units = await loadUnits(admin, auth.userId);

  // One named copy, or — from a client that only knew item ids — an item id,
  // which we resolve to the copy furthest along that can still take a level.
  let targetUnitId: string;
  let targetItemId: string;
  if ("targetUnitId" in body) {
    const target = units.find((u) => u.id === body.targetUnitId);
    if (!target) {
      return NextResponse.json(
        { error: REASONS["target-not-owned"] },
        { status: 400 },
      );
    }
    targetUnitId = target.id;
    targetItemId = target.itemId;
  } else {
    targetItemId = body.targetItemId;
    const target = unitForLegacyUpgrade(units, targetItemId);
    if (!target) {
      // Either not owned, or every copy is already maxed — say which.
      const owned = units.some((u) => u.itemId === targetItemId);
      return NextResponse.json(
        {
          error: owned ? REASONS["max-level"] : REASONS["target-not-owned"],
        },
        { status: 400 },
      );
    }
    targetUnitId = target.id;
  }

  const targetDef = getItem(targetItemId);
  if (!targetDef?.stats || Object.keys(targetDef.stats).length === 0) {
    return NextResponse.json(
      { error: "Target card has no stats to upgrade" },
      { status: 400 },
    );
  }

  // Raises ONE copy's level and consumes one die, atomically. Its twin — a
  // second copy of the same card — is untouched; that is the point.
  const { data, error } = await admin.rpc("apply_item_upgrade", {
    p_user_id: auth.userId,
    p_dice_item_id: diceItemId,
    p_target_unit_id: targetUnitId,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    newLevel?: number;
    state?: ItemState;
  } | null;

  if (error || !result?.ok || !result.state) {
    return NextResponse.json(
      { error: REASONS[result?.reason ?? ""] ?? "Upgrade failed" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    newLevel: result.newLevel,
    ...itemResponse(result.state),
  });
}
