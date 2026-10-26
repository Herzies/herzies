/**
 * The cave raid's rules in the fight runtime: the lobby and the lock, who
 * may come in, out and wipes, Resurrect, Taunt, the music the boss hates,
 * its lines, and what's reported.
 */
import {
  BOSS_OUT_GRACE_MS,
  bossMaxHp,
  IN_TUNE,
} from "@herzies/shared/boss-fight";
import { bossLineMs } from "@herzies/shared/boss-lines";
import { MAX_DAMAGE_REDUCTION, SKILL_DEFS } from "@herzies/shared/skills";
import type {
  BossClaim,
  ServerMessage,
  TownTicketPayload,
} from "@herzies/shared/town-net";
import { armed } from "./arms";
import { describe, expect, it } from "vitest";
import { BossEngine, type BossPlayer, mitigatedHit, TUNING } from "../src/boss";
import {
  ABSENT_STANDING_MS,
  CHANNEL_SLACK,
  FightRuntime,
  LOCK_GRACE_MS,
  type Outbound,
  SAY_READ_MS,
  WIPE_LINGER_MS,
} from "../src/fight";

const T0 = 5_000_000;
const STARTS = T0 + 60_000;

const claim = (over: Partial<BossClaim> = {}): BossClaim => ({
  event: "evt-raid",
  until: (T0 + 3_600_000) / 1000,
  hp: 30_000,
  maxHp: 30_000,
  starts: STARTS / 1000,
  hpPerPlayer: 10_000,
  ...over,
});

const ticket = (
  uid: string,
  cls: string | undefined,
  sk: [string, number][] = [],
  over: Partial<TownTicketPayload> = {},
): TownTicketPayload =>
  armed({
    uid,
    name: uid,
    look: { seed: "s", stage: 2 },
    exp: 9e9,
    hp: { hp: 200, maxHp: 200, down: false },
    st: [0, 0, 0, 0],
    cls,
    sk,
    ...over,
  });

const of = (out: Outbound[], t: ServerMessage["t"]) =>
  out.filter((o) => o.msg.t === t).map((o) => o.msg);

/** Step 50 ms at a time through [from, until], keeping everyone where they
 * stand, collecting everything said. */
function run(
  f: FightRuntime,
  from: number,
  until: number,
  where: Record<string, { x: number; z: number }> = {},
): Outbound[] {
  const out: Outbound[] = [];
  for (let t = from; t <= until; t += 50) {
    for (const [uid, at] of Object.entries(where)) f.onState(uid, at.x, at.z, t);
    out.push(...f.step(t));
  }
  return out;
}

/** A raid locked with these herzies standing where given (far from the
 * boss, so its slams take a while to find them). */
function locked(
  players: { uid: string; cls?: string; sk?: [string, number][]; x?: number; z?: number }[],
) {
  const f = new FightRuntime(claim(), T0, 7);
  players.forEach((p, i) =>
    f.join(p.uid, i + 1, ticket(p.uid, p.cls, p.sk ?? []), { x: p.x ?? i * 2, z: p.z ?? 9 }, T0),
  );
  const out = f.step(STARTS);
  return { f, out };
}

describe("the lobby", () => {
  it("lets anyone on their feet in, but not a downed herzie", () => {
    const f = new FightRuntime(claim(), T0);
    expect(f.stage).toBe("lobby");
    expect(f.mayJoin("a", false, T0)).toBe("ok");
    expect(f.mayJoin("a", true, T0)).toBe("down");
  });

  it("shuts at its start, even before the room's next tick locks it", () => {
    // Nobody inside when the lobby ran out: whoever walks in late isn't in.
    const f = new FightRuntime(claim(), T0);
    expect(f.mayJoin("late", false, STARTS - 1)).toBe("ok");
    expect(f.mayJoin("late", false, STARTS)).toBe("locked");
    expect(f.mayJoin("late", false, STARTS + 18_000)).toBe("locked");
  });

  it("the boss sleeps: it can't be hurt and doesn't attack", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", "bard"), { x: 0, z: 9 }, T0);
    const out = run(f, T0, T0 + 20_000, { a: { x: 0, z: 9 } });
    expect(of(out, "telegraph")).toEqual([]);
    expect(f.cast("a", Math.PI, 0.1, T0 + 20_000)).toBe("miss");
    expect(f.engine.hp).toBe(30_000);
  });

  it("the boss stays silent until it wakes, then speaks", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", "bard"), { x: 0, z: 9 }, T0);
    expect(of(run(f, T0, STARTS - 100, { a: { x: 0, z: 9 } }), "say")).toEqual([]);
    const woke = run(f, STARTS, STARTS + 1_000, { a: { x: 0, z: 9 } });
    expect(f.stage).toBe("fight");
    expect(of(woke, "say").length).toBeGreaterThan(0);
  });
});

