import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { fitsInBank, loadStall, refusal } from "@/lib/market";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Collect everything waiting at the market board: coins from sales (less the
 * market's cut), and copies that didn't sell. When the bank has no room for
 * the copies, the coins still come and the copies keep waiting.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();

  const stall = await loadStall(admin, auth.userId);
  const returning: Record<string, number> = {};
  for (const l of stall.uncollected) {
    if (l.status === "sold") continue;
    returning[l.itemId] = (returning[l.itemId] ?? 0) + 1;
  }
  const fits = await fitsInBank(admin, auth.userId, returning);
  if (fits === null) return refusal("not-found", "Failed to collect");

  const { data, error } = await admin.rpc("market_collect", {
    p_user_id: auth.userId,
    p_take_items: fits,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    coins?: number;
    items?: number;
    newCurrency?: number;
    state?: ItemState;
  } | null;

  if (error) {
    return NextResponse.json({ error: "Failed to collect" }, { status: 500 });
  }
  if (!result?.ok || !result.state) {
    return refusal(result?.reason, "Failed to collect");
  }

  return NextResponse.json({
    ok: true,
    coins: result.coins,
    items: result.items,
    // Copies left waiting because the bank was full.
    itemsLeft: fits ? 0 : stall.itemsWaiting,
    newCurrency: result.newCurrency,
    ...itemResponse(result.state),
  });
}
