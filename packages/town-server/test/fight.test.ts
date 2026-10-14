import type { ServerMessage, TownTicketPayload } from "@herzies/shared/town-net";
import { describe, expect, it } from "vitest";
import { TUNING } from "../src/boss";
import {
  ESCAPE_LINGER_MS,
  FightRuntime,
  type Outbound,
  REPORT_EVERY_MS,
  VICTORY_LINGER_MS,
} from "../src/fight";

const T0 = 5_000_000;

const claim = (over: Partial<NonNullable<TownTicketPayload["boss"]>> = {}) => ({
  event: "evt-1",
  until: (T0 + 3_600_000) / 1000,
  hp: 10_000,
  maxHp: 10_000,
  ...over,
});

const ticket = (
  uid: string,
  hp = 200,
  over: Partial<TownTicketPayload> = {},
): TownTicketPayload => ({
  uid,
  name: uid,
  look: { seed: "s", stage: 1 },
  exp: 9e9,
  hp: { hp, maxHp: 200, down: false },
  st: [0, 0, 0, 0],
  ...over,
});

const msgs = (out: Outbound[], t: ServerMessage["t"]) =>
  out.filter((o) => o.msg.t === t);

/** Step 50ms at a time to `until`, collecting everything said. */
function run(f: FightRuntime, from: number, until: number): Outbound[] {
  const out: Outbound[] = [];
  for (let t = from; t <= until; t += 50) out.push(...f.step(t));
  return out;
}

describe("joining", () => {
  it("starts from the ticket's health", () => {
    const f = new FightRuntime(claim(), T0);
    expect(f.join("a", 1, ticket("a", 120), { x: 0, z: 8 }, T0).hp).toBe(120);
  });

  it("a rejoin before the leave was reported can't heal you", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", 120), { x: 0, z: 8 }, T0);
    f.leave("a");
    // The database hasn't heard yet, so a ticket still says full health.
    expect(f.join("a", 1, ticket("a", 200), { x: 0, z: 8 }, T0 + 500).hp).toBe(
      120,
    );
  });

  it("once the leave is reported, the ticket is the truth (resting heals)", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", 120), { x: 0, z: 8 }, T0);
    f.leave("a");
    f.reported(f.report(T0 + 10, true) as NonNullable<ReturnType<typeof f.report>>);
    expect(f.join("a", 1, ticket("a", 200), { x: 0, z: 8 }, T0 + 60_000).hp).toBe(
      200,
    );
  });

  it("a knocked-out ticket is knocked out", () => {
    const f = new FightRuntime(claim(), T0);
    const a = f.join(
      "a",
      1,
      ticket("a", 0, { hp: { hp: 0, maxHp: 200, down: true } }),
      { x: 0, z: 8 },
      T0,
    );
    expect(a.down).toBe(true);
  });

  it("tells a newcomer how the fight stands", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a"), { x: 0, z: 8 }, T0);
    const s = f.state(T0 + 5);
    expect(s).toMatchObject({ hp: 10_000, maxHp: 10_000, phase: 1, now: T0 + 5 });
    expect(s.health).toEqual([{ id: 1, hp: 200, maxHp: 200 }]);
  });
});

