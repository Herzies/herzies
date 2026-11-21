import {
  isLoadoutIndex,
  type LoadoutState,
  type LoadoutSwitchReport,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { isParseError, parseBody, switchLoadoutSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, string> = {
  "not-found": "Herzie not found",
  invalid: "No such loadout",
  same: "That loadout is already on",
  "too-soon": "Switching too fast",
  // A piece that can't go on any more would land in the bag, with no room.
  "bag-full": "Your bag is full: make room first.",
};

/** Puts the other loadout on (switch_loadout, 00152): what's worn becomes
 * the loadout left, holding its gear, and the other one goes on under the
 * usual equip rules; nothing moves into or out of the bag but the pieces
 * that can't go on. Answers like any inventory change, plus the loadouts and
 * what couldn't go on (`report`); a refusal has `reason` (LoadoutRefusal). */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, switchLoadoutSchema);
  if (isParseError(body)) return body;

  if (!isLoadoutIndex(body.loadout)) {
    return NextResponse.json(
      { error: REASONS.invalid, reason: "invalid" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("switch_loadout", {
    p_user: auth.userId,
    p_to: body.loadout,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    state?: ItemState;
    loadouts?: LoadoutState;
    report?: LoadoutSwitchReport;
  } | null;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!result?.ok || !result.state) {
    const reason = result?.reason ?? "";
    return NextResponse.json(
      { error: REASONS[reason] ?? "Failed to switch loadouts", reason },
      { status: reason === "not-found" ? 404 : 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    ...itemResponse(result.state),
    loadouts: result.loadouts ?? result.state.loadouts,
    report: result.report ?? { missing: [], refused: [] },
  });
}
