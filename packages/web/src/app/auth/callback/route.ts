import { type CookieOptions, createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Server-side OAuth callback handler.
 * Exchanges the PKCE code for a session, then redirects:
 * - With cli_port: to the client-side CLI callback (which POSTs tokens to the local CLI)
 * - Without cli_port: to /dashboard
 *
 * We build a Supabase client that reads cookies from the request and writes
 * them to the response so the code verifier (set by the browser client) is
 * available and the resulting session cookies are forwarded.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const cliPort = searchParams.get("cli_port");

  if (!code) {
    return NextResponse.redirect(
      new URL("/login?error=missing_code", request.url),
    );
  }

  // Build a response we can attach cookies to
  const redirectUrl = cliPort
    ? new URL(`/auth/callback/cli?cli_port=${cliPort}`, request.url)
    : new URL("/dashboard", request.url);
  const response = NextResponse.redirect(redirectUrl);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: Array<{
            name: string;
            value: string;
            options: CookieOptions;
          }>,
        ) {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const errorUrl = cliPort
      ? new URL(`/auth/cli?error=auth_failed`, request.url)
      : new URL("/login?error=auth_failed", request.url);
    return NextResponse.redirect(errorUrl);
  }

  return response;
}
