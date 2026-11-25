import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, { status: number; error: string }> = {
  "not-found": { status: 404, error: "Herzie not found" },
  "no-tower": { status: 400, error: "The Tower is closed" },
};

/**
 * The Tower Guard starts your climb in the running Tower over
 * (tower_reset, 00161): back to floor 1 with no boons, your best floor
 * (the leaderboard) kept.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();

  const nowIso = new Date().toISOString();
  const { data: tower } = await admin
    .from("events")
    .select("id")
    .eq("type", "tower")
    .eq("active", true)
    .lte("starts_at", nowIso)
    .gt("ends_at", nowIso)
    .order("starts_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!tower) {
    const known = REASONS["no-tower"];
    return NextResponse.json(
      { ok: false, reason: "no-tower", error: known.error },
      { status: known.status },
    );
  }

  const { data, error } = await admin.rpc("tower_reset", {
    p_user: auth.userId,
    p_event: tower.id,
  });
  if (error) {
    return NextResponse.json(
      { error: "Failed to start over" },
      { status: 500 },
    );
  }
  const result = data as { ok: boolean; reason?: string } | null;
  if (!result?.ok) {
    const known = REASONS[result?.reason ?? ""];
    return NextResponse.json(
      {
        ok: false,
        reason: result?.reason,
        error: known?.error ?? "Failed to start over",
      },
      { status: known?.status ?? 400 },
    );
  }

  return NextResponse.json({ ok: true });
}
