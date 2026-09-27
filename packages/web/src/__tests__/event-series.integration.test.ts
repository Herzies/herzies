/**
 * Integration tests for recurring event series (00081): materializing
 * occurrences, skipping and hand-editing them, regenerating on series edits,
 * and keeping uncurated song hunts away from players.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DELETE as deleteSeriesRoute,
  POST as saveSeriesRoute,
} from "@/app/api/admin/event-series/route";
import {
  DELETE as deleteEventRoute,
  POST as saveEventRoute,
} from "@/app/api/admin/events/route";
import { GET as activeEvents } from "@/app/api/events/active/route";
import {
  cleanupTestData,
  getAdminClient,
  setLocalEnv,
} from "./integration-helpers";

const admin = () => getAdminClient();
const ADMIN_SECRET = "test-admin-secret";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function adminRequest(path: string, body?: unknown, method = "POST") {
  return new Request(`http://localhost/api/admin/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": ADMIN_SECRET,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function saveSeries(body: Record<string, unknown>) {
  const res = await saveSeriesRoute(adminRequest("event-series", body));
  const json = await res.json();
  if (res.status >= 300) throw new Error(json.error);
  return json.id as string;
}

type Occurrence = {
  id: string;
  type: string;
  title: string;
  active: boolean;
  skipped: boolean;
  customized: boolean;
  starts_at: string;
  ends_at: string;
  occurrence_at: string;
  config: Record<string, unknown>;
};

async function occurrences(seriesId: string): Promise<Occurrence[]> {
  const { data } = await admin()
    .from("events")
    .select("*")
    .eq("series_id", seriesId)
    .order("occurrence_at");
  return (data ?? []) as Occurrence[];
}

async function materialize(seriesId: string) {
  const { data, error } = await admin().rpc("materialize_event_series", {
    p_series_id: seriesId,
  });
  if (error) throw new Error(error.message);
  return data as number;
}

function saveOccurrence(o: Occurrence, patch: Record<string, unknown> = {}) {
  return saveEventRoute(
    adminRequest("events", {
      id: o.id,
      type: o.type,
      title: o.title,
      startsAt: o.starts_at,
      endsAt: o.ends_at,
      config: o.config,
      ...patch,
    }),
  );
}

/** A weekly song hunt whose first slot started an hour ago. */
function huntSeries(overrides: Record<string, unknown> = {}) {
  return {
    type: "song_hunt",
    title: "Song Hunt",
    anchorAt: new Date(Date.now() - HOUR).toISOString(),
    intervalDays: 7,
    durationMinutes: 6 * 24 * 60,
    configTemplate: { rewardItemId: "cd", maxClaims: 10 },
    ...overrides,
  };
}

const CURATED = {
  rewardItemId: "cd",
  maxClaims: 10,
  trackTitle: "Song",
  trackArtist: "Artist",
  hints: [{ text: "a hint", unlocksAt: new Date().toISOString() }],
};

beforeEach(async () => {
  setLocalEnv();
  process.env.GAME_ADMIN_SECRET = ADMIN_SECRET;
  await cleanupTestData();
});

afterAll(async () => {
  await cleanupTestData();
});

describe("materializing", () => {
  it("writes four weeks of occurrences, once", async () => {
    const id = await saveSeries(huntSeries());
    const first = await occurrences(id);
    // The running slot plus the next four weekly ones inside 28 days.
    expect(first).toHaveLength(5);
    expect(await materialize(id)).toBe(0);
    expect(await occurrences(id)).toHaveLength(5);
  });

  it("stops at the series end", async () => {
    const id = await saveSeries(
      huntSeries({ until: new Date(Date.now() + 8 * DAY).toISOString() }),
    );
    expect(await occurrences(id)).toHaveLength(2);
  });

  it("does not backfill slots that already ended", async () => {
    const id = await saveSeries(
      huntSeries({
        anchorAt: new Date(Date.now() - 30 * DAY).toISOString(),
        durationMinutes: 60,
      }),
    );
    for (const o of await occurrences(id)) {
      expect(new Date(o.ends_at).getTime()).toBeGreaterThan(Date.now());
    }
  });
});

