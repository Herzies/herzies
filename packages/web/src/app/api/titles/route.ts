import type { TitlesState } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

/** The Titles tab: what's worn, what's earned, the numbers progress is
 * shown on, how many herzies hold each and how many there are in all.
 * Opening it grants whatever the herzie has reached that nothing else
 * grants as it happens (friends, Market sales, a Tower month closing, a
 * tenth boss fight): those come back in `granted`, and the next sync hands
 * them over for the toast too. */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("titles_json", {
    p_user: auth.userId,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  const state = data as TitlesState;
  return NextResponse.json({
    worn: state.worn ?? null,
    earned: state.earned ?? [],
    metrics: state.metrics,
    holders: state.holders ?? {},
    herzies: state.herzies ?? 0,
    granted: state.granted ?? [],
  } satisfies TitlesState);
}
