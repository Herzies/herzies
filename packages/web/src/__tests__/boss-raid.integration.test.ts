/**
 * Integration tests for the cave raid (00122): the lobby and the lock, who's
 * in and who's out, revives, wipes, the payout to those still in, and the
 * statue.
 *
 * Requires: `npx supabase start`
 */
import { bossMaxHp } from "@herzies/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
} from "./integration-helpers";

const admin = () => getAdminClient();

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** A boss event starting `startsInMs` from now (negative: already started). */
async function spawnBoss(startsInMs = 0, hp = 30_000) {
  const event = await rpc<string>("spawn_boss_fight", {
    p_hated_genres: ["rock", "jazz", "metal"],
    p_hp: hp,
    p_ends_at: new Date(Date.now() + 3_600_000).toISOString(),
    p_title: "Raid Boss",
  });
  await admin()
    .from("events")
    .update({
      starts_at: new Date(Date.now() + startsInMs).toISOString(),
      config: {
        hatedGenres: ["rock", "jazz", "metal"],
        rewardItemId: "first-edition",
        maxHp: hp,
      },
    })
    .eq("id", event);
  return event;
}

async function player(overrides: Record<string, unknown> = {}) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, { level: 10, ...overrides });
  return user.userId;
}

type Lock = { hp: number; maxHp: number; at: number; roster: string[] };

const lock = (event: string, uids: string[], perPlayer = 10_000) =>
  rpc<Lock>("lock_boss_fight", {
    p_event: event,
    p_uids: uids,
    p_per_player: perPlayer,
    p_at: Date.now(),
  });

async function participants(event: string) {
  const { data } = await admin()
    .from("boss_participants")
    .select("user_id, status")
    .eq("event_id", event);
  return Object.fromEntries((data ?? []).map((r) => [r.user_id, r.status]));
}

async function state(event: string) {
  const { data } = await admin()
    .from("boss_state")
    .select("*")
    .eq("event_id", event)
    .single();
  return data as {
    hp: number;
    max_hp: number;
    killed: boolean;
    escaped: boolean;
    locked_at: string | null;
    revives: number;
  };
}

async function herzie(uid: string) {
  const { data } = await admin()
    .from("herzies")
    .select("hp, down")
    .eq("user_id", uid)
    .single();
  return data as { hp: number; down: boolean };
}

async function clearBosses() {
  await admin().from("boss_fight_log").delete().neq("roster_size", -1);
  await admin().from("boss_participants").delete().neq("status", "");
  await admin().from("boss_state").delete().neq("hp", -1);
  await admin().from("boss_damage").delete().neq("damage", -1);
  await admin().from("boss_damage_batches").delete().neq("batch", "");
  await admin()
    .from("event_claims")
    .delete()
    .neq("user_id", crypto.randomUUID());
  await admin().from("pending_drops").delete().not("source_event", "is", null);
  await admin().from("events").delete().eq("type", "boss_fight");
}

