import type { FriendSearchResult } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

const FRIEND_CODE_RE = /^HERZ-[A-Z0-9]{4}$/;
const SEARCH_LIMIT = 10;

/**
 * Search for a herzie to befriend by friend code or name.
 * GET /api/friends/search?q=HERZ-XXXX | name
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (!q) {
    return NextResponse.json({ results: [] });
  }

  const admin = createAdminClient();

  const { data: me } = await admin
    .from("herzies")
    .select("user_id, friend_code, friend_codes")
    .eq("user_id", auth.userId)
    .single();

  const myFriendCodes = new Set<string>(me?.friend_codes ?? []);

  let query = admin.from("herzies").select("user_id, name, friend_code, level");

  const asCode = q.toUpperCase();
  if (FRIEND_CODE_RE.test(asCode)) {
    query = query.eq("friend_code", asCode);
  } else {
    query = query.ilike("name", `%${q}%`).order("name").limit(SEARCH_LIMIT);
  }

  const { data: rows } = await query;
  const matches = (rows ?? []).filter((r) => r.user_id !== auth.userId);

  if (matches.length === 0) {
    return NextResponse.json({ results: [] });
  }

  // Resolve pending request relationships for the matched users.
  const matchedIds = matches.map((r) => r.user_id as string);
  const { data: pending } = await admin
    .from("friend_requests")
    .select("from_user_id, to_user_id")
    .eq("status", "pending")
    .or(`from_user_id.eq.${auth.userId},to_user_id.eq.${auth.userId}`)
    .or(
      `from_user_id.in.(${matchedIds.join(",")}),to_user_id.in.(${matchedIds.join(",")})`,
    );

  const sentTo = new Set<string>();
  const receivedFrom = new Set<string>();
  for (const p of pending ?? []) {
    if (p.from_user_id === auth.userId) sentTo.add(p.to_user_id as string);
    if (p.to_user_id === auth.userId)
      receivedFrom.add(p.from_user_id as string);
  }

  const results: FriendSearchResult[] = matches.map((r) => {
    const userId = r.user_id as string;
    let relationship: FriendSearchResult["relationship"] = "none";
    if (myFriendCodes.has(r.friend_code as string)) relationship = "friends";
    else if (sentTo.has(userId)) relationship = "pending_sent";
    else if (receivedFrom.has(userId)) relationship = "pending_received";
    return {
      friendCode: r.friend_code as string,
      name: r.name as string,
      level: (r.level as number) ?? 1,
      relationship,
    };
  });

  return NextResponse.json({ results });
}