describe("the boss's lines", () => {
  it("two that matter at once are both said, one after the other", () => {
    const { f } = locked([{ uid: "a" }]);
    const boss = f.engine as BossEngine;
    // A new phase, and its minions, in the same blow.
    boss.setHealth(boss.maxHp * 0.67, boss.maxHp);
    const t = STARTS + 10_000;
    const out = [...f.step(t)];
    boss.setHealth(boss.maxHp * 0.49, boss.maxHp);
    out.push(...f.step(t + 50));
    // Force both: a phase line and a minion line.
    (f as unknown as { speak: (k: string, n: number, o: Outbound[], x: boolean) => void }).speak("phase", t + 100, out, true);
    (f as unknown as { speak: (k: string, n: number, o: Outbound[], x: boolean) => void }).speak("minions", t + 110, out, true);
    const first = of(out, "say").length;
    out.push(...run(f, t + 150, t + 6_000));
    const says = of(out, "say") as Extract<ServerMessage, { t: "say" }>[];
    expect(says.length).toBeGreaterThan(first);
    // Never two within the read time of each other.
    const at = says.map((m) => m.until - bossLineMs(m.text));
    for (let i = 1; i < at.length; i++)
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(SAY_READ_MS);
  });
});

describe("the lock", () => {
  it("locks to whoever stands in the room and sizes the boss to them", () => {
    const { f, out } = locked([{ uid: "a" }, { uid: "b" }, { uid: "c" }]);
    expect(f.stage).toBe("fight");
    expect(f.engine.maxHp).toBe(bossMaxHp(3, 10_000));
    expect(f.engine.hp).toBe(f.engine.maxHp);
    const raid = of(out, "raid").at(-1) as Extract<ServerMessage, { t: "raid" }>;
    expect(raid).toMatchObject({ stage: "fight", roster: 3, standing: 3 });
    const report = f.report(STARTS, true);
    expect(report?.lock).toMatchObject({ event: "evt-raid", hpPerPlayer: 10_000 });
    expect([...(report?.lock?.uids ?? [])].sort()).toEqual(["a", "b", "c"]);
  });

  it("after the lock only the roster may come in, down or not", () => {
    const { f } = locked([{ uid: "a" }]);
    expect(f.mayJoin("a", true, T0)).toBe("ok");
    expect(f.mayJoin("late", false, T0)).toBe("locked");
  });

  it("someone who left during the lobby isn't in", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", "bard"), { x: 0, z: 9 }, T0);
    f.join("b", 2, ticket("b", "bard"), { x: 2, z: 9 }, T0);
    f.leave("b", T0 + 1_000);
    f.step(STARTS);
    expect(f.mayJoin("b", false, T0)).toBe("locked");
    expect(f.engine.maxHp).toBe(bossMaxHp(1, 10_000));
  });

  it("with nobody here, there's no fight", () => {
    const f = new FightRuntime(claim(), T0);
    const out = f.step(STARTS);
    expect(f.stage).toBe("over");
    expect(f.closeWhy).toBe("escaped");
    expect(of(out, "closing")).toHaveLength(1);
  });

  it("a room that restarted mid-fight picks up the roster", () => {
    const f = new FightRuntime(
      claim({ locked: { at: STARTS / 1000, roster: ["a", "b"], revives: 1 } }),
      STARTS + 60_000,
    );
    expect(f.stage).toBe("fight");
    expect(f.mayJoin("a", true, T0)).toBe("ok");
    expect(f.mayJoin("c", false, T0)).toBe("locked");
  });

  it("after a restart, a downed herzie back first doesn't trip a wipe; one who never returns goes out", () => {
    const t = STARTS + 60_000;
    const f = new FightRuntime(
      claim({ locked: { at: STARTS / 1000, roster: ["a", "b"], revives: 0 } }),
      t,
    );
    f.join(
      "b",
      2,
      ticket("b", "bard", [], { hp: { hp: 0, maxHp: 200, down: true } }),
      { x: 0, z: 9 },
      t,
    );
    f.step(t + 100);
    expect(f.closeWhy).toBeNull();
    // "a" never comes back: out after the grace, and then it's a wipe.
    f.step(t + BOSS_OUT_GRACE_MS + 100);
    expect(f.report(t + BOSS_OUT_GRACE_MS + 150, true)?.out?.uids).toEqual(["a"]);
    expect(f.closeWhy).toBe("wiped");
  });

  it("a downed fighter's body stays put", () => {
    const { f } = locked([{ uid: "a" }, { uid: "b" }]);
    expect(f.frozen("a")).toBe(false);
    (f.player("a") as { down: boolean }).down = true;
    expect(f.frozen("a")).toBe(true);
  });

  it("takes the database's lock if it locked first with another roster", () => {
    const { f } = locked([{ uid: "a" }, { uid: "b" }]);
    const report = f.report(STARTS, true);
    if (!report) throw new Error("no report");
    const out = f.reported(report, {
      lock: { hp: 9_000, maxHp: 9_000, roster: ["a"], at: STARTS },
      out: [],
    });
    expect(of(out, "out")).toHaveLength(1);
    expect(f.mayJoin("b", false, T0)).toBe("locked");
    expect(f.engine.maxHp).toBe(9_000);
  });
});

