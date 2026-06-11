import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { isParseError, parseBody, tradeIdSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, tradeIdSchema);
  if (isParseError(body)) return body;

  const { tradeId } = body;

  const admin = createAdminClient();

  const { data: trade } = await admin
    .from("trades")
    .select("*")
    .eq("id", tradeId)
    .single();

  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  const isInitiator = trade.initiator_id === auth.userId;
  const isTarget = trade.target_id === auth.userId;

  if (!isInitiator && !isTarget) {
    return NextResponse.json({ error: "Not your trade" }, { status: 403 });
  }

  if (trade.state !== "both_locked") {
    return NextResponse.json(
      { error: "Both sides must be locked before accepting" },
      { status: 400 },
    );
  }

  // Set this player's accepted flag
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    // Keep the trade alive while waiting for the partner's accept.
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };

  if (isInitiator) {
    update.initiator_accepted = true;
  } else {
    update.target_accepted = true;
  }

  await admin.from("trades").update(update).eq("id", tradeId);

  // Check if both have now accepted
  const otherAccepted = isInitiator
    ? (trade.target_accepted as boolean)
    : (trade.initiator_accepted as boolean);

  if (otherAccepted) {
    // Both accepted — execute the trade atomically
    const { data: result } = await admin.rpc("execute_trade", {
      trade_id: tradeId,
    });

    if (!result) {
      return NextResponse.json(
        { error: "Trade execution failed — items may have changed" },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, completed: true });
  }

  return NextResponse.json({ ok: true, completed: false });
}
