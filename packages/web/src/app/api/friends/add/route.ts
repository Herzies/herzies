import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { acceptRequest, MAX_FRIENDS } from "@/lib/friends";
import { friendCodePairSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Send a friend request. Friendship is no longer instant: this creates a
 * pending row in `friend_requests` that the recipient must accept.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, friendCodePairSchema);
  if (isParseError(body)) return body;

  const { myCode, theirCode } = body;

  if (myCode === theirCode) {
    return NextResponse.json(
      { error: "Cannot add yourself as a friend" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Verify the caller owns the herzie with myCode
  const { data: ownHerzie } = await admin
    .from("herzies")
    .select("friend_code, friend_codes")
    .eq("user_id", auth.userId)
    .single();

  if (!ownHerzie || ownHerzie.friend_code !== myCode) {
    return NextResponse.json(
      { error: "Friend code does not match your herzie" },
      { status: 403 },
    );
  }

  const myCodes: string[] = ownHerzie.friend_codes ?? [];
  if (myCodes.includes(theirCode)) {
    return NextResponse.json(
      { error: "You are already friends" },
      { status: 409 },
    );
  }
  if (myCodes.length >= MAX_FRIENDS) {
    return NextResponse.json(
      { error: "Friend list full (max 20)" },
      { status: 409 },
    );
  }

  // Resolve the target user.
  const { data: target } = await admin
    .from("herzies")
    .select("user_id")
    .eq("friend_code", theirCode)
    .single();

  if (!target) {
    return NextResponse.json(
      { error: "Friend code not found" },
      { status: 404 },
    );
  }

  // If they already sent you a request, accept it instead of creating a duplicate.
  const { data: reverse } = await admin
    .from("friend_requests")
    .select("id")
    .eq("from_user_id", target.user_id)
    .eq("to_user_id", auth.userId)
    .eq("status", "pending")
    .maybeSingle();

  if (reverse) {
    await acceptRequest(admin, reverse.id, myCode, theirCode, auth.userId);
    return NextResponse.json({ ok: true, accepted: true });
  }

  const { error } = await admin.from("friend_requests").insert({
    from_user_id: auth.userId,
    to_user_id: target.user_id,
    status: "pending",
  });

  if (error) {
    // Unique partial index violation → request already pending.
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Friend request already sent" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Failed to send friend request" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