describe("out, and a wipe", () => {
  it("gone longer than the grace: out, and told to the database", () => {
    const { f } = locked([{ uid: "a" }, { uid: "b" }]);
    f.leave("b", STARTS + 1_000);
    f.step(STARTS + 1_000 + BOSS_OUT_GRACE_MS - 100);
    expect(f.mayJoin("b", false, T0)).toBe("ok");
    f.step(STARTS + 1_000 + BOSS_OUT_GRACE_MS + 100);
    expect(f.mayJoin("b", false, T0)).toBe("locked");
    expect(f.report(STARTS + 1_000 + BOSS_OUT_GRACE_MS + 100, true)?.out).toEqual({
      event: "evt-raid",
      uids: ["b"],
    });
  });

  it("a downed herzie can give up; a standing one can't", () => {
    const { f } = locked([{ uid: "a" }, { uid: "b" }]);
    expect(f.forfeit("a", STARTS + 10)).toEqual([]);
    const b = f.player("b");
    if (!b) throw new Error("no b");
    b.down = true;
    const out = f.forfeit("b", STARTS + 20);
    expect(of(out, "out")).toHaveLength(1);
    expect(f.mayJoin("b", true, T0)).toBe("locked");
  });

  it("when everyone in is down, the boss wins", () => {
    const { f } = locked([{ uid: "a" }]);
    const a = f.player("a");
    if (!a) throw new Error("no a");
    a.down = true;
    const out = f.step(STARTS + 100);
    expect(f.closeWhy).toBe("wiped");
    expect(f.closesAt).toBe(STARTS + 100 + WIPE_LINGER_MS);
    expect(of(out, "closing")).toMatchObject([{ why: "wiped" }]);
    expect(f.report(STARTS + 200, true)?.wipe).toEqual({ event: "evt-raid" });
  });

  it("a standing herzie who briefly dropped out still holds off a wipe", () => {
    const { f } = locked([{ uid: "a" }, { uid: "b" }]);
    (f.player("a") as { down: boolean }).down = true;
    f.leave("b", STARTS + 100);
    f.step(STARTS + 200);
    expect(f.closeWhy).toBeNull();
  });
});

