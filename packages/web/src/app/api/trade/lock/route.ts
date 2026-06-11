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

  const state = trade.state as string;

  // Determine new state based on who is locking
  let newState: string;

  if (state === "active") {
    newState = isInitiator ? "initiator_locked" : "target_locked";
  } else if (state === "initiator_locked" && isTarget) {
    newState = "both_locked";
  } else if (state === "target_locked" && isInitiator) {
    newState = "both_locked";
  } else if (state === "initiator_locked" && isInitiator) {
    return NextResponse.json({ ok: true }); // already locked
  } else if (state === "target_locked" && isTarget) {
    return NextResponse.json({ ok: true }); // already locked
  } else if (state === "both_locked") {
    return NextResponse.json({ ok: true }); // already locked
  } else {
    return NextResponse.json(
      { error: `Cannot lock in ${state} state` },
      { status: 400 },
    );
  }

  const { error } = await admin
    .from("trades")
    .update({
      state: newState,
      updated_at: new Date().toISOString(),
      // Keep the trade alive while both sides are actively progressing it.
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    .eq("id", tradeId);

  if (error) {
    return NextResponse.json(
      { error: "Failed to lock trade" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
