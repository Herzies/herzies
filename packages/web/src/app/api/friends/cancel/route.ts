import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { friendRequestIdSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/** Cancel a friend request you sent (sender only). */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, friendRequestIdSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();

  const { data: req } = await admin
    .from("friend_requests")
    .select("id, from_user_id, status")
    .eq("id", body.requestId)
    .maybeSingle();

  if (!req || req.from_user_id !== auth.userId) {
    return NextResponse.json(
      { error: "Friend request not found" },
      { status: 404 },
    );
  }
  if (req.status !== "pending") {
    return NextResponse.json(
      { error: "Friend request is no longer pending" },
      { status: 409 },
    );
  }

  await admin
    .from("friend_requests")
    .update({ status: "cancelled" })
    .eq("id", req.id);

  return NextResponse.json({ ok: true });
}
