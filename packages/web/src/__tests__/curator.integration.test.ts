/**
 * Integration tests for the song-hunt curator (00083): proposals are held
 * until the admin approves them, and the curator can never overwrite what the
 * admin curated.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as saveSeriesRoute } from "@/app/api/admin/event-series/route";
import { POST as saveEventRoute } from "@/app/api/admin/events/route";
import {
  GET as poolGet,
  POST as poolPost,
} from "@/app/api/admin/song-pool/route";
import {
  GET as curatorGet,
  POST as curatorPost,
} from "@/app/api/curator/song-hunt/route";
import { GET as activeEvents } from "@/app/api/events/active/route";
import {
  cleanupTestData,
  getAdminClient,
  setLocalEnv,
} from "./integration-helpers";

const admin = () => getAdminClient();
const ADMIN_SECRET = "test-admin-secret";
const CURATOR_SECRET = "test-curator-secret";
const HOUR = 3_600_000;

function request(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  method = "POST",
) {
  return new Request(`http://localhost/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const asAdmin = { "x-admin-secret": ADMIN_SECRET };
const asCurator = { "x-curator-secret": CURATOR_SECRET };

type Row = {
  id: string;
  type: string;
  title: string;
  active: boolean;
  needs_approval: boolean;
  starts_at: string;
  ends_at: string;
  config: Record<string, unknown>;
};

/** A weekly hunt series starting in an hour; returns its occurrences. */
async function huntSeries(): Promise<Row[]> {
  const res = await saveSeriesRoute(
    request("admin/event-series", asAdmin, {
      type: "song_hunt",
      title: "Song Hunt",
      anchorAt: new Date(Date.now() + HOUR).toISOString(),
      intervalDays: 7,
      durationMinutes: 3 * 24 * 60,
      configTemplate: { rewardItemId: "cd", maxClaims: 10 },
    }),
  );
  const { id } = await res.json();
  const { data } = await admin()
    .from("events")
    .select("*")
    .eq("series_id", id)
    .order("starts_at");
  return data as Row[];
}

async function reread(id: string): Promise<Row> {
  const { data } = await admin()
    .from("events")
    .select("*")
    .eq("id", id)
    .single();
  return data as Row;
}

function proposal(e: Row, overrides: Record<string, unknown> = {}) {
  const start = new Date(e.starts_at).getTime();
  return {
    eventId: e.id,
    title: "Song Hunt #9",
    trackTitle: "Proposed Song",
    trackArtist: "Proposed Artist",
    hints: [
      { text: "first", unlocksAt: new Date(start).toISOString() },
      { text: "second", unlocksAt: new Date(start + 24 * HOUR).toISOString() },
    ],
    ...overrides,
  };
}

function adminSave(e: Row, patch: Record<string, unknown>) {
  return saveEventRoute(
    request("admin/events", asAdmin, {
      id: e.id,
      type: e.type,
      title: e.title,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      config: e.config,
      ...patch,
    }),
  );
}

beforeEach(async () => {
  setLocalEnv();
  process.env.GAME_ADMIN_SECRET = ADMIN_SECRET;
  process.env.SONG_HUNT_CURATOR_SECRET = CURATOR_SECRET;
  await cleanupTestData();
});

afterAll(async () => {
  await cleanupTestData();
});

describe("curator access", () => {
  it("refuses the admin secret and missing secrets", async () => {
    expect(
      (
        await curatorGet(
          request("curator/song-hunt", asAdmin, undefined, "GET"),
        )
      ).status,
    ).toBe(401);
    expect(
      (await curatorGet(request("curator/song-hunt", {}, undefined, "GET")))
        .status,
    ).toBe(401);
  });

  it("lists open drafts and past answers", async () => {
    const [first] = await huntSeries();
    await curatorPost(request("curator/song-hunt", asCurator, proposal(first)));

    const res = await curatorGet(
      request("curator/song-hunt", asCurator, undefined, "GET"),
    );
    const body = await res.json();
    expect(body.drafts.length).toBeGreaterThan(1);
    expect(body.drafts[0].pendingProposal.trackTitle).toBe("Proposed Song");
    expect(body.pastAnswers).toEqual([
      expect.objectContaining({
        trackTitle: "Proposed Song",
        proposalOnly: true,
      }),
    ]);
  });
});

