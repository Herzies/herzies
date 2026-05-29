import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { acceptRequest, MAX_FRIENDS } from "@/lib/friends";
import { friendRequestIdSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/** Accept an incoming friend request, creating the bidirectional friendship. */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, friendRequestIdSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();

  const { data: req } = await admin
    .from("friend_requests")
    .select("id, from_user_id, to_user_id, status")
    .eq("id", body.requestId)
    .maybeSingle();

  if (!req || req.to_user_id !== auth.userId) {
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

  const [{ data: me }, { data: them }] = await Promise.all([
    admin
      .from("herzies")
      .select("friend_code, friend_codes")
      .eq("user_id", auth.userId)
      .single(),
    admin
      .from("herzies")
      .select("friend_code")
      .eq("user_id", req.from_user_id)
      .single(),
  ]);

  if (!me || !them) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  if ((me.friend_codes ?? []).length >= MAX_FRIENDS) {
    return NextResponse.json(
      { error: "Friend list full (max 20)" },
      { status: 409 },
    );
  }

  await acceptRequest(
    admin,
    req.id,
    me.friend_code,
    them.friend_code,
    auth.userId,
  );

  return NextResponse.json({ ok: true });
}
