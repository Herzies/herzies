import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createMiddlewareClient } from "@/lib/supabase-middleware";

/**
 * Simple in-memory rate limiter for middleware.
 * Each Vercel serverless instance has its own state — this provides
 * per-instance protection. For strict global limits, use Upstash or similar.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

function checkRate(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = windows.get(key);

  if (!entry || now >= entry.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  entry.count++;
  return entry.count <= limit;
}

// Periodically clean up expired entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now >= entry.resetAt) windows.delete(key);
  }
}, 60_000);

/** Rate limit configs: [requests, windowMs] */
const LIMITS: Record<string, [number, number]> = {
  admin: [30, 60_000], // 30 req/min for admin routes
  sync: [10, 60_000], // 10 req/min for sync (daemon calls every 10s)
  auth: [10, 60_000], // 10 req/min for auth refresh
  spotify: [30, 60_000], // 30 req/min for Spotify OAuth endpoints
  api: [120, 60_000], // 120 req/min general API
};

function getIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Dev-only routes (game admin UI)
  if (pathname.startsWith("/dev") && process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  // Rate-limit API routes
  if (pathname.startsWith("/api/")) {
    const ip = getIp(request);
    let bucket: string;
    let config: [number, number];

    if (pathname.startsWith("/api/admin/")) {
      bucket = "admin";
      config = LIMITS.admin;
    } else if (pathname === "/api/sync") {
      bucket = "sync";
      config = LIMITS.sync;
    } else if (pathname.startsWith("/api/auth/")) {
      bucket = "auth";
      config = LIMITS.auth;
    } else if (pathname.startsWith("/api/spotify/")) {
      bucket = "spotify";
      config = LIMITS.spotify;
    } else {
      bucket = "api";
      config = LIMITS.api;
    }

    const key = `${bucket}:${ip}`;
    if (!checkRate(key, config[0], config[1])) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    return NextResponse.next();
  }

  // Refresh Supabase session on all page routes so tokens stay fresh
  const { supabase, response } = createMiddlewareClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Protect dashboard routes
  if (pathname.startsWith("/dashboard") && !user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static files and images:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt
     */
    "/((?!_next/static|_next/image|favicon\\.ico|sitemap\\.xml|robots\\.txt).*)",
  ],
};
