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

  // This is the hottest route in the app — TradeView polls it every 650ms per
  // open trade, and deliberately keeps polling while the window is blurred so
  // partner lock/accept stays instant. It used to open with
  // expire_stale_trades(), a write, on every one of those polls.
  //
  // The sweep runs on pg_cron now (00057_expire_stale_trades_cron.sql), and
  // expiry is derived below instead. Same observable result: the client treats
  // "cancelled" as terminal and stops polling, which is exactly what it did
  // when the sweep flipped the row mid-request.
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

  // Look up names for both parties. Independent queries, so issue them
  // together rather than paying two serial round trips 92 times a minute.
  const [{ data: initiator }, { data: target }] = await Promise.all([
    admin
      .from("herzies")
      .select("name, friend_code")
      .eq("user_id", trade.initiator_id)
      .single(),
    admin
      .from("herzies")
      .select("name, friend_code")
      .eq("user_id", trade.target_id)
      .single(),
  ]);

  // A trade past its expiry is cancelled, whether or not the sweep has run.
  const TERMINAL = ["completed", "cancelled"];
  const state =
    !TERMINAL.includes(trade.state) &&
    new Date(trade.expires_at).getTime() <= Date.now()
      ? "cancelled"
      : trade.state;

  return NextResponse.json({
    trade: {
      id: trade.id,
      initiatorId: trade.initiator_id,
      targetId: trade.target_id,
      initiatorName: initiator?.name ?? "Unknown",
      targetName: target?.name ?? "Unknown",
      initiatorOffer: trade.initiator_offer,
      targetOffer: trade.target_offer,
      state,
      initiatorAccepted: trade.initiator_accepted,
      targetAccepted: trade.target_accepted,
      createdAt: trade.created_at,
      expiresAt: trade.expires_at,
    },
  });
}