describe("a fight", () => {
  it("telegraphs to everyone, then damages and tells everyone", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a"), { x: 0, z: 8 }, T0);
    const out: Outbound[] = [];
    for (let t = T0; t <= T0 + 8_000; t += 50) {
      f.onState("a", 0, 8, t);
      out.push(...f.step(t));
    }
    const tg = msgs(out, "telegraph");
    expect(tg.length).toBeGreaterThan(0);
    expect(tg.every((o) => o.to === "all")).toBe(true);
    const hp = msgs(out, "hp");
    expect(hp[0].msg).toMatchObject({ t: "hp", id: 1, hp: 160, maxHp: 200 });
    expect(msgs(out, "resolve")[0].msg).toMatchObject({ t: "resolve", hits: [1] });
  });

  it("knocks a player out at 0 and tells only them, and reports at once", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", 30), { x: 0, z: 8 }, T0);
    f.report(T0, true);
    const out: Outbound[] = [];
    for (let t = T0; t <= T0 + 8_000; t += 50) {
      f.onState("a", 0, 8, t);
      out.push(...f.step(t));
    }
    const down = msgs(out, "down");
    expect(down).toHaveLength(1);
    expect(down[0].to).toEqual({ uid: "a" });
    expect(f.player("a")?.down).toBe(true);
    const r = f.report(T0 + 8_001);
    expect(r?.hp).toEqual([{ uid: "a", hp: 0 }]);
    // A fallen player is no longer targeted or counted.
    expect(f.cast("a", 0, 0, T0 + 9_000)).toBe("ignored");
  });

  it("a cast tells the shooter and totals the damage for the report", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a"), { x: 0, z: 8 }, T0 - 5_000);
    f.onState("a", 0, 8, T0);
    const dx = TUNING.boss.x - 0;
    const dz = TUNING.boss.z - 8;
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(TUNING.boss.chest - 1.2, Math.hypot(dx, dz));
    expect(f.cast("a", yaw, pitch, T0)).toBe("hit");
    const out = f.step(T0 + 1_000);
    expect(msgs(out, "hit")[0].to).toEqual({ uid: "a" });
    expect(msgs(out, "boss")).toHaveLength(1);
    const r = f.report(T0 + 1_000, true);
    expect(r?.boss?.damage).toHaveLength(1);
    expect(r?.boss?.damage[0].uid).toBe("a");
    expect(r?.boss?.event).toBe("evt-1");
  });

  it("re-sends the same batch until a report lands, then moves on", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a"), { x: 0, z: 8 }, T0 - 5_000);
    f.onState("a", 0, 8, T0);
    const yaw = Math.atan2(0, TUNING.boss.z - 8);
    const pitch = Math.atan2(TUNING.boss.chest - 1.2, Math.abs(TUNING.boss.z - 8));
    f.cast("a", yaw, pitch, T0);
    f.step(T0 + 1_000);
    const first = f.report(T0 + 1_000, true);
    const retry = f.report(T0 + 2_000, true);
    expect(retry?.boss?.batch).toBe(first?.boss?.batch);
    // More damage while the first is in flight waits behind it.
    f.cast("a", yaw, pitch, T0 + 1_500);
    f.step(T0 + 2_500);
    expect(f.report(T0 + 2_500, true)?.boss?.batch).toBe(first?.boss?.batch);
    f.reported(first as NonNullable<typeof first>);
    const next = f.report(T0 + 3_000, true);
    expect(next?.boss?.batch).not.toBe(first?.boss?.batch);
    expect(next?.boss?.damage).toHaveLength(1);
    f.reported(next as NonNullable<typeof next>);
    expect(f.report(T0 + 4_000, true)?.boss).toBeUndefined();
    expect(f.unreported).toBe(false);
  });

  it("reports a leaver's last health once, then forgets them", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", 90), { x: 0, z: 8 }, T0);
    f.leave("a");
    const r = f.report(T0 + 10, true) as NonNullable<ReturnType<typeof f.report>>;
    expect(r.hp).toEqual([{ uid: "a", hp: 90 }]);
    f.reported(r);
    expect(f.report(T0 + 20, true)?.hp).toEqual([]);
  });

  it("reports on a timer, not every step", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a"), { x: 0, z: 8 }, T0);
    expect(f.report(T0 + 100)).toBeNull();
    expect(f.report(T0 + REPORT_EVERY_MS + 1)).not.toBeNull();
  });
});

