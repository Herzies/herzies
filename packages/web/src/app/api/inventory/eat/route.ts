import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { eatItemSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, { status: number; error: string }> = {
  "not-found": { status: 404, error: "Herzie not found" },
  "not-consumable": { status: 400, error: "You can't eat that" },
  "none-left": { status: 400, error: "You don't have any left" },
  down: { status: 400, error: "Your herzie is knocked out" },
  full: { status: 400, error: "Your herzie is already at full health" },
};

/**
 * Eat one consumable from the bank: one copy used up, HP healed (capped at
 * max). eat_item (00113) does both under one lock, refusing while knocked
 * out or already full so nothing is wasted. In a boss fight the Town server
 * holds HP, so the desktop eats through the room there instead.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, eatItemSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("eat_item", {
    p_user_id: auth.userId,
    p_item_id: body.itemId,
    p_apply_hp: true,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    heal?: number;
    vitals?: unknown;
    state?: ItemState;
  } | null;

  if (error) {
    return NextResponse.json({ error: "Failed to eat" }, { status: 500 });
  }
  if (!result?.ok || !result.state) {
    const known = REASONS[result?.reason ?? ""];
    return NextResponse.json(
      { error: known?.error ?? "Failed to eat", reason: result?.reason },
      { status: known?.status ?? 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    heal: result.heal,
    vitals: result.vitals,
    ...itemResponse(result.state),
  });
}
