import type { createAdminClient } from "@/lib/supabase-admin";

/** Maximum number of friends a herzie may have. */
export const MAX_FRIENDS = 20;

/**
 * Mark a friend request accepted and create the bidirectional friendship.
 * Shared by the send route (auto-accept of a reverse request) and the
 * dedicated accept route.
 */
export async function acceptRequest(
  admin: ReturnType<typeof createAdminClient>,
  requestId: string,
  myCode: string,
  theirCode: string,
  myUserId: string,
): Promise<void> {
  await admin
    .from("friend_requests")
    .update({ status: "accepted" })
    .eq("id", requestId);

  // Add my code to their friend list
  await admin.rpc("add_friend", {
    my_friend_code: myCode,
    their_friend_code: theirCode,
  });

  // Add their code to my friend list
  const { data: myHerzie } = await admin
    .from("herzies")
    .select("friend_codes")
    .eq("user_id", myUserId)
    .single();

  if (myHerzie) {
    const codes: string[] = myHerzie.friend_codes ?? [];
    if (!codes.includes(theirCode)) {
      await admin
        .from("herzies")
        .update({ friend_codes: [...codes, theirCode] })
        .eq("user_id", myUserId);
    }
  }
}
