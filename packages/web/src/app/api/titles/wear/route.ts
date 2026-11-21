import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { isParseError, parseBody, wearTitleSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, string> = {
  "not-found": "Herzie not found",
  unknown: "No such title",
  "not-earned": "You haven't earned that title yet",
};

/** Wears an earned title, or none (`title: null`). Answers with the title
 * now worn; the app renews its Town ticket so others see it. */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, wearTitleSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("set_title", {
    p_user: auth.userId,
    p_title: body.title,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    worn?: string | null;
  } | null;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!result?.ok) {
    const reason = result?.reason ?? "";
    return NextResponse.json(
      { error: REASONS[reason] ?? "Failed to wear the title", reason },
      { status: reason === "not-found" ? 404 : 400 },
    );
  }

  return NextResponse.json({ worn: result.worn ?? null });
}
