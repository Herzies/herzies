import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { allocateStatsSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, string> = {
  "not-found": "Herzie not found",
  "bad-points": "Points must be whole numbers",
  "too-many": "Not enough stat points",
};

/** Sets the herzie's stat points. The whole allocation at once, so a reset
 * is all zeros and a retried request can't spend twice. Answers with the
 * points as stored and the health they make. */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, allocateStatsSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("allocate_stats", {
    p_user: auth.userId,
    p_stamina: body.stamina,
    p_sonic: body.sonicPower,
    p_euphony: body.euphony,
  });

  const result = data as {
    ok: boolean;
    reason?: string;
    statPoints?: { stamina: number; sonicPower: number; euphony: number };
    vitals?: Record<string, unknown>;
  } | null;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!result?.ok) {
    return NextResponse.json(
      { error: REASONS[result?.reason ?? ""] ?? "Failed to save stat points" },
      { status: result?.reason === "not-found" ? 404 : 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    statPoints: result.statPoints,
    vitals: result.vitals,
  });
}