describe("the cave raid", () => {
  beforeEach(clearBosses);
  afterAll(async () => {
    await clearBosses();
    await cleanupTestData();
  });

  describe("the lobby", () => {
    it("opens fifteen minutes before the start, not before", async () => {
      const soon = await spawnBoss(10 * 60_000);
      const open = await rpc<{ event: string; starts: number } | null>(
        "open_boss_json",
        {},
      );
      expect(open?.event).toBe(soon);
      expect(open?.starts).toBeGreaterThan(Date.now() / 1000);
      expect(open).not.toHaveProperty("locked");

      await admin()
        .from("events")
        .update({ starts_at: new Date(Date.now() + 20 * 60_000).toISOString() })
        .eq("id", soon);
      expect(await rpc("open_boss_json", {})).toBeNull();
    });

    it("carries the genres, one per phase", async () => {
      await spawnBoss(60_000);
      const open = await rpc<{ hated: string[] }>("open_boss_json", {});
      expect(open.hated).toEqual(["rock", "jazz", "metal"]);
    });

    it("closes for good if nobody locked it soon after the start", async () => {
      await spawnBoss(-3 * 60_000);
      expect(await rpc("open_boss_json", {})).toBeNull();
    });
  });

  describe("the lock", () => {
    it("sets the boss's health from the roster, once", async () => {
      const event = await spawnBoss();
      const [a, b, c] = [await player(), await player(), await player()];
      const first = await lock(event, [a, b, c]);
      expect(first.maxHp).toBe(bossMaxHp(3, 10_000));
      expect(first.hp).toBe(first.maxHp);
      expect([...first.roster].sort()).toEqual([a, b, c].sort());

      // A second lock (a room that restarted) gets the first one back.
      const d = await player();
      const again = await lock(event, [d], 50_000);
      expect(again).toEqual(first);
      expect(await participants(event)).toEqual({
        [a]: "in",
        [b]: "in",
        [c]: "in",
      });
    });

    it("prefers the event's own health per herzie", async () => {
      const event = await spawnBoss();
      await admin()
        .from("events")
        .update({
          config: {
            hatedGenres: ["rock"],
            rewardItemId: "cd",
            maxHp: 1,
            hpPerPlayer: 7_000,
          },
        })
        .eq("id", event);
      const [a, b] = [await player(), await player()];
      expect((await lock(event, [a, b])).maxHp).toBe(bossMaxHp(2, 7_000));
    });

    it("with nobody in, the boss escapes", async () => {
      const event = await spawnBoss();
      await lock(event, []);
      expect((await state(event)).escaped).toBe(true);
      expect(await rpc("open_boss_json", {})).toBeNull();
    });

    it("tells a restarted room who's in, and the revives spent", async () => {
      const event = await spawnBoss();
      const [a, b] = [await player(), await player()];
      await lock(event, [a, b]);
      await rpc("mark_boss_out", { p_event: event, p_uids: [b] });
      const open = await rpc<{
        locked: { roster: string[]; revives: number; at: number };
      }>("open_boss_json", {});
      expect(open.locked.roster).toEqual([a]);
      expect(open.locked.revives).toBe(0);
      expect(open.locked.at).toBeGreaterThan(0);
    });
  });

  describe("out, revives and wipes", () => {
    it("revives a downed herzie that's in, once per batch", async () => {
      const event = await spawnBoss();
      const a = await player({ hp: 0, down: true });
      await lock(event, [a]);
      const args = {
        p_batch: `rez:${crypto.randomUUID()}`,
        p_event: event,
        p_rows: [{ uid: a, hp: 40 }],
      };
      const r = await rpc<{ applied: boolean; refused: string[] }>(
        "apply_boss_revive_batch",
        args,
      );
      expect(r).toEqual({ applied: true, refused: [] });
      expect(await herzie(a)).toEqual({ hp: 40, down: false });
      expect((await state(event)).revives).toBe(1);

      const again = await rpc<{ applied: boolean }>(
        "apply_boss_revive_batch",
        args,
      );
      expect(again.applied).toBe(false);
      expect((await state(event)).revives).toBe(1);
    });

    it("respawning in town takes a herzie out; a revive then is refused", async () => {
      const event = await spawnBoss();
      const a = await player({ hp: 0, down: true });
      await lock(event, [a]);
      await rpc("respawn_herzie", { p_user: a });
      expect(await participants(event)).toEqual({ [a]: "out" });
      const r = await rpc<{ refused: string[] }>("apply_boss_revive_batch", {
        p_batch: `rez:${crypto.randomUUID()}`,
        p_event: event,
        p_rows: [{ uid: a, hp: 10 }],
      });
      expect(r.refused).toEqual([a]);
      expect(await rpc("boss_out_json", { p_event: event })).toEqual([a]);
    });

    it("nobody goes out once the boss has fallen", async () => {
      const event = await spawnBoss(0, 100);
      const a = await player();
      await lock(event, [a], 100);
      await rpc("apply_boss_damage_batch", {
        p_batch: `dmg:${crypto.randomUUID()}`,
        p_event: event,
        p_damage: [{ uid: a, damage: 1_000 }],
      });
      expect((await state(event)).killed).toBe(true);
      expect(await rpc("mark_boss_out", { p_event: event, p_uids: [a] })).toBe(
        0,
      );
      expect(await participants(event)).toEqual({ [a]: "in" });
    });

    it("a wipe ends the event with nothing paid", async () => {
      const event = await spawnBoss();
      const a = await player();
      await lock(event, [a]);
      expect(await rpc("wipe_boss_fight", { p_event: event })).toBe(true);
      expect((await state(event)).escaped).toBe(true);
      expect(await rpc("settle_boss_fight", { p_event_id: event })).toBe(0);
      expect(await rpc("open_boss_json", {})).toBeNull();
    });
  });

  describe("the payout and the statue", () => {
    it("pays everyone still in, alike, and nobody who's out", async () => {
      const event = await spawnBoss(0, 100);
      const [a, b, c] = [await player(), await player(), await player()];
      await lock(event, [a, b, c], 100);
      await rpc("mark_boss_out", { p_event: event, p_uids: [c] });
      // b dealt nothing but stayed in (knocked out, waiting): still paid.
      await rpc("apply_boss_damage_batch", {
        p_batch: `dmg:${crypto.randomUUID()}`,
        p_event: event,
        p_damage: [
          { uid: a, damage: 1_000 },
          { uid: c, damage: 50 },
        ],
      });
      expect(await rpc("settle_boss_fight", { p_event_id: event })).toBe(2);
      const { data } = await admin()
        .from("pending_drops")
        .select("user_id, item_id")
        .eq("source_event", event);
      const count = (uid: string) =>
        (data ?? []).filter((d) => d.user_id === uid).length;
      expect(count(a)).toBe(11);
      expect(count(b)).toBe(11);
      expect(count(c)).toBe(0);
    });

    it("minion damage counts toward contribution, not against the boss", async () => {
      const event = await spawnBoss(0, 1_000);
      const a = await player();
      await lock(event, [a], 1_000);
      const before = (await state(event)).hp;
      await rpc("apply_boss_damage_batch", {
        p_batch: `dmg:${crypto.randomUUID()}`,
        p_event: event,
        p_damage: [{ uid: a, damage: 0, adds: 500 }],
      });
      expect((await state(event)).hp).toBe(before);
      const { data } = await admin()
        .from("boss_damage")
        .select("adds")
        .eq("event_id", event)
        .eq("user_id", a)
        .single();
      expect(data?.adds).toBe(500);
    });

    it("the statue is the top contributor still in, of a boss that fell", async () => {
      const event = await spawnBoss(0, 100);
      const [a, b] = [await player(), await player()];
      await lock(event, [a, b], 100);
      // b out-hit a, then gave up: the statue is a's.
      await rpc("apply_boss_damage_batch", {
        p_batch: `dmg:${crypto.randomUUID()}`,
        p_event: event,
        p_damage: [{ uid: b, damage: 90 }],
      });
      await rpc("mark_boss_out", { p_event: event, p_uids: [b] });
      await rpc("apply_boss_damage_batch", {
        p_batch: `dmg:${crypto.randomUUID()}`,
        p_event: event,
        p_damage: [{ uid: a, damage: 200 }],
      });
      const champ = await rpc<{ event: string; name: string }>(
        "boss_champion_json",
        {
          p_skip: [],
        },
      );
      expect(champ.event).toBe(event);
      const { data } = await admin()
        .from("herzies")
        .select("name")
        .eq("user_id", a)
        .single();
      expect(champ.name).toBe(data?.name);
    });

    it("a wiped fight puts nobody on the statue", async () => {
      const event = await spawnBoss();
      const a = await player();
      await lock(event, [a]);
      await rpc("apply_boss_damage_batch", {
        p_batch: `dmg:${crypto.randomUUID()}`,
        p_event: event,
        p_damage: [{ uid: a, damage: 10 }],
      });
      await rpc("wipe_boss_fight", { p_event: event });
      expect(await rpc("boss_champion_json", { p_skip: [] })).toBeNull();
    });
  });

  it("logs a fight once", async () => {
    const event = await spawnBoss();
    const log = {
      event,
      roster: 4,
      outcome: "victory",
      lockedAt: Date.now() - 400_000,
      endedAt: Date.now(),
      downs: 3,
      revives: 2,
    };
    expect(await rpc("log_boss_fight", { p_event: event, p_log: log })).toBe(
      true,
    );
    expect(await rpc("log_boss_fight", { p_event: event, p_log: log })).toBe(
      false,
    );
    const { data } = await admin()
      .from("boss_fight_log")
      .select("roster_size, outcome, stats")
      .eq("event_id", event)
      .single();
    expect(data).toEqual({
      roster_size: 4,
      outcome: "victory",
      stats: { downs: 3, revives: 2 },
    });
  });
});
