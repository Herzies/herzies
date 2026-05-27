import { NextResponse } from "next/server";

export function verifyAdmin(request: Request): boolean {
  const secret = request.headers.get("x-admin-secret");
  return !!secret && secret === process.env.GAME_ADMIN_SECRET;
}

export function unauthorizedAdmin(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
