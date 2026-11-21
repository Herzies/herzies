import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { isParseError, parseBody, seenTitlesSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/** The Titles tab showed these: their NEW pill goes. Ids not earned (or not
 * titles at all) are simply skipped. */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, seenTitlesSchema);
  if (isParseError(body)) return body;

  if (body.ids.length > 0) {
    const admin = createAdminClient();
    const { error } = await admin.rpc("mark_titles_seen", {
      p_user: auth.userId,
      p_ids: body.ids,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
