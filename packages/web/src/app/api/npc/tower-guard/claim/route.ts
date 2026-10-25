import {
  bankCapacity,
  bankSlotsUsed,
  normalizeEquipped,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, { status: number; error: string }> = {
  "not-found": { status: 404, error: "Herzie not found" },
  "nothing-to-claim": { status: 400, error: "Nothing to claim" },
};

/**
 * The Tower Guard pays a month's best climber (claim_tower_reward, 00121):
 * the oldest Tower they won and weren't paid for, once each.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();

  const [{ data: herzie }, { data: guard }] = await Promise.all([
    admin
      .from("herzies")
      .select("inventory_v2, equipped, bank_expansions")
      .eq("user_id", auth.userId)
      .single(),
    admin.rpc("tower_guard_json", { p_user: auth.userId }),
  ]);
  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  // Same bank-space rule as the shops: a copy past the bank's capacity
  // would never render.
  const itemId = (guard as { reward?: { itemId?: string | null } } | null)
    ?.reward?.itemId;
  if (itemId) {
    const inv = (herzie.inventory_v2 ?? {}) as Record<string, number>;
    const next = { ...inv, [itemId]: (inv[itemId] ?? 0) + 1 };
    if (
      bankSlotsUsed(next, normalizeEquipped(herzie.equipped)) >
      bankCapacity(herzie.bank_expansions)
    ) {
      return NextResponse.json(
        { error: "Your bank is full — sell something first" },
        { status: 409 },
      );
    }
  }

  const { data, error } = await admin.rpc("claim_tower_reward", {
    p_user: auth.userId,
  });
  if (error) {
    return NextResponse.json({ error: "Failed to claim" }, { status: 500 });
  }
  const result = data as {
    ok: boolean;
    reason?: string;
    itemId?: string;
    state?: ItemState;
  } | null;
  if (!result?.ok || !result.state) {
    const known = REASONS[result?.reason ?? ""];
    return NextResponse.json(
      { error: known?.error ?? "Failed to claim", reason: result?.reason },
      { status: known?.status ?? 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    itemId: result.itemId,
    ...itemResponse(result.state),
  });
}