describe("Resurrect", () => {
  const rez = (level = 1): [string, number][] => [
    ["soothing-drones", level],
    ["resurrect", level],
  ];

  function downed() {
    const { f } = locked([
      { uid: "bard", cls: "bard", sk: rez(), x: 0, z: 9 },
      { uid: "tank", cls: "percussionist", x: 1, z: 9 },
      { uid: "dps", cls: "record_slinger", x: 8, z: 9 },
    ]);
    const tank = f.player("tank");
    if (!tank) throw new Error("no tank");
    tank.down = true;
    tank.hp = 0;
    return f;
  }

  it("plays a downed herzie nearby back up after its channel", () => {
    const f = downed();
    const at = { bard: { x: 0, z: 9 }, tank: { x: 1, z: 9 } };
    const start = STARTS + 100;
    const used = f.skill("bard", "resurrect", 0, 0, start);
    expect(used.result).toBe("used");
    expect(of(used.out, "channel")).toMatchObject([{ by: 1, target: 2 }]);
    const out = run(f, start, start + SKILL_DEFS.resurrect.channelMs! + 100, at);
    expect(of(out, "revived")).toMatchObject([{ id: 2, by: 1 }]);
    const tank = f.player("tank");
    expect(tank?.down).toBe(false);
    expect(tank?.hp).toBe(Math.round(200 * 0.3));
    const report = f.report(start + 4_000, true);
    expect(report?.revived?.rows).toEqual([{ uid: "tank", hp: 60 }]);
  });

  it("moving cancels it, and costs no cooldown", () => {
    const f = downed();
    const start = STARTS + 100;
    f.skill("bard", "resurrect", 0, 0, start);
    const out = run(f, start, start + 1_000, {
      bard: { x: 0, z: 9 + CHANNEL_SLACK + 0.5 },
    });
    expect(of(out, "channel")).toMatchObject([{ by: 1, target: null }]);
    expect(f.player("tank")?.down).toBe(true);
    expect(f.skill("bard", "resurrect", 0, 0, start + 1_100).result).toBe("used");
  });

  it("with nobody downed near enough, it's refused (no cooldown, no strike)", () => {
    const { f } = locked([{ uid: "bard", cls: "bard", sk: rez() }, { uid: "x" }]);
    const r = f.skill("bard", "resurrect", 0, 0, STARTS + 100);
    expect(r).toMatchObject({ result: "refused", reason: "no-target" });
  });

  it("has no limit: the same herzie, brought back again and again", () => {
    const f = downed();
    const at = { bard: { x: 0, z: 9 }, tank: { x: 1, z: 9 } };
    for (let i = 0; i < 5; i++) {
      const t = STARTS + 100 + i * 40_000;
      const tank = f.player("tank");
      const bard = f.player("bard");
      if (!tank || !bard) throw new Error("missing");
      tank.down = true;
      tank.hp = 0;
      // The boss is still swinging: keep the Bard standing for the test.
      bard.down = false;
      bard.hp = bard.maxHp;
      expect(f.skill("bard", "resurrect", 0, 0, t).result).toBe("used");
      const out = run(f, t, t + 3_200, at);
      expect(of(out, "revived")).toHaveLength(1);
      expect(f.player("tank")?.down).toBe(false);
    }
  });

  it("isn't a lobby skill", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("bard", 1, ticket("bard", "bard", rez()), { x: 0, z: 9 }, T0);
    expect(f.skill("bard", "resurrect", 0, 0, T0 + 10)).toMatchObject({
      result: "refused",
      reason: "not-yet",
    });
  });

  it("a revive the database refuses (they'd respawned) puts them out", () => {
    const f = downed();
    const start = STARTS + 100;
    f.skill("bard", "resurrect", 0, 0, start);
    run(f, start, start + 3_200, { bard: { x: 0, z: 9 }, tank: { x: 1, z: 9 } });
    const report = f.report(start + 3_300, true);
    if (!report) throw new Error("no report");
    f.reported(report, { refused: ["tank"], out: ["tank"] });
    expect(f.mayJoin("tank", false, T0)).toBe("locked");
  });
});

