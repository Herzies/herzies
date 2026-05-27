import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { createServerClient } from "@/lib/supabase-server";

export async function POST(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  await admin.from("spotify_connections").delete().eq("user_id", user.id);

  return NextResponse.redirect(new URL("/dashboard", request.url));
}
