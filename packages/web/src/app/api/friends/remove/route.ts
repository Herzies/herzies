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

  const admin = createAdminClient();

  // Verify ownership
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

  // Remove my code from their friend list
  await admin.rpc("remove_friend", {
    my_friend_code: myCode,
    their_friend_code: theirCode,
  });

  // Remove their code from my friend list
  const { data: myHerzie } = await admin
    .from("herzies")
    .select("friend_codes")
    .eq("user_id", auth.userId)
    .single();

  if (myHerzie) {
    const codes: string[] = (myHerzie.friend_codes ?? []).filter(
      (c: string) => c !== theirCode,
    );
    await admin
      .from("herzies")
      .update({ friend_codes: codes })
      .eq("user_id", auth.userId);
  }

  return NextResponse.json({ ok: true });
}