describe("Taunt", () => {
  const tank = (uid: string, x: number) => ({
    uid,
    cls: "percussionist",
    sk: [
      ["cymbrella", 1],
      ["taunt", 1],
    ] as [string, number][],
    x,
    z: 9,
  });

  it("turns the boss on its caster; the last taunt wins", () => {
    const { f } = locked([tank("t1", -3), tank("t2", 3), { uid: "dps", x: 0, z: 12 }]);
    const where = { t1: { x: -3, z: 9 }, t2: { x: 3, z: 9 }, dps: { x: 0, z: 12 } };
    const t = STARTS + 100;
    f.skill("t1", "taunt", 0, 0, t);
    run(f, t, t + 200, where);
    expect((f.engine as BossEngine).focus).toBe("t1");
    const second = f.skill("t2", "taunt", 0, 0, t + 300);
    // The first holder's taunt comes off.
    expect(of(second.out, "buffOff")).toMatchObject([{ id: 1, buff: "taunt" }]);
    run(f, t + 300, t + 600, where);
    expect((f.engine as BossEngine).focus).toBe("t2");
  });

  it("aims the buster at the taunter, even alone", () => {
    const { f } = locked([tank("t1", 0)]);
    // The first buster comes after the opening and its own clock (13 s):
    // a taunt cast a few seconds in draws it.
    const t = STARTS + 4_000;
    f.skill("t1", "taunt", 0, 0, t);
    const out = run(f, t, t + 10_000, { t1: { x: 0, z: 9 } });
    const busters = of(out, "telegraph").filter(
      (m) => (m as { kind: string }).kind === "buster",
    );
    expect(busters.length).toBeGreaterThan(0);
    expect(busters.every((m) => (m as { target?: number }).target === 1)).toBe(true);
  });

  it("ends when its caster goes down", () => {
    const { f } = locked([tank("t1", 0), { uid: "dps", x: 4, z: 12 }]);
    const t = STARTS + 100;
    f.skill("t1", "taunt", 0, 0, t);
    (f.player("t1") as { down: boolean }).down = true;
    const out = run(f, t, t + 200, { dps: { x: 4, z: 12 } });
    expect(of(out, "buffOff")).toMatchObject([{ id: 1, buff: "taunt" }]);
    expect((f.engine as BossEngine).taunter(t + 200)).toBeNull();
  });

  it("tells everyone when the boss turns on someone else", () => {
    const { f } = locked([tank("t1", -3), tank("t2", 3)]);
    const where = { t1: { x: -3, z: 9 }, t2: { x: 3, z: 9 } };
    const t = STARTS + 100;
    run(f, STARTS, t, where);
    f.skill("t2", "taunt", 0, 0, t);
    const out = run(f, t, t + 300, where);
    const raids = of(out, "raid") as Extract<ServerMessage, { t: "raid" }>[];
    expect(raids.at(-1)).toMatchObject({ focus: 2, taunted: true });
  });

  it("lasts a minute", () => {
    const { f } = locked([tank("t1", 0), { uid: "dps", x: 4, z: 12 }]);
    const t = STARTS + 100;
    f.skill("t1", "taunt", 0, 0, t);
    const boss = f.engine as BossEngine;
    expect(boss.taunter(t + SKILL_DEFS.taunt.durationMs! - 10)).toBe("t1");
    expect(boss.taunter(t + SKILL_DEFS.taunt.durationMs! + 10)).toBeNull();
  });
});

