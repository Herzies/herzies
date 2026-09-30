import { NextResponse } from "next/server";
import { unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import { adminXpBonusSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/** The built-in XP bonuses (boost, streak, Good Eye Sniper) — 00091. */
export async function GET(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("xp_bonuses")
    .select("id, enabled, amount, cap, updated_at")
    .order("id");

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch XP bonuses" },
      { status: 500 },
    );
  }

  return NextResponse.json({ bonuses: data });
}

/** Update one built-in bonus. The rows are fixed (seeded by 00091), so this
 * only ever edits, never creates. */
export async function POST(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const body = await parseBody(request, adminXpBonusSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("xp_bonuses")
    .update({
      enabled: body.enabled,
      amount: body.amount,
      cap: body.cap,
      updated_at: new Date().toISOString(),
    })
    .eq("id", body.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json(
      { error: "Failed to update XP bonus" },
      { status: 500 },
    );
  }

  return NextResponse.json({ bonus: data });
}
