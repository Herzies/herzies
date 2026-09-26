import { NextResponse } from "next/server";

export function verifyAdmin(request: Request): boolean {
  const secret = request.headers.get("x-admin-secret");
  return !!secret && secret === process.env.GAME_ADMIN_SECRET;
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
  const secret = request.headers.get("x-curator-secret");
  return !!secret && secret === process.env.SONG_HUNT_CURATOR_SECRET;
}
