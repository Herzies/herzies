import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Check if a herzie name is already taken. Public endpoint.
 *
 * GET /api/name-check?name=Sparky
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name");

  if (!name || typeof name !== "string") {
    return NextResponse.json(
      { error: "name query param is required" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("herzies")
    .select("name")
    .ilike("name", name)
    .limit(1);

  return NextResponse.json({ taken: (data?.length ?? 0) > 0 });
}
