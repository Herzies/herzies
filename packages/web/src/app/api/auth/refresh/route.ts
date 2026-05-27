import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isParseError, parseBody, refreshTokenSchema } from "@/lib/schemas";

/**
 * Refresh an access token using a refresh token.
 * This allows the CLI to refresh tokens without needing the Supabase anon key.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, refreshTokenSchema);
  if (isParseError(body)) return body;

  const { refreshToken } = body;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (error || !data.session) {
    return NextResponse.json(
      { error: "Failed to refresh token" },
      { status: 401 },
    );
  }

  return NextResponse.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in ?? 3600,
  });
}
