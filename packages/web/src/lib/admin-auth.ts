import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Constant-time check of a presented secret against the expected one, with
 * an optional prefix (e.g. "Bearer "). False when either side is missing, so
 * an unset env var never matches anything. Both sides are hashed first so
 * the comparison doesn't leak the secret's length either.
 */
export function verifySecret(
  presented: string | null,
  expected: string | undefined,
  prefix = "",
): boolean {
  if (!presented || !expected) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(presented), digest(prefix + expected));
}

export function verifyAdmin(request: Request): boolean {
  return verifySecret(
    request.headers.get("x-admin-secret"),
    process.env.GAME_ADMIN_SECRET,
  );
}

export function unauthorizedAdmin(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * The song-hunt curator (a scheduled agent) gets its own secret, separate
 * from GAME_ADMIN_SECRET: it may only propose song hunts for approval, so a
 * leaked curator key can't touch items, grants, bosses or anything live.
 */
export function verifyCurator(request: Request): boolean {
  return verifySecret(
    request.headers.get("x-curator-secret"),
    process.env.SONG_HUNT_CURATOR_SECRET,
  );
}
