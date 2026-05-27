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

  if (trade.target_id !== auth.userId) {
    return NextResponse.json(
      { error: "This trade is not for you" },
      { status: 403 },
    );
  }

  if (trade.state !== "pending") {
    return NextResponse.json(
      { error: `Trade is ${trade.state}, not pending` },
      { status: 400 },
    );
  }

  const { error } = await admin
    .from("trades")
    .update({ state: "active", updated_at: new Date().toISOString() })
    .eq("id", tradeId)
    .eq("state", "pending");

  if (error) {
    return NextResponse.json(
      { error: "Failed to join trade" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
