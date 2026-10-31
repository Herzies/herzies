import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { loadStall } from "@/lib/market";
import { createAdminClient } from "@/lib/supabase-admin";

/** The player's own side of the market board: their listings that are up,
 * and what's waiting to be collected. */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  return NextResponse.json(await loadStall(createAdminClient(), auth.userId));
}
