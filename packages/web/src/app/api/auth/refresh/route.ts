import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isParseError, parseBody, refreshTokenSchema } from "@/lib/schemas";

/**
 * Refresh an access token using a refresh token.
 *
 * LEGACY — kept only for desktop builds shipped before the client started
 * calling Supabase's GoTrue token endpoint directly (see `refresh_url` in
 * `packages/desktop/src-tauri/src/api.rs`). Current clients never reach this,
 * so its traffic should decay to zero as users take the auto-update; do not
 * delete it until old-version telemetry says nobody is refreshing here.
 *
 * The original rationale ("so the CLI doesn't need the Supabase anon key") did
 * not hold: the desktop binary has always shipped the anon key, so this hop only
 * added a serverless cold start and the shared-per-IP `auth` rate-limit bucket
 * in `middleware.ts` in front of session refresh — which is the one call whose
 * failure logs a user out.
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