describe("song hunt drafts", () => {
  it("stay inactive until curated, then go live", async () => {
    const id = await saveSeries(huntSeries());
    const [current] = await occurrences(id);
    expect(current.active).toBe(false);

    const before = await (await activeEvents(new Request("http://x"))).json();
    expect(before.events).toHaveLength(0);

    const res = await saveOccurrence(current, { config: CURATED });
    expect(res.status).toBe(200);

    const after = await (await activeEvents(new Request("http://x"))).json();
    expect(after.events.map((e: { id: string }) => e.id)).toEqual([current.id]);
  });

  it("ignore an `active` flag from the form", async () => {
    const id = await saveSeries(huntSeries());
    const [current] = await occurrences(id);
    await saveOccurrence(current, { active: true });
    const [reread] = await occurrences(id);
    expect(reread.active).toBe(false);
  });
});

describe("skipping", () => {
  it("takes a curated occurrence off the air and survives re-materializing", async () => {
    const id = await saveSeries(huntSeries());
    const [current] = await occurrences(id);
    await saveOccurrence(current, { config: CURATED });
    await saveOccurrence(current, { config: CURATED, skipped: true });

    await materialize(id);
    const [reread] = await occurrences(id);
    expect(reread).toMatchObject({ skipped: true, active: false });

    await saveOccurrence(current, { config: CURATED, skipped: false });
    const [unskipped] = await occurrences(id);
    expect(unskipped).toMatchObject({ skipped: false, active: true });
  });
});

describe("deleting an occurrence", () => {
  it("removes it for good — the next materialize run doesn't bring it back", async () => {
    const id = await saveSeries(huntSeries());
    const [current, next] = await occurrences(id);

    const res = await deleteEventRoute(
      adminRequest(`events?id=${current.id}`, undefined, "DELETE"),
    );
    expect(res.status).toBe(200);

    expect(await materialize(id)).toBe(0);
    const ids = (await occurrences(id)).map((o) => o.id);
    expect(ids).not.toContain(current.id);
    expect(ids).toContain(next.id);
    expect(ids).toHaveLength(4);
  });
});

