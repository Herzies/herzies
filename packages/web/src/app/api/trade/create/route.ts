import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createTradeSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, createTradeSchema);
  if (isParseError(body)) return body;

  const { targetFriendCode } = body;

  const admin = createAdminClient();

  // Expire stale trades first
  await admin.rpc("expire_stale_trades");

  // Check that initiator doesn't already have an active trade
  const { data: existing } = await admin
    .from("trades")
    .select("id")
    .eq("initiator_id", auth.userId)
    .not("state", "in", '("completed","cancelled")')
    .limit(1)
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      { error: "You already have an active trade" },
      { status: 409 },
    );
  }

  // Also check if they're already a target in an active trade
  const { data: existingTarget } = await admin
    .from("trades")
    .select("id")
    .eq("target_id", auth.userId)
    .not("state", "in", '("completed","cancelled")')
    .limit(1)
    .maybeSingle();

  if (existingTarget) {
    return NextResponse.json(
      { error: "You already have an active trade" },
      { status: 409 },
    );
  }

  // Look up target by friend code
  const { data: target } = await admin
    .from("herzies")
    .select("user_id, name, friend_code")
    .eq("friend_code", targetFriendCode)
    .single();

  if (!target) {
    return NextResponse.json({ error: "Friend not found" }, { status: 404 });
  }

  if (target.user_id === auth.userId) {
    return NextResponse.json(
      { error: "Cannot trade with yourself" },
      { status: 400 },
    );
  }

  // Verify they are friends
  const { data: initiator } = await admin
    .from("herzies")
    .select("friend_codes")
    .eq("user_id", auth.userId)
    .single();

  if (
    !initiator ||
    !(initiator.friend_codes as string[]).includes(targetFriendCode)
  ) {
    return NextResponse.json(
      { error: "You can only trade with friends" },
      { status: 400 },
    );
  }

  // Create the trade
  const { data: trade, error } = await admin
    .from("trades")
    .insert({
      initiator_id: auth.userId,
      target_id: target.user_id,
    })
    .select("id")
    .single();

  if (error || !trade) {
    return NextResponse.json(
      { error: "Failed to create trade" },
      { status: 500 },
    );
  }

  return NextResponse.json({ tradeId: trade.id });
}
