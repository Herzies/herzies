import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { chooseClassSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, string> = {
  "not-found": "Herzie not found",
  "bad-class": "Unknown class",
  "already-chosen": "Your herzie already has a class",
  "stage-too-low": "Your herzie picks a class at stage 2",
};

/** Picks the herzie's class. Permanent: choose_class refuses a second,
 * different pick, and answers a repeat of the same one as a success so a
 * retried request is harmless. The class equipment arrives already worn. */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, chooseClassSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("choose_class", {
    p_user_id: auth.userId,
    p_class: body.class,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    class?: string;
    state?: ItemState;
  } | null;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!result?.ok || !result.state) {
    return NextResponse.json(
      { error: REASONS[result?.reason ?? ""] ?? "Failed to pick a class" },
      { status: result?.reason === "not-found" ? 404 : 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    class: result.class,
    ...itemResponse(result.state),
  });
}
