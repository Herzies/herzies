import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { rowToHerzie } from "@/lib/game-server";
import { isParseError, parseBody, registerHerzieSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, registerHerzieSchema);
  if (isParseError(body)) return body;

  const { name, appearance, friendCode } = body;

  const admin = createAdminClient();

  // Check if user already has a herzie
  const { data: existing } = await admin
    .from("herzies")
    .select("id")
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (existing) {
    // Already registered — return the existing herzie
    const { data: row } = await admin
      .from("herzies")
      .select("*")
      .eq("user_id", auth.userId)
      .single();

    return NextResponse.json({ herzie: rowToHerzie(row!) });
  }

  // Check name uniqueness
  const { data: nameTaken } = await admin
    .from("herzies")
    .select("id")
    .ilike("name", name)
    .maybeSingle();

  if (nameTaken) {
    return NextResponse.json(
      { error: "Name is already taken" },
      { status: 409 },
    );
  }

  // Check friend code uniqueness
  const { data: codeTaken } = await admin
    .from("herzies")
    .select("id")
    .eq("friend_code", friendCode)
    .maybeSingle();

  if (codeTaken) {
    return NextResponse.json(
      { error: "Friend code collision" },
      { status: 409 },
    );
  }

  const { data: row, error } = await admin
    .from("herzies")
    .insert({
      user_id: auth.userId,
      name,
      appearance,
      friend_code: friendCode,
    })
    .select("*")
    .single();

  if (error || !row) {
    return NextResponse.json(
      { error: "Failed to register herzie" },
      { status: 500 },
    );
  }

  return NextResponse.json({ herzie: rowToHerzie(row) }, { status: 201 });
}
