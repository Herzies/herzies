import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { rowToHerzie } from "@/lib/game-server";
import { isParseError, parseBody, updateMeSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("herzies")
    .select("*")
    .eq("user_id", auth.userId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  return NextResponse.json({ herzie: rowToHerzie(data) });
}

/** Update the caller's own settings — just "Share what you're listening to"
 * for now. */
export async function PATCH(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, updateMeSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("herzies")
    .update({ share_listening: body.shareListening })
    .eq("user_id", auth.userId)
    .select("*")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  return NextResponse.json({ herzie: rowToHerzie(data) });
}

export async function DELETE(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();
  const { error } = await admin
    .from("herzies")
    .delete()
    .eq("user_id", auth.userId);

  if (error) {
    return NextResponse.json(
      { error: "Failed to delete herzie" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
