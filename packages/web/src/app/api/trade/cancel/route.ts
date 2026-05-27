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
    .select("initiator_id, target_id, state")
    .eq("id", tradeId)
    .single();

  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  if (trade.initiator_id !== auth.userId && trade.target_id !== auth.userId) {
    return NextResponse.json({ error: "Not your trade" }, { status: 403 });
  }

  if (trade.state === "completed" || trade.state === "cancelled") {
    return NextResponse.json({ ok: true }); // already terminal
  }

  const { error } = await admin
    .from("trades")
    .update({ state: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", tradeId);

  if (error) {
    return NextResponse.json({ error: "Failed to cancel" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
