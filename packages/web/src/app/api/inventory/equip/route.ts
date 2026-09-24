import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import {
  type ItemState,
  itemResponse,
  loadUnits,
  unitForLegacyEquip,
  unitForLegacyUnequip,
} from "@/lib/item-units";
import { equipItemSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, string> = {
  "not-found": "Herzie not found",
  "not-owned": "Item not in inventory",
  "already-equipped": "Already equipped",
  "not-equipped": "Item not equipped",
  "max-modifiers": "Maximum modifiers equipped",
  "missing-side": "side (left|right) is required for ground items",
  "no-slot": "Item is not equipable",
  "bad-action": "Invalid action",
};

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, equipItemSchema);
  if (isParseError(body)) return body;

  const { action, side } = body;

  const admin = createAdminClient();

  // One named copy, or — from a client that only knew item ids — an item id,
  // which we resolve to the copy it most plausibly means.
  let unitId: string;
  if ("unitId" in body) {
    unitId = body.unitId;
  } else {
    const units = await loadUnits(admin, auth.userId);
    const unit =
      action === "equip"
        ? unitForLegacyEquip(units, body.itemId)
        : unitForLegacyUnequip(units, body.itemId);
    if (!unit) {
      return NextResponse.json(
        {
          error:
            action === "equip" ? REASONS["not-owned"] : REASONS["not-equipped"],
        },
        { status: 400 },
      );
    }
    unitId = unit.id;
  }

  // One locked transaction. Wearing a copy of an item whose other copy is worn
  // swaps them, and equipping into an occupied slot displaces the incumbent —
  // the same rules applyEquip in @herzies/shared uses to predict the result.
  const { data, error } = await admin.rpc("equip_unit", {
    p_user_id: auth.userId,
    p_unit_id: unitId,
    p_action: action,
    p_side: side ?? null,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    state?: ItemState;
  } | null;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!result?.ok || !result.state) {
    return NextResponse.json(
      { error: REASONS[result?.reason ?? ""] ?? "Failed to equip" },
      { status: result?.reason === "not-found" ? 404 : 400 },
    );
  }

  return NextResponse.json({ ok: true, ...itemResponse(result.state) });
}
