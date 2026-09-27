import { NextResponse } from "next/server";
import { unauthorizedAdmin, verifyCurator } from "@/lib/admin-auth";
import { curatorSongHuntSchema, isParseError, parseBody } from "@/lib/schemas";
import { loadSongPool } from "@/lib/song-pool";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Song-hunt curator API, for the weekly drafting routine.
 *
 * The curator can only fill upcoming song hunt occurrences of a series, and
 * everything it saves is a proposal: needs_approval holds it back until the
 * admin approves (or rewrites) it on the admin page. It can revise its own
 * pending proposals, but never an occurrence the admin has curated or skipped.
 */

type Row = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  config: Record<string, unknown>;
  series_id: string | null;
  skipped: boolean;
  customized: boolean;
  needs_approval: boolean;
};

/** Open for the curator: upcoming, not skipped, and not the admin's work. */
function isOpen(e: Row, now: Date) {
  return (
    !!e.series_id &&
    !e.skipped &&
    new Date(e.starts_at) > now &&
    (!e.customized || e.needs_approval)
  );
}

/** Upcoming drafts to fill, plus every past answer so picks never repeat. */
export async function GET(request: Request) {
  if (!verifyCurator(request)) return unauthorizedAdmin();

  const admin = createAdminClient();
  const now = new Date();

  const { data, error } = await admin
    .from("events")
    .select(
      "id, title, starts_at, ends_at, config, series_id, skipped, customized, needs_approval",
    )
    .eq("type", "song_hunt")
    .order("starts_at", { ascending: true });
  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch song hunts" },
      { status: 500 },
    );
  }
  const rows = (data ?? []) as Row[];

  const drafts = rows
    .filter((e) => isOpen(e, now))
    .slice(0, 4)
    .map((e) => ({
      eventId: e.id,
      title: e.title,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      rewardItemId: e.config.rewardItemId ?? null,
      pendingProposal: e.needs_approval
        ? {
            trackTitle: e.config.trackTitle,
            trackArtist: e.config.trackArtist,
            hints: e.config.hints,
          }
        : null,
    }));

  const pastAnswers = rows
    .filter((e) => typeof e.config.trackTitle === "string")
    .map((e) => ({
      title: e.title,
      startsAt: e.starts_at,
      trackTitle: e.config.trackTitle,
      trackArtist: e.config.trackArtist,
      proposalOnly: e.needs_approval,
    }));

  // Unused songs the admin queued up; the routine must pick from these while
  // any remain. Notes are the admin's pointers for the clue writer.
  const pool = (await loadSongPool(admin))
    .filter((s) => !s.usedBy)
    .map((s) => ({
      trackTitle: s.trackTitle,
      trackArtist: s.trackArtist,
      notes: s.notes,
    }));

  return NextResponse.json({ drafts, pastAnswers, pool });
}

/** Propose (or revise a proposal for) one upcoming song hunt. */
export async function POST(request: Request) {
  if (!verifyCurator(request)) return unauthorizedAdmin();

  const body = await parseBody(request, curatorSongHuntSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();
  const now = new Date();

  const { data: event } = await admin
    .from("events")
    .select(
      "id, title, type, starts_at, ends_at, config, series_id, skipped, customized, needs_approval",
    )
    .eq("id", body.eventId)
    .maybeSingle();

  if (!event || event.type !== "song_hunt") {
    return NextResponse.json({ error: "Song hunt not found" }, { status: 404 });
  }
  if (!isOpen(event as Row, now)) {
    return NextResponse.json(
      {
        error:
          "Not open for proposals (already started, skipped, or curated by the admin)",
      },
      { status: 409 },
    );
  }

  const start = new Date(event.starts_at).getTime();
  const end = new Date(event.ends_at).getTime();
  for (const [i, hint] of body.hints.entries()) {
    const at = new Date(hint.unlocksAt).getTime();
    if (Number.isNaN(at) || at < start || at >= end) {
      return NextResponse.json(
        { error: `Hint ${i + 1} must unlock inside the hunt's window` },
        { status: 400 },
      );
    }
  }

  const config = {
    ...(event.config as Record<string, unknown>),
    trackTitle: body.trackTitle,
    trackArtist: body.trackArtist,
    hints: body.hints
      .map((h) => ({
        text: h.text,
        unlocksAt: new Date(h.unlocksAt).toISOString(),
      }))
      .sort((a, b) => a.unlocksAt.localeCompare(b.unlocksAt)),
  };

  const { error } = await admin
    .from("events")
    .update({
      title: body.title ?? event.title,
      config,
      active: false,
      needs_approval: true,
      customized: true,
    })
    .eq("id", event.id);
  if (error) {
    return NextResponse.json(
      { error: "Failed to save proposal" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, eventId: event.id });
}