describe("proposals", () => {
  it("are held until approved", async () => {
    const [first] = await huntSeries();
    const res = await curatorPost(
      request("curator/song-hunt", asCurator, proposal(first)),
    );
    expect(res.status).toBe(200);

    let row = await reread(first.id);
    expect(row).toMatchObject({
      active: false,
      needs_approval: true,
      title: "Song Hunt #9",
    });

    // Skipping and unskipping doesn't sneak it past approval.
    await adminSave(row, { skipped: true });
    await adminSave(await reread(first.id), { skipped: false });
    expect((await reread(first.id)).active).toBe(false);

    await adminSave(await reread(first.id), { approve: true });
    row = await reread(first.id);
    expect(row).toMatchObject({ active: true, needs_approval: false });

    const upcoming = (
      await (await activeEvents(new Request("http://x"))).json()
    ).upcoming;
    expect(upcoming.map((e: { id: string }) => e.id)).toContain(first.id);
  });

  it("can be revised by the curator while pending", async () => {
    const [first] = await huntSeries();
    await curatorPost(request("curator/song-hunt", asCurator, proposal(first)));
    const res = await curatorPost(
      request(
        "curator/song-hunt",
        asCurator,
        proposal(first, { trackTitle: "Second Thought" }),
      ),
    );
    expect(res.status).toBe(200);
    expect((await reread(first.id)).config.trackTitle).toBe("Second Thought");
  });

  it("are replaced when the admin curates the hunt instead", async () => {
    const [first] = await huntSeries();
    await curatorPost(request("curator/song-hunt", asCurator, proposal(first)));

    const mine = {
      ...(await reread(first.id)).config,
      trackTitle: "Admin Song",
      trackArtist: "Admin Artist",
    };
    // What the edit form sends.
    await adminSave(await reread(first.id), { config: mine, approve: true });
    expect(await reread(first.id)).toMatchObject({
      active: true,
      needs_approval: false,
      config: expect.objectContaining({ trackTitle: "Admin Song" }),
    });

    // And the curator can no longer touch it.
    const res = await curatorPost(
      request("curator/song-hunt", asCurator, proposal(first)),
    );
    expect(res.status).toBe(409);
    expect((await reread(first.id)).config.trackTitle).toBe("Admin Song");
  });

  it("refuses hints that unlock outside the hunt", async () => {
    const [first] = await huntSeries();
    const res = await curatorPost(
      request(
        "curator/song-hunt",
        asCurator,
        proposal(first, {
          hints: [{ text: "late", unlocksAt: first.ends_at }],
        }),
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe("song pool", () => {
  async function addToPool(trackTitle: string, trackArtist: string) {
    return poolPost(
      request("admin/song-pool", asAdmin, { trackTitle, trackArtist }),
    );
  }

  it("feeds unused songs to the curator and drops them once a hunt uses one", async () => {
    await admin().from("song_pool").delete().neq("track_title", "");
    const [first] = await huntSeries();
    expect((await addToPool("Proposed Song", "Proposed Artist")).status).toBe(
      201,
    );
    expect((await addToPool("Other Song", "Other Artist")).status).toBe(201);

    const before = await (
      await curatorGet(
        request("curator/song-hunt", asCurator, undefined, "GET"),
      )
    ).json();
    expect(
      before.pool.map((s: { trackTitle: string }) => s.trackTitle),
    ).toEqual(["Proposed Song", "Other Song"]);

    // Different case: matched the way plays are, so it still counts as used.
    await curatorPost(
      request(
        "curator/song-hunt",
        asCurator,
        proposal(first, { trackTitle: "proposed song" }),
      ),
    );

    const after = await (
      await curatorGet(
        request("curator/song-hunt", asCurator, undefined, "GET"),
      )
    ).json();
    expect(after.pool.map((s: { trackTitle: string }) => s.trackTitle)).toEqual(
      ["Other Song"],
    );

    const listed = await (
      await poolGet(request("admin/song-pool", asAdmin, undefined, "GET"))
    ).json();
    expect(
      listed.songs.find(
        (s: { trackTitle: string }) => s.trackTitle === "Proposed Song",
      ).usedBy,
    ).toBe("Song Hunt #9");
  });

  it("refuses a duplicate", async () => {
    await admin().from("song_pool").delete().neq("track_title", "");
    expect((await addToPool("Dup", "Band")).status).toBe(201);
    expect((await addToPool(" dup ", "BAND")).status).toBe(409);
  });
});
