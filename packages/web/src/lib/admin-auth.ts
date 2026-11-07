import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

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

/**
 * The accounts allowed into the control panel (/admin): a comma list of
 * Supabase user ids in ADMIN_USER_IDS. herzies.gm is only a label shown in
 * Town, never a permission.
 */
export function adminUserIds(): Set<string> {
  return new Set(
    (process.env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/**
 * True on a dev server on this machine (not Vercel): the control panel then
 * also shows the Workshop (map + item editors, which write source files)
 * and offers the GAME_ADMIN_SECRET prompt for when you aren't signed in.
 */
export function isLocalPanel(): boolean {
  return process.env.NODE_ENV !== "production" && !process.env.VERCEL;
}

/** The signed-in user's id when they're an admin, else null. */
export async function getAdminUserId(): Promise<string | null> {
  const ids = adminUserIds();
  if (ids.size === 0) return null;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user && ids.has(user.id) ? user.id : null;
}

/**
 * An admin request: either a signed-in admin (the control panel) or the
 * shared GAME_ADMIN_SECRET header (scripts and local tools).
 */
export async function verifyAdmin(request: Request): Promise<boolean> {
  if (
    verifySecret(
      request.headers.get("x-admin-secret"),
      process.env.GAME_ADMIN_SECRET,
    )
  ) {
    return true;
  }
  return (await getAdminUserId()) !== null;
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