describe("the music it hates", () => {
  it("in tune after the settle time, out after the linger", () => {
    const { f } = locked([{ uid: "dps", cls: "record_slinger", x: 0, z: 9 }]);
    const where = { dps: { x: 0, z: 9 } };
    const t = STARTS + 100;
    f.tune("dps", true, t);
    let out = run(f, t, t + IN_TUNE.settleMs - 100, where);
    expect(of(out, "buff")).toEqual([]);
    out = run(f, t + IN_TUNE.settleMs - 50, t + IN_TUNE.settleMs + 100, where);
    expect(of(out, "buff")).toMatchObject([
      { id: 1, buff: "in_tune", kind: "damage", value: IN_TUNE.damage },
    ]);
    const off = t + IN_TUNE.settleMs + 200;
    f.tune("dps", false, off);
    out = run(f, off, off + IN_TUNE.lingerMs - 100, where);
    expect(of(out, "buffOff")).toEqual([]);
    out = run(f, off + IN_TUNE.lingerMs - 50, off + IN_TUNE.lingerMs + 100, where);
    expect(of(out, "buffOff")).toMatchObject([{ id: 1, buff: "in_tune" }]);
  });

  it("counts time in tune for the log only once the fight is on", () => {
    const f = new FightRuntime(claim(), T0, 7);
    const tough = { hp: { hp: 1e6, maxHp: 1e6, down: false } };
    f.join("dps", 1, ticket("dps", "record_slinger", [], tough), { x: 0, z: 9 }, T0);
    const where = { dps: { x: 0, z: 9 } };
    // In tune all through the lobby (a minute), then 10 s of fight.
    f.tune("dps", true, T0);
    run(f, T0, STARTS + 10_000, where);
    expect(f.stage).toBe("fight");
    f.tune("dps", false, STARTS + 10_000);
    run(f, STARTS + 10_050, STARTS + 10_000 + IN_TUNE.lingerMs + 200, where);
    const log = (f as unknown as { log: { inTuneMs: Record<string, number> } }).log;
    // The fight's 10 s and the linger after, not the lobby's minute.
    const ms = log.inTuneMs.record_slinger;
    expect(ms).toBeGreaterThanOrEqual(10_000 + IN_TUNE.lingerMs - 100);
    expect(ms).toBeLessThanOrEqual(10_000 + IN_TUNE.lingerMs + 200);
  });

  it("no music, or no class, gets nothing", () => {
    const { f } = locked([
      { uid: "dps", cls: "record_slinger", x: 0, z: 9 },
      { uid: "none", x: 2, z: 9 },
    ]);
    const t = STARTS + 100;
    f.tune("dps", false, t);
    f.tune("none", true, t);
    const out = run(f, t, t + 5_000, { dps: { x: 0, z: 9 }, none: { x: 2, z: 9 } });
    expect(of(out, "buff")).toEqual([]);
  });

  it("a Record Slinger in tune hits a quarter harder", () => {
    const boss = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0, pinned: true });
    boss.buff("b", { id: "in_tune", kind: "damage", value: IN_TUNE.damage, until: T0 + 1e7 });
    // Melee from up close: the boss is at (0, -4), radius 2.2.
    const near = { x: 0, z: TUNING.boss.z + TUNING.boss.radius + 1 };
    const cast = (uid: string) =>
      boss.cast(uid, near, Math.PI, 0, { sonicPower: 0, critChance: 0, critDamage: 0 }, T0 + 1_000, "melee");
    expect(cast("a")).toBe("hit");
    expect(cast("b")).toBe("hit");
    const hits = boss.update(T0 + 1_000, []).filter((e) => e.t === "hit");
    const [a, b] = ["a", "b"].map(
      (u) => (hits.find((h) => h.t === "hit" && h.uid === u) as { damage: number }).damage,
    );
    // Within the hit's ±10% spread of each other, times the bonus.
    expect(b / a).toBeGreaterThan(IN_TUNE.damage * 0.8);
    expect(b / a).toBeLessThan(IN_TUNE.damage * 1.25);
  });

  it("a Percussionist in tune takes less, under the overall clamp", () => {
    const p: BossPlayer = { uid: "t", alive: true, maxHp: 1_000, def: 100, posAt: () => ({ x: 0, z: 0 }) };
    const tg = {
      id: 1,
      kind: "circle" as const,
      x: 0,
      z: 0,
      r: 3,
      inner: 0,
      at: 0,
      hitAt: 10,
      damage: 100,
    };
    const plain = mitigatedHit(p, tg, []);
    const tuned = mitigatedHit(p, tg, [
      { id: "in_tune", kind: "def", value: IN_TUNE.def, until: 1e9 },
    ]);
    expect(tuned.damage).toBeLessThan(plain.damage);
    const stacked = mitigatedHit(p, tg, [
      { id: "in_tune", kind: "def", value: IN_TUNE.def, until: 1e9 },
      { id: "cymbrella", value: 0.9, until: 1e9 },
    ]);
    expect(stacked.damage).toBe(Math.round(100 * (1 - MAX_DAMAGE_REDUCTION)));
  });

  it("a Bard in tune heals more", () => {
    const { f } = locked([
      { uid: "bard", cls: "bard", sk: [["soothing-drones", 1]], x: 0, z: 9 },
      { uid: "ally", x: 1, z: 9 },
    ]);
    const where = { bard: { x: 0, z: 9 }, ally: { x: 1, z: 9 } };
    const ally = f.player("ally");
    if (!ally) throw new Error("no ally");
    ally.hp = 10;
    const t = STARTS + 100;
    f.tune("bard", true, t);
    run(f, t, t + IN_TUNE.settleMs + 100, where);
    f.skill("bard", "soothing-drones", 0, 0, t + IN_TUNE.settleMs + 150);
    expect(ally.hp).toBeCloseTo(10 + 200 * 0.2 * IN_TUNE.heal, 5);
  });
});

