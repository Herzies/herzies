import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

/**
 * Verify the Bearer token from the CLI and return the authenticated user ID.
 * Returns null if authentication fails.
 */
export async function authenticateRequest(
  request: Request,
): Promise<{ userId: string } | NextResponse> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Missing or invalid Authorization header" },
      { status: 401 },
    );
  }

  const token = authHeader.slice(7);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 401 },
    );
  }

  return { userId: user.id };
}

/** Type guard to check if auth result is an error response */
export function isAuthError(
  result: { userId: string } | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse;
}

/**
 * Like authenticateRequest, but never fails the request — used by endpoints
 * that serve both authenticated clients (desktop app) and anonymous callers
 * (marketing site) and want to personalize the response only when possible.
 */
export async function authenticateRequestOptional(
  request: Request,
): Promise<{ userId: string | null }> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { userId: null };
  }

  const token = authHeader.slice(7);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser(token);

  return { userId: user?.id ?? null };
}
