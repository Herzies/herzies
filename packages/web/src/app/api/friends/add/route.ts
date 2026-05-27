import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { friendCodePairSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

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
    .select("friend_code")
    .eq("user_id", auth.userId)
    .single();

  if (!ownHerzie || ownHerzie.friend_code !== myCode) {
    return NextResponse.json(
      { error: "Friend code does not match your herzie" },
      { status: 403 },
    );
  }

  // Add my code to their friend list
  const { error } = await admin.rpc("add_friend", {
    my_friend_code: myCode,
    their_friend_code: theirCode,
  });

  if (error) {
    return NextResponse.json(
      { error: "Failed to add friend" },
      { status: 500 },
    );
  }

  // Also add their code to my friend list
  const { data: myHerzie } = await admin
    .from("herzies")
    .select("friend_codes")
    .eq("user_id", auth.userId)
    .single();

  if (myHerzie) {
    const codes: string[] = myHerzie.friend_codes ?? [];
    if (!codes.includes(theirCode)) {
      await admin
        .from("herzies")
        .update({ friend_codes: [...codes, theirCode] })
        .eq("user_id", auth.userId);
    }
  }

  return NextResponse.json({ ok: true });
}
