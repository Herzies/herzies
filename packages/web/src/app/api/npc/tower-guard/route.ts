import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * What the Tower Guard shows you: this month's top three climbers and your
 * place, last month's winner, and whether he owes you a reward
 * (tower_guard_json, 00121).
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("tower_guard_json", {
    p_user: auth.userId,
  });
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to load the Tower Guard" },
      { status: 500 },
    );
  }
  return NextResponse.json(data);
}
