import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { rowToHerzie } from "@/lib/game-server";
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