describe("minions", () => {
  it("at half health the boss calls a pack, sized to the roster", () => {
    const { f } = locked([{ uid: "a" }, { uid: "b" }, { uid: "c" }, { uid: "d" }]);
    const boss = f.engine as BossEngine;
    const near = { x: 0, z: TUNING.boss.z + TUNING.boss.radius + 1 };
    boss.setHealth(boss.maxHp * 0.5 + 50, boss.maxHp);
    const t = STARTS + 4_000;
    f.onState("a", near.x, near.z, t);
    // Melee until it crosses half.
    const out = [];
    for (let i = 0; i < 6 && !boss.minionsUp; i++) {
      f.cast("a", Math.PI, 0, t + i * 600);
      out.push(...f.step(t + i * 600));
    }
    expect(boss.minionsUp).toBeGreaterThanOrEqual(2);
    expect(boss.minionsUp).toBeLessThanOrEqual(3);
    expect(of(out, "mobs").length).toBeGreaterThan(0);
    expect(of(out, "say").length).toBeGreaterThan(0);
    // A newcomer is told of them.
    expect(f.state(t + 4_000).mobs?.length).toBe(boss.minionsUp);
  });

  it("their damage counts as adds, and never touches the boss", () => {
    const { f } = locked([{ uid: "a" }]);
    const boss = f.engine as BossEngine;
    boss.summon(STARTS, 2, 10, 10, []);
    const hpBefore = boss.hp;
    // Wait for them to wake and walk in.
    const where = { a: { x: 0, z: 9 } };
    run(f, STARTS, STARTS + 3_000, where);
    const mob = boss.wireMobs()[0];
    const t = STARTS + 3_100;
    f.onState("a", mob.x, mob.z + 1.5, t);
    const out = [];
    for (let i = 0; i < 20 && boss.minionsUp; i++) {
      f.onState("a", boss.wireMobs()[0]?.x ?? 0, (boss.wireMobs()[0]?.z ?? 0) + 1.5, t + i * 600);
      f.cast("a", Math.PI, 0, t + i * 600);
      out.push(...f.step(t + i * 600));
    }
    expect(of(out, "mobDown").length).toBeGreaterThan(0);
    expect(boss.hp).toBe(hpBefore);
    const report = f.report(t + 20 * 600, true);
    const row = report?.boss?.damage.find((d) => d.uid === "a");
    expect(row?.adds ?? 0).toBeGreaterThan(0);
    expect(row?.damage ?? 0).toBe(0);
  });

  it("they crumble when the boss falls", () => {
    const { f } = locked([{ uid: "a", x: 0, z: TUNING.boss.z + TUNING.boss.radius + 1 }]);
    const boss = f.engine as BossEngine;
    boss.summon(STARTS, 3, 10, 10, []);
    boss.setHealth(1, boss.maxHp);
    const t = STARTS + 4_000;
    f.onState("a", 0, TUNING.boss.z + TUNING.boss.radius + 1, t);
    f.cast("a", Math.PI, 0, t);
    const out = f.step(t);
    expect(of(out, "victory")).toHaveLength(1);
    expect(of(out, "mobDown")).toHaveLength(3);
    expect(boss.minionsUp).toBe(0);
  });
});

describe("the end", () => {
  it("a victory logs the fight with the end screen's report", () => {
    const { f } = locked([{ uid: "a", x: 0, z: TUNING.boss.z + TUNING.boss.radius + 1 }]);
    const boss = f.engine as BossEngine;
    boss.setHealth(1, boss.maxHp);
    const t = STARTS + 4_000;
    f.onState("a", 0, TUNING.boss.z + TUNING.boss.radius + 1, t);
    f.cast("a", Math.PI, 0, t);
    const out = f.step(t);
    expect(of(out, "victory")).toHaveLength(1);
    expect(f.closeWhy).toBe("victory");
    const report = f.report(t + 10, true);
    expect(report?.results).toBeTruthy();
    expect(report?.log).toMatchObject({ outcome: "victory", roster: 1 });
  });
});

