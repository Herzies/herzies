import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Lists the caller's non-terminal trades so the client can offer a way back
 * into a trade after the window was closed or the user navigated away.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();

  // Expire stale trades
  await admin.rpc("expire_stale_trades");

  const { data: trades } = await admin
    .from("trades")
    .select("id, initiator_id, target_id, state, created_at, expires_at")
    .or(`initiator_id.eq.${auth.userId},target_id.eq.${auth.userId}`)
    .not("state", "in", "(completed,cancelled)")
    .order("created_at", { ascending: false });

  if (!trades || trades.length === 0) {
    return NextResponse.json({ trades: [] });
  }

  const partnerIds = [
    ...new Set(
      trades.map((t) =>
        t.initiator_id === auth.userId ? t.target_id : t.initiator_id,
      ),
    ),
  ];

  const { data: partners } = await admin
    .from("herzies")
    .select("user_id, name, friend_code")
    .in("user_id", partnerIds);

  const partnerMap = new Map((partners ?? []).map((p) => [p.user_id, p]));

  return NextResponse.json({
    trades: trades.map((t) => {
      const role = t.initiator_id === auth.userId ? "initiator" : "target";
      const partner = partnerMap.get(
        role === "initiator" ? t.target_id : t.initiator_id,
      );
      return {
        tradeId: t.id,
        state: t.state,
        role,
        partnerName: partner?.name ?? "Unknown",
        partnerFriendCode: partner?.friend_code ?? "",
        createdAt: t.created_at,
        expiresAt: t.expires_at,
      };
    }),
  });
}
