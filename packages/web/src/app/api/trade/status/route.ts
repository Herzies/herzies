import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const tradeId = searchParams.get("tradeId");
  // Names can't change mid-trade: the client asks once (and clients from
  // before this, which don't say, get them every time).
  const withNames = searchParams.get("names") !== "0";

  if (!tradeId) {
    return NextResponse.json({ error: "Missing tradeId" }, { status: 400 });
  }

  const admin = createAdminClient();

  // TradeView polls this as a fallback to the live trade_update broadcasts
  // (00157): every 2s per open trade, 650ms while its live channel is down.
  // It used to open with expire_stale_trades(), a write, on every poll.
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

  // Both parties' names in one query, and only when asked for.
  const names = new Map<string, string>();
  if (withNames) {
    const { data: herzies } = await admin
      .from("herzies")
      .select("user_id, name")
      .in("user_id", [trade.initiator_id, trade.target_id]);
    for (const h of herzies ?? []) names.set(h.user_id, h.name);
  }

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
      ...(withNames && {
        initiatorName: names.get(trade.initiator_id) ?? "Unknown",
        targetName: names.get(trade.target_id) ?? "Unknown",
      }),
      initiatorOffer: trade.initiator_offer,
      targetOffer: trade.target_offer,
      state,
      initiatorAccepted: trade.initiator_accepted,
      targetAccepted: trade.target_accepted,
      createdAt: trade.created_at,
      expiresAt: trade.expires_at,
      // Orders this answer against the broadcasts (00157); absent until it's
      // deployed.
      version: trade.version,
    },
  });
}
