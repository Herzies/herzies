import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const tradeId = searchParams.get("tradeId");

  if (!tradeId) {
    return NextResponse.json({ error: "Missing tradeId" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Expire stale trades
  await admin.rpc("expire_stale_trades");

  const { data: trade } = await admin
    .from("trades")
    .select("*")
    .eq("id", tradeId)
    .single();

  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  if (trade.initiator_id !== auth.userId && trade.target_id !== auth.userId) {
    return NextResponse.json({ error: "Not your trade" }, { status: 403 });
  }

  // Look up names for both parties
  const { data: initiator } = await admin
    .from("herzies")
    .select("name, friend_code")
    .eq("user_id", trade.initiator_id)
    .single();

  const { data: target } = await admin
    .from("herzies")
    .select("name, friend_code")
    .eq("user_id", trade.target_id)
    .single();

  return NextResponse.json({
    trade: {
      id: trade.id,
      initiatorId: trade.initiator_id,
      targetId: trade.target_id,
      initiatorName: initiator?.name ?? "Unknown",
      targetName: target?.name ?? "Unknown",
      initiatorOffer: trade.initiator_offer,
      targetOffer: trade.target_offer,
      state: trade.state,
      initiatorAccepted: trade.initiator_accepted,
      targetAccepted: trade.target_accepted,
      createdAt: trade.created_at,
      expiresAt: trade.expires_at,
    },
  });
}
