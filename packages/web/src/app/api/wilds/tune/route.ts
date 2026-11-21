import {
  TUNABLE_INSTRUMENTS,
  TUNING_MAX_LEVEL,
  tuningCost,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse, loadUnits } from "@/lib/item-units";
import { isParseError, parseBody, wildsTuneSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, string> = {
  "not-found": "Herzie not found",
  "not-owned": "You don't own that card",
  "not-tunable": "Only class instruments can be tuned",
  "max-level": `Tuning only goes to +${TUNING_MAX_LEVEL}. Power Dice take it from there`,
  changed: "That instrument just changed. Try again",
  "not-enough-bits": "You don't have enough bits for that",
};

/**
 * Tunes one copy of a class instrument (or its Wilds build) up a level for
 * bits: never fails, never breaks it, up to TUNING_MAX_LEVEL. Worn or not.
 * The price is tuningCost at the copy's level as read here; wilds_tune
 * (00154) takes it under the herzie's row lock, and refuses ('changed') if
 * the level moved in between, so the wrong price is never charged.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, wildsTuneSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();
  const unit = (await loadUnits(admin, auth.userId)).find(
    (u) => u.id === body.unitId,
  );
  const fail = (reason: string) =>
    NextResponse.json(
      { error: REASONS[reason] ?? "Tuning failed" },
      { status: 400 },
    );
  if (!unit) return fail("not-owned");
  if (!TUNABLE_INSTRUMENTS.includes(unit.itemId)) return fail("not-tunable");
  const cost = tuningCost(unit.upgradeLevel);
  if (!cost || unit.upgradeLevel >= TUNING_MAX_LEVEL) return fail("max-level");

  const { data, error } = await admin.rpc("wilds_tune", {
    p_user: auth.userId,
    p_unit: unit.id,
    p_tunable: TUNABLE_INSTRUMENTS,
    p_cap: TUNING_MAX_LEVEL,
    p_level: unit.upgradeLevel,
    p_bits: cost,
  });
  if (error) {
    return NextResponse.json({ error: "Tuning failed" }, { status: 500 });
  }

  const result = data as {
    ok: boolean;
    reason?: string;
    newLevel?: number;
    state?: ItemState;
  } | null;
  if (!result?.ok || !result.state || result.newLevel === undefined) {
    return fail(result?.reason ?? "");
  }

  return NextResponse.json({
    ok: true,
    newLevel: result.newLevel,
    ...itemResponse(result.state),
  });
}