describe("how it ends", () => {
  it("a kill is announced, and the room closes after a victory lap", () => {
    const f = new FightRuntime(claim({ hp: 40, maxHp: 10_000 }), T0);
    f.join("a", 1, ticket("a", 200, { st: [0, 0, 0, 0] }), { x: 0, z: 8 }, T0 - 5_000);
    f.onState("a", 0, 8, T0);
    const yaw = Math.atan2(0, TUNING.boss.z - 8);
    const pitch = Math.atan2(TUNING.boss.chest - 1.2, Math.abs(TUNING.boss.z - 8));
    f.cast("a", yaw, pitch, T0);
    const out = f.step(T0 + 1_000);
    const v = msgs(out, "victory");
    expect(v).toHaveLength(1);
    expect(v[0].msg).toMatchObject({ by: 1, closesAt: T0 + 1_000 + VICTORY_LINGER_MS });
    expect(f.open).toBe(false);
    expect(f.closeWhy).toBe("victory");
    // Nothing more happens, and no more casts count.
    expect(msgs(run(f, T0 + 1_050, T0 + 20_000), "telegraph")).toEqual([]);
    expect(f.cast("a", yaw, pitch, T0 + 2_000)).toBe("ignored");
  });

  /** A fight that `a` and `b` are in and `a` has just won. */
  function won() {
    const f = new FightRuntime(claim({ hp: 40, maxHp: 10_000 }), T0);
    f.join("a", 1, ticket("a"), { x: 0, z: 8 }, T0 - 5_000);
    f.join("b", 2, ticket("b"), { x: 2, z: 8 }, T0 - 5_000);
    f.onState("a", 0, 8, T0);
    const yaw = Math.atan2(0, TUNING.boss.z - 8);
    const pitch = Math.atan2(TUNING.boss.chest - 1.2, Math.abs(TUNING.boss.z - 8));
    f.cast("a", yaw, pitch, T0);
    f.step(T0 + 1_000);
    return f;
  }

  const cd = (id: string) => ({ id, item: "cd" });

  it("the loot goes to each herzie still here, once", () => {
    const f = won();
    f.leave("b");
    const mine = [cd("d1"), { id: "d2", item: "clouds" }];
    const out = f.loot({ a: mine, b: [cd("d3")], c: [cd("d4")] });
    expect(out).toEqual([{ to: { uid: "a" }, msg: { t: "loot", drops: mine } }]);
    expect(f.loot({ a: [cd("d5")] })).toEqual([]);
  });

  it("no loot before the boss has fallen", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a"), { x: 0, z: 8 }, T0);
    expect(f.loot({ a: [cd("d1")] })).toEqual([]);
    // ...and that early answer doesn't use up the real one.
    expect(won().loot({ a: [cd("d1")] })).toHaveLength(1);
  });

  it("the local-dev boss drops a CD for everyone on the kill", () => {
    const f = new FightRuntime(claim({ event: "dev", hp: 40 }), T0);
    f.join("a", 1, ticket("a"), { x: 0, z: 8 }, T0 - 5_000);
    f.onState("a", 0, 8, T0);
    const yaw = Math.atan2(0, TUNING.boss.z - 8);
    const pitch = Math.atan2(TUNING.boss.chest - 1.2, Math.abs(TUNING.boss.z - 8));
    f.cast("a", yaw, pitch, T0);
    expect(msgs(f.step(T0 + 1_000), "loot")).toEqual([
      { to: { uid: "a" }, msg: { t: "loot", drops: [cd("")] } },
    ]);
  });

  it("the boss escapes when the event ends", () => {
    const f = new FightRuntime(claim({ until: (T0 + 10_000) / 1000 }), T0);
    f.join("a", 1, ticket("a"), { x: 0, z: 8 }, T0);
    const out = run(f, T0, T0 + 11_000);
    const c = msgs(out, "closing");
    expect(c).toHaveLength(1);
    expect(c[0].msg).toMatchObject({ why: "escaped" });
    expect(f.closesAt).toBeGreaterThanOrEqual(T0 + 10_000 + ESCAPE_LINGER_MS - 100);
    expect(f.closeWhy).toBe("escaped");
  });
});

describe("being knocked out and coming back", () => {
  /** Die in the room: stand in the slam until it takes everything. */
  function dieInRoom(f: FightRuntime) {
    for (let t = T0; t <= T0 + 8_000; t += 50) {
      f.onState("a", 0, 8, t);
      f.step(t);
    }
    expect(f.player("a")?.down).toBe(true);
  }

  it("a respawned herzie can walk back in without being knocked out again", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", 30), { x: 0, z: 8 }, T0);
    dieInRoom(f);
    // The database is told, then they respawn in town and leave the room.
    const told = f.report(T0 + 8_100, true) as NonNullable<ReturnType<typeof f.report>>;
    expect(told.hp).toEqual([{ uid: "a", hp: 0 }]);
    f.reported(told);
    f.leave("a");
    // The leave must not send the stale 0 that would knock them out again.
    const leaving = f.report(T0 + 8_200, true) as NonNullable<ReturnType<typeof f.report>>;
    expect(leaving.hp).toEqual([]);
    expect(f.unreported).toBe(false);
    // They come back with the 50% the database gave them.
    const back = f.join("a", 1, ticket("a", 100), { x: 0, z: 10 }, T0 + 60_000);
    expect(back).toMatchObject({ hp: 100, down: false });
    // ...and are reported like anyone else from then on.
    expect(
      f.report(T0 + 61_000, true)?.hp,
    ).toEqual([{ uid: "a", hp: 100 }]);
  });

  it("while the overlay is up the periodic reports leave them alone too", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", 30), { x: 0, z: 8 }, T0);
    dieInRoom(f);
    const told = f.report(T0 + 8_100, true) as NonNullable<ReturnType<typeof f.report>>;
    f.reported(told);
    // Respawn happens in the database; the room keeps ticking for a while.
    expect(f.report(T0 + 11_000)?.hp).toEqual([]);
    expect(f.report(T0 + 14_000)?.hp).toEqual([]);
  });

  it("an unacknowledged knock-out is still reported (and retried)", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", 30), { x: 0, z: 8 }, T0);
    dieInRoom(f);
    expect(f.report(T0 + 8_100, true)?.hp).toEqual([{ uid: "a", hp: 0 }]);
    // No reply: it goes again.
    expect(f.report(T0 + 10_100, true)?.hp).toEqual([{ uid: "a", hp: 0 }]);
  });
});
