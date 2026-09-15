import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();

  // No expire_stale_trades() call here: the query below already filters on
  // expires_at, so the sweep never changed this result. It runs on pg_cron now
  // (00057_expire_stale_trades_cron.sql).

  // Check for pending trades where this user is the target
  const { data: pending } = await admin
    .from("trades")
    .select("id, initiator_id")
    .eq("target_id", auth.userId)
    .eq("state", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!pending) {
    return NextResponse.json({ pending: null });
  }

  const { data: initiator } = await admin
    .from("herzies")
    .select("name, friend_code")
    .eq("user_id", pending.initiator_id)
    .single();

  return NextResponse.json({
    pending: {
      tradeId: pending.id,
      fromName: initiator?.name ?? "Unknown",
      fromFriendCode: initiator?.friend_code ?? "",
    },
  });
}