describe("production pass: restarts, absences and the lock", () => {
  it("a room picked up below a minion threshold doesn't call that pack again", () => {
    const t = STARTS + 60_000;
    const f = new FightRuntime(
      claim({
        hp: 12_000,
        maxHp: 30_000,
        locked: { at: STARTS / 1000, roster: ["a"], revives: 0 },
      }),
      t,
    );
    f.join("a", 1, ticket("a", "bard"), { x: 0, z: 9 }, t);
    const boss = f.engine as BossEngine;
    // 40% → 39%: past 50% long ago, not yet at 25%.
    boss.setHealth(11_700, 30_000);
    f.step(t + 100);
    expect(boss.minionsUp).toBe(0);
  });

  it("a raid that's all down doesn't wait two minutes on someone who dropped", () => {
    const { f } = locked([{ uid: "a" }, { uid: "b" }]);
    (f.player("a") as { down: boolean }).down = true;
    f.leave("b", STARTS + 100);
    f.step(STARTS + 100 + ABSENT_STANDING_MS - 100);
    expect(f.closeWhy).toBeNull();
    f.step(STARTS + 100 + ABSENT_STANDING_MS + 100);
    expect(f.closeWhy).toBe("wiped");
  });

  it("the grace runs out even if the room never ticked", () => {
    const { f } = locked([{ uid: "a" }, { uid: "b" }]);
    f.leave("b", STARTS + 1_000);
    expect(f.mayJoin("b", false, STARTS + 1_000 + BOSS_OUT_GRACE_MS + 1)).toBe(
      "locked",
    );
  });

  it("a lobby member who dropped just before the start is on the roster", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("a", 1, ticket("a", "bard"), { x: 0, z: 9 }, T0);
    f.join("b", 2, ticket("b", "bard"), { x: 2, z: 9 }, T0);
    f.join("c", 3, ticket("c", "bard"), { x: 4, z: 9 }, T0);
    f.leave("b", STARTS - LOCK_GRACE_MS / 2);
    f.leave("c", STARTS - LOCK_GRACE_MS * 2);
    f.step(STARTS);
    expect(f.mayJoin("a", false, STARTS + 10)).toBe("ok");
    expect(f.mayJoin("b", false, STARTS + 10)).toBe("ok");
    expect(f.mayJoin("c", false, STARTS + 10)).toBe("locked");
  });

  it("a member only the database knew of gets the grace, then is out", () => {
    const { f } = locked([{ uid: "a" }]);
    const report = f.report(STARTS, true);
    if (!report) throw new Error("no report");
    f.reported(report, {
      lock: { hp: 30_000, maxHp: 30_000, roster: ["a", "ghost"], at: STARTS },
      out: [],
    }, STARTS);
    const t = STARTS + BOSS_OUT_GRACE_MS + 500;
    f.step(t);
    expect(f.report(t + 50, true)?.out?.uids).toEqual(["ghost"]);
  });

  it("a downed herzie that reconnects comes back where it fell", () => {
    const { f } = locked([{ uid: "a", x: 3, z: 4 }, { uid: "b" }]);
    f.onState("a", 3, 4, STARTS + 50);
    (f.player("a") as { down: boolean }).down = true;
    f.leave("a", STARTS + 100);
    const at = f.rejoinAt("a");
    expect(at?.x).toBeCloseTo(3, 0);
    expect(at?.z).toBeCloseTo(4, 0);
    expect(f.rejoinAt("b")).toBeNull();
  });
});

describe("when the boss falls", () => {
  it("everyone still in and down gets up, to reach their loot", () => {
    const { f } = locked([{ uid: "a" }, { uid: "b" }, { uid: "c" }]);
    for (const uid of ["b", "c"]) {
      const p = f.player(uid) as { down: boolean; hp: number };
      p.down = true;
      p.hp = 0;
    }
    // c gave up: out, and stays down.
    f.forfeit("c", STARTS + 50);
    const boss = f.engine as BossEngine;
    boss.setHealth(1, boss.maxHp);
    f.onState("a", 0, TUNING.boss.z + TUNING.boss.radius + 1, STARTS + 100);
    const out = [];
    for (let i = 0; i < 10 && !f.closeWhy; i++) {
      f.cast("a", Math.PI, 0, STARTS + 100 + i * 600);
      out.push(...f.step(STARTS + 100 + i * 600));
    }
    expect(f.closeWhy).toBe("victory");
    expect(f.player("b")?.down).toBe(false);
    expect(f.player("b")?.hp).toBeGreaterThan(0);
    expect(f.player("c")?.down).toBe(true);
    expect(of(out, "revived")).toMatchObject([{ id: 2, by: -1 }]);
    // Told to the database like a resurrect.
    expect(f.report(STARTS + 7_000, true)?.revived?.rows).toMatchObject([
      { uid: "b" },
    ]);
  });
});