describe("editing a series", () => {
  it("regenerates only future occurrences nobody touched", async () => {
    const series = huntSeries({
      anchorAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const id = await saveSeries(series);
    const [first, second, third] = await occurrences(id);
    await saveOccurrence(first, { title: "Hand edited" });
    await saveOccurrence(second, { skipped: true });

    await saveSeries({ ...series, id, title: "Renamed" });

    const after = await occurrences(id);
    const byId = new Map(after.map((o) => [o.id, o]));
    expect(byId.get(first.id)?.title).toBe("Hand edited");
    expect(byId.get(second.id)?.skipped).toBe(true);
    expect(byId.has(third.id)).toBe(false);
    expect(after.filter((o) => o.title === "Renamed")).toHaveLength(2);
  });

  it("does not double up kept occurrences when the schedule shifts", async () => {
    const anchor = Date.now() + HOUR;
    const series = huntSeries({ anchorAt: new Date(anchor).toISOString() });
    const id = await saveSeries(series);
    const [first] = await occurrences(id);
    await saveOccurrence(first, { title: "Hand edited" });

    await saveSeries({
      ...series,
      id,
      anchorAt: new Date(anchor + 3 * HOUR).toISOString(),
    });

    const after = await occurrences(id);
    expect(after).toHaveLength(4);
    expect(after[0].id).toBe(first.id);
  });

  it("deleting keeps touched occurrences, unlinked", async () => {
    const id = await saveSeries(
      huntSeries({ anchorAt: new Date(Date.now() + HOUR).toISOString() }),
    );
    const [first] = await occurrences(id);
    await saveOccurrence(first, { title: "Keep me" });

    const res = await deleteSeriesRoute(
      adminRequest(`event-series?id=${id}`, undefined, "DELETE"),
    );
    expect(res.status).toBe(200);

    const { data } = await admin()
      .from("events")
      .select("id, series_id")
      .eq("id", first.id)
      .single();
    expect(data).toEqual({ id: first.id, series_id: null });
    const { count } = await admin()
      .from("events")
      .select("id", { count: "exact", head: true });
    expect(count).toBe(1);
  });
});

describe("boss series", () => {
  function bossSeries(overrides: Record<string, unknown> = {}) {
    return {
      type: "boss_fight",
      title: "Nohoot Henry",
      anchorAt: new Date(Date.now() + HOUR).toISOString(),
      intervalDays: 7,
      durationMinutes: 4 * 24 * 60,
      configTemplate: { rewardItemId: "cd", topCount: 3 },
      ...overrides,
    };
  }

  it("rolls genres, sizes HP and creates the HP pool", async () => {
    const id = await saveSeries(bossSeries());
    const [first] = await occurrences(id);
    expect(first.active).toBe(true);
    expect(first.config.hatedGenres).toHaveLength(3);
    expect(first.config.hatedGenres).not.toContain("pop");

    const { data: state } = await admin()
      .from("boss_state")
      .select("max_hp")
      .eq("event_id", first.id)
      .single();
    expect(state!.max_hp).toBe(first.config.maxHp);
  });

  it("rolls different genres for different weeks", async () => {
    // Regression: the roll once sorted before unnesting, so every boss got
    // the pool's first three genres. Four identical 3-of-14 picks by chance
    // is ~1 in 50 million.
    const id = await saveSeries(bossSeries());
    const picks = (await occurrences(id)).map((o) =>
      JSON.stringify(o.config.hatedGenres),
    );
    expect(picks.length).toBe(4);
    expect(new Set(picks).size).toBeGreaterThan(1);
  });

  it("uses the template's HP and genres when set", async () => {
    const id = await saveSeries(
      bossSeries({
        configTemplate: {
          rewardItemId: "cd",
          topCount: 3,
          maxHp: 1234,
          hatedGenres: ["jazz"],
        },
      }),
    );
    const [first] = await occurrences(id);
    expect(first.config).toMatchObject({ maxHp: 1234, hatedGenres: ["jazz"] });
  });

  it("does not create a slot overlapping a hand-made boss", async () => {
    const start = Date.now() + HOUR;
    await admin().rpc("create_boss_event", {
      p_title: "Custom",
      p_description: null,
      p_starts_at: new Date(start + DAY).toISOString(),
      p_ends_at: new Date(start + 2 * DAY).toISOString(),
    });

    const id = await saveSeries(
      bossSeries({ anchorAt: new Date(start).toISOString() }),
    );
    const slots = await occurrences(id);
    expect(
      slots.some((o) => new Date(o.occurrence_at).getTime() === start),
    ).toBe(false);
    expect(slots.length).toBe(3);
  });

  it("refuses reward items that are not in the catalog", async () => {
    const res = await saveSeriesRoute(
      adminRequest(
        "event-series",
        bossSeries({ configTemplate: { rewardItemId: "no-such-item" } }),
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe("upcoming", () => {
  it("lists the next occurrence per type without any config", async () => {
    await saveSeries({
      type: "boss_fight",
      title: "Nohoot Henry",
      anchorAt: new Date(Date.now() + DAY).toISOString(),
      intervalDays: 7,
      durationMinutes: 60,
      configTemplate: { rewardItemId: "cd", hatedGenres: ["jazz"] },
    });
    const hunt = await saveSeries(
      huntSeries({ anchorAt: new Date(Date.now() + 2 * DAY).toISOString() }),
    );
    const [next] = await occurrences(hunt);
    await saveOccurrence(next, { config: CURATED });

    const body = await (await activeEvents(new Request("http://x"))).json();
    expect(body.upcoming.map((e: { type: string }) => e.type).sort()).toEqual([
      "boss_fight",
      "song_hunt",
    ]);
    for (const e of body.upcoming) {
      expect(e.config).toEqual({});
    }
  });
});
