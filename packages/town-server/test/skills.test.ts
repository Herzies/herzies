import {
  CAST_INTERVAL_MS,
  DOME,
  HEAL_BOLT,
  tauntPointsPerSecond,
  WAVE_HAND_HEIGHT,
} from "@herzies/shared/combat";
import {
  FOCUS_MAX,
  MULTISPIN,
  multispinRecords,
  RAGE_MAX,
  SKILL_COOLDOWN_GRACE_MS,
  SKILL_DEFS,
  skillValue,
  skillXpPerUse,
} from "@herzies/shared/skills";
import { timingAttackSpeed, timingCritChance } from "@herzies/shared/stats";
import type { ServerMessage, TownTicketPayload } from "@herzies/shared/town-net";
import { armed } from "./arms";
import { describe, expect, it } from "vitest";
import {
  BossEngine,
  type BossPlayer,
  castSpeed,
  focused,
  quickness,
  TUNING,
} from "../src/boss";
import { FightRuntime, type Outbound, statsOf } from "../src/fight";

const T0 = 5_000_000;

const claim = () => ({
  event: "evt-1",
  until: (T0 + 3_600_000) / 1000,
  hp: 100_000,
  maxHp: 100_000,
});

const ticket = (
  uid: string,
  sk: [string, number][] = [],
  hp = 200,
): TownTicketPayload =>
  armed({
    uid,
    name: uid,
    look: { seed: "s", stage: 2 },
    exp: 9e9,
    hp: { hp, maxHp: 200, down: false },
    st: [0, 0, 0, 0],
    sk,
  });

const msgs = (out: Outbound[], t: ServerMessage["t"]) =>
  out.filter((o) => o.msg.t === t);

/** Aim from (x, z) at the boss's chest. */
function aim(x: number, z: number) {
  const dx = TUNING.boss.x - x;
  const dz = TUNING.boss.z - z;
  return {
    yaw: Math.atan2(dx, dz),
    pitch: Math.atan2(TUNING.boss.chest - WAVE_HAND_HEIGHT, Math.hypot(dx, dz)),
  };
}

/** A fight with a bard at (0, 8) and whoever else, everyone hurt to `hp`. */
function setup(others: { uid: string; x: number; z: number }[] = [], hp = 100) {
  const f = new FightRuntime(claim(), T0);
  f.join("bard", 1, ticket("bard", [["soothing-drones", 1]], hp), { x: 0, z: 8 }, T0 - 5_000);
  f.onState("bard", 0, 8, T0);
  others.forEach((o, i) => {
    f.join(o.uid, i + 2, ticket(o.uid, [], hp), o, T0 - 5_000);
    f.onState(o.uid, o.x, o.z, T0);
  });
  return f;
}

describe("Soothing Drones", () => {
  it("heals everyone in reach by a share of their max HP, and no one beyond", () => {
    const f = setup([
      { uid: "near", x: 3, z: 8 },
      { uid: "far", x: 0, z: -4 },
    ]);
    const { result, out } = f.skill("bard", "soothing-drones", 0, 0, T0);
    expect(result).toBe("used");
    const heal = skillValue("soothing-drones", 1) * 200;
    expect(f.player("bard")?.hp).toBe(100 + heal);
    expect(f.player("near")?.hp).toBe(100 + heal);
    expect(f.player("far")?.hp).toBe(100);
    expect(msgs(out, "skill")[0]).toMatchObject({
      to: "all",
      msg: { t: "skill", by: 1, skill: "soothing-drones", level: 1 },
    });
    expect(msgs(out, "hp")).toHaveLength(2);
  });

  it("what it restored counts as the healer's support, in the boss batch", () => {
    const f = setup([{ uid: "near", x: 3, z: 8 }]);
    f.skill("bard", "soothing-drones", 0, 0, T0);
    const restored = 2 * skillValue("soothing-drones", 1) * 200;
    // No damage, and the boss's HP untouched: only who healed, and how much.
    expect(f.report(T0 + 1, true)?.boss?.damage).toEqual([
      { uid: "bard", damage: 0, healing: restored },
    ]);
    expect(f.engine.hp).toBe(100_000);
  });

  it("never heals past full, and overheal earns no XP", () => {
    const f = setup([], 200);
    f.skill("bard", "soothing-drones", 0, 0, T0);
    expect(f.player("bard")?.hp).toBe(200);
    expect(f.report(T0 + 1, true)?.skills).toBeUndefined();
  });

  it("pays its use's XP once, however much it restored", () => {
    const f = setup([{ uid: "near", x: 3, z: 8 }]);
    f.skill("bard", "soothing-drones", 0, 0, T0);
    const r = f.report(T0 + 1, true);
    const per = skillXpPerUse("soothing-drones");
    expect(r?.skills?.xp ?? []).toEqual(
      per >= 1
        ? [{ uid: "bard", skill: "soothing-drones", xp: Math.floor(per) }]
        : [],
    );
    const near = r?.hp.find((h) => h.uid === "near");
    expect(near).toEqual({ uid: "near", hp: 140, heal: 40 });
    // Once the database has it, the allowance is spent.
    f.reported(r as NonNullable<typeof r>);
    expect(f.report(T0 + 2, true)?.hp.find((h) => h.uid === "near")).toEqual({
      uid: "near",
      hp: 140,
    });
  });

  it("doesn't raise the fallen", () => {
    const f = setup([{ uid: "near", x: 3, z: 8 }]);
    const near = f.player("near");
    if (near) {
      near.hp = 0;
      near.down = true;
    }
    f.skill("bard", "soothing-drones", 0, 0, T0);
    expect(f.player("near")?.hp).toBe(0);
  });
});

describe("cooldowns and ownership", () => {
  it("refuses a skill the herzie doesn't have", () => {
    const f = setup([{ uid: "other", x: 3, z: 8 }]);
    expect(f.skill("other", "soothing-drones", 0, 0, T0).result).toBe("unknown");
    expect(f.skill("bard", "cymbrella", 0, 0, T0).result).toBe("unknown");
  });

  it("refuses a skill on cooldown, forgiving a slightly early one", () => {
    const f = setup();
    const cd = SKILL_DEFS["soothing-drones"].cooldownMs;
    expect(f.skill("bard", "soothing-drones", 0, 0, T0).result).toBe("used");
    expect(f.skill("bard", "soothing-drones", 0, 0, T0 + 1_000).result).toBe(
      "cooldown",
    );
    expect(
      f.skill("bard", "soothing-drones", 0, 0, T0 + cd - SKILL_COOLDOWN_GRACE_MS / 2)
        .result,
    ).toBe("early");
    expect(f.skill("bard", "soothing-drones", 0, 0, T0 + cd).result).toBe("used");
  });

  it("takes the level from the ticket, and a reported level-up raises it", () => {
    const f = setup();
    const out = f.skillUps([{ uid: "bard", skill: "soothing-drones", level: 4 }]);
    expect(out).toEqual([
      { to: { uid: "bard" }, msg: { t: "skillUp", skill: "soothing-drones", level: 4 } },
    ]);
    expect(f.skill("bard", "soothing-drones", 0, 0, T0).out[0].msg).toMatchObject({
      level: 4,
    });
    // An older ticket can't take it back.
    f.renew("bard", ticket("bard", [["soothing-drones", 1]]));
    expect(f.player("bard")?.skills.get("soothing-drones")).toBe(4);
  });
});

describe("Cymbrella", () => {
  it("puts up a dome where its caster stands, and says so", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("tank", 1, ticket("tank", [["cymbrella", 10]]), { x: 0, z: 8 }, T0 - 5_000);
    f.onState("tank", 0, 8, T0);
    const { out } = f.skill("tank", "cymbrella", 0, 0, T0);
    const ms = skillValue("cymbrella", 10) * 1000;
    // An older app reads the buff as its cymbal: all damage off.
    expect(msgs(out, "buff")[0].msg).toEqual({
      t: "buff",
      id: 1,
      buff: "cymbrella",
      value: 1,
      until: T0 + ms,
    });
    expect(f.state(T0 + 10).buffs).toHaveLength(1);
  });
});

describe("Euphony", () => {
  it("strengthens a Drones heal", () => {
    const f = new FightRuntime(claim(), T0);
    const bard = { ...ticket("bard", [["soothing-drones", 1]], 50) };
    bard.st = [0, 0, 0, 0, 0, 0, 50];
    f.join("bard", 1, bard, { x: 0, z: 8 }, T0 - 5_000);
    f.onState("bard", 0, 8, T0);
    f.skill("bard", "soothing-drones", 0, 0, T0);
    // 50 Euphony: half again.
    const heal = skillValue("soothing-drones", 1) * 1.5 * 200;
    expect(f.player("bard")?.hp).toBeCloseTo(50 + heal);
  });
});

describe("ticket stats", () => {
  it("reads Def, Euphony and Timing when the ticket has them", () => {
    expect(statsOf([12, 5, 3, 50, 20, 20, 8, 30])).toEqual({
      sonicPower: 12,
      critChance: 3,
      critDamage: 50,
      def: 20,
      euphony: 8,
      timing: 30,
    });
    // From before Timing: none.
    expect(statsOf([12, 5, 3, 50, 20, 20, 8]).timing).toBe(0);
  });

  it("reads them as 0 on a ticket from before stat points, or no stats", () => {
    expect(statsOf([12, 5, 3, 50])).toEqual({
      sonicPower: 12,
      critChance: 3,
      critDamage: 50,
      def: 0,
      euphony: 0,
      timing: 0,
    });
    expect(statsOf(undefined).def).toBe(0);
  });
});

describe("Backspin", () => {
  it("throws three discs that land for a share of a hit", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("dj", 1, ticket("dj", [["backspin", 1]]), { x: 0, z: 8 }, T0 - 5_000);
    f.onState("dj", 0, 8, T0);
    const { yaw, pitch } = aim(0, 8);
    expect(f.skill("dj", "backspin", yaw, pitch, T0).result).toBe("used");
    const out = f.step(T0 + 2_000);
    expect(msgs(out, "hit")).toHaveLength(3);
  });
});

describe("skill XP", () => {
  it("pays each use that did something once, whatever it hit, carrying fractions to whole points", () => {
    const f = new FightRuntime(claim(), T0);
    // Tough enough to stand through ten uses beside the boss.
    f.join("dj", 1, ticket("dj", [["backspin", 1]], 1e9), { x: 0, z: 8 }, T0 - 5_000);
    const { yaw, pitch } = aim(0, 8);
    const per = skillXpPerUse("backspin");
    const every = SKILL_DEFS.backspin.cooldownMs + 100;
    let paid = 0;
    for (let i = 0; i < 10; i++) {
      const t = T0 + i * every;
      f.onState("dj", 0, 8, t);
      expect(f.skill("dj", "backspin", yaw, pitch, t).result).toBe("used");
      f.step(t + 2_000);
      const r = f.report(t + 2_001, true);
      paid += r?.skills?.xp.find((x) => x.uid === "dj")?.xp ?? 0;
      if (r) f.reported(r);
    }
    expect(paid).toBe(Math.floor(10 * per + 1e-9));
  });

  it("pays nothing for a use that hit nothing", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("dj", 1, ticket("dj", [["backspin", 1]], 1e9), { x: 0, z: 8 }, T0 - 5_000);
    const every = SKILL_DEFS.backspin.cooldownMs + 100;
    for (let i = 0; i < 10; i++) {
      const t = T0 + i * every;
      f.onState("dj", 0, 8, t);
      // Aimed away from the boss.
      expect(f.skill("dj", "backspin", 0, 0, t).result).toBe("used");
      f.step(t + 2_000);
    }
    expect(f.report(T0 + 10 * every, true)?.skills).toBeUndefined();
  });
});

describe("the boss's side", () => {
  const player = (uid: string, at: { x: number; z: number }): BossPlayer => ({
    uid,
    alive: true,
    maxHp: 200,
    posAt: () => at,
  });

  /** The first resolve with hits on it, running from T0. */
  const firstHits = (boss: BossEngine, players: BossPlayer[], until = 10_000) => {
    for (let t = T0; t < T0 + until; t += 50)
      for (const ev of boss.update(t, players))
        if (ev.t === "resolve" && ev.hits.length) return ev.hits;
    return [];
  };

  it("under a dome a slam lands nothing, and all of it is the dome's", () => {
    const boss = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0 });
    boss.addDome("tank", 0, 8, T0, 60_000);
    const a = player("a", { x: 1, z: 8 });
    const [hit] = firstHits(boss, [a]);
    expect(hit).toMatchObject({
      uid: "a",
      damage: 0,
      blocked: TUNING.slam.damage,
      shelteredBy: "tank",
    });
  });

  it("just outside a dome, a slam lands as ever", () => {
    const boss = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0 });
    boss.addDome("tank", 0, 8 + DOME.radius + 1.5, T0, 60_000);
    const a = player("a", { x: 0, z: 8 });
    const [hit] = firstHits(boss, [a]);
    expect(hit.damage).toBe(TUNING.slam.damage);
    expect(hit.shelteredBy).toBeUndefined();
  });

  it("in a fight, what the dome keeps off others pays its Percussionist", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("tank", 1, ticket("tank", [["cymbrella", 10]]), { x: 0, z: 8 }, T0 - 5_000);
    f.join("dps", 2, ticket("dps", [["backspin", 1]]), { x: 1, z: 8 }, T0 - 5_000);
    // Past the boss's opening, when its slams start coming.
    const at = T0 + TUNING.openingMs;
    for (let t = T0 - 1_000; t <= at; t += 50) {
      f.onState("tank", 0, 8, t);
      f.onState("dps", 1, 8, t);
      f.step(t);
    }
    expect(f.skill("tank", "cymbrella", 0, 0, at).result).toBe("used");
    const dps = f.player("dps");
    const before = dps?.hp;
    let sheltered = false;
    for (let t = at; t < at + 4_500; t += 50) {
      f.onState("tank", 0, 8, t);
      f.onState("dps", 1, 8, t);
      for (const o of f.step(t))
        if (o.msg.t === "resolve" && o.msg.sheltered?.length) sheltered = true;
    }
    expect(sheltered).toBe(true);
    expect(dps?.hp).toBe(before);
    const xp = f.report(at + 4_501, true)?.skills?.xp ?? [];
    expect(xp.find((x) => x.uid === "tank" && x.skill === "cymbrella")?.xp).toBeGreaterThan(0);
  });

  it("in a fight, holding the boss with a Taunt pays its Percussionist, per second held", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("tank", 1, ticket("tank", [["taunt", 1]]), { x: 0, z: 8 }, T0 - 5_000);
    f.join("dps", 2, ticket("dps", [["backspin", 1]]), { x: 4, z: 8 }, T0 - 5_000);
    // Hits land in full: keep the tank up through its taunt.
    for (const uid of ["tank", "dps"]) {
      const p = f.player(uid);
      if (p) {
        p.maxHp = 1e6;
        p.hp = 1e6;
      }
    }
    const at = T0 + TUNING.openingMs;
    for (let t = T0 - 1_000; t <= at; t += 50) {
      f.onState("tank", 0, 8, t);
      f.onState("dps", 4, 8, t);
      f.step(t);
    }
    expect(f.skill("tank", "taunt", 0, 0, at).result).toBe("used");
    // Past the taunt's end: it pays for the time it held, and no longer.
    for (let t = at; t < at + SKILL_DEFS.taunt.durationMs! + 2_000; t += 50) {
      f.onState("tank", 0, 8, t);
      f.onState("dps", 4, 8, t);
      f.step(t);
    }
    const rows = f.report(at + 20_000, true)?.boss?.damage ?? [];
    const held = SKILL_DEFS.taunt.durationMs! / 1000;
    const want = held * tauntPointsPerSecond(100_000, 2);
    const taunt = rows.find((r) => r.uid === "tank")?.taunt ?? 0;
    expect(taunt).toBeGreaterThan(want * 0.95);
    expect(taunt).toBeLessThan(want * 1.05);
    expect(rows.find((r) => r.uid === "dps")?.taunt).toBeUndefined();
  });

  it("keeps the boss out: it walks up to the edge, no further", () => {
    const boss = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0 });
    boss.addDome("tank", 0, 8, T0, 60_000);
    const a = player("a", { x: 0, z: 8 });
    for (let t = T0; t < T0 + 8_000; t += 50) {
      boss.update(t, [a]);
      const at = boss.position;
      expect(Math.hypot(at.x, at.z - 8)).toBeGreaterThanOrEqual(
        DOME.radius + TUNING.boss.radius - 0.01,
      );
    }
  });

  it("a dome put up on top of the boss shoves it out as it grows", () => {
    const boss = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0, pinned: true });
    const at = boss.position;
    boss.addDome("tank", at.x + 1, at.z, T0, 60_000);
    boss.update(T0 + 1_000, []);
    const now = boss.position;
    expect(Math.hypot(now.x - (at.x + 1), now.z - at.z)).toBeGreaterThanOrEqual(
      DOME.radius + TUNING.boss.radius - 0.01,
    );
  });

  it("aims a buster at whoever it hates most, once there's a party", () => {
    const boss = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 2, now: T0 });
    const players = [player("dps", { x: -4, z: 8 }), player("tank", { x: 4, z: 8 })];
    boss.addThreat("dps", 100);
    boss.addThreat("tank", TUNING.threat.cymbrella);
    let target: string | undefined;
    for (let t = T0; t < T0 + 30_000 && !target; t += 50) {
      for (const ev of boss.update(t, players))
        if (ev.t === "telegraph" && ev.telegraph.kind === "buster")
          target = ev.telegraph.target;
      // Keep the tank on top, as Cymbrella would.
      boss.addThreat("tank", 5);
    }
    expect(target).toBe("tank");
  });

  it("sends no busters at a lone herzie", () => {
    const boss = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 3, now: T0 });
    boss.addThreat("solo", 1_000);
    const solo = player("solo", { x: 0, z: 8 });
    for (let t = T0; t < T0 + 60_000; t += 50) {
      for (const ev of boss.update(t, [solo]))
        expect(ev.t === "telegraph" && ev.telegraph.kind === "buster").toBe(false);
    }
  });

  it("a buster lands on its target wherever it goes, and on no one else", () => {
    const boss = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 4, now: T0 });
    let tankAt = { x: 4, z: 8 };
    const tank: BossPlayer = { ...player("tank", tankAt), posAt: () => tankAt };
    const other = player("other", { x: 4, z: 8 });
    boss.addThreat("tank", 10_000);
    let busterId: number | undefined;
    let hits: { uid: string }[] | undefined;
    for (let t = T0; t < T0 + 30_000 && !hits; t += 50) {
      for (const ev of boss.update(t, [tank, other])) {
        if (ev.t === "telegraph" && ev.telegraph.kind === "buster") {
          busterId = ev.telegraph.id;
          // It runs: no escape.
          tankAt = { x: -8, z: 0 };
        }
        if (ev.t === "resolve" && ev.id === busterId) hits = ev.hits;
      }
    }
    expect(hits?.map((h) => h.uid)).toEqual(["tank"]);
  });
});

describe("the class's instrument", () => {
  const bare = (uid: string, stage: number, sk: [string, number][] = []) =>
    armed({
      ...ticket(uid, sk),
      cls: "bard",
      look: { seed: "s", stage, equipped: {} },
    });

  it("without it, no class skills: refused, no cooldown spent, no strike", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("bard", 1, bare("bard", 2, [["soothing-drones", 1]]), { x: 0, z: 8 }, T0 - 5_000);
    f.onState("bard", 0, 8, T0);
    const r = f.skill("bard", "soothing-drones", 0, 0, T0);
    expect(r).toMatchObject({ result: "refused", reason: "instrument" });
    expect(f.player("bard")?.ready.get("soothing-drones")).toBeUndefined();
  });

  it("without it, a body slam at stage 2 and a punch from stage 3", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("two", 1, bare("two", 2), { x: 0, z: 8 }, T0 - 5_000);
    f.join("three", 2, bare("three", 3), { x: 1, z: 8 }, T0 - 5_000);
    f.join("lute", 3, ticket("lute", [["soothing-drones", 1]]), { x: 2, z: 8 }, T0 - 5_000);
    expect(f.player("two")).toMatchObject({ attack: "melee", melee: 0.5, armed: false });
    expect(f.player("three")).toMatchObject({ attack: "melee", melee: 0.6, armed: false });
    expect(f.player("lute")).toMatchObject({ attack: "wave", armed: true });
  });

  it("putting it on mid-fight takes with the next ticket", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("bard", 1, bare("bard", 2, [["soothing-drones", 1]]), { x: 0, z: 8 }, T0 - 5_000);
    f.renew("bard", ticket("bard", [["soothing-drones", 1]]));
    expect(f.player("bard")).toMatchObject({ attack: "wave", armed: true });
    expect(f.player("bard")?.look.equipped?.main_hand).toBe("lute");
  });
});

describe("Haste", () => {
  const hasted = () => {
    const f = new FightRuntime(claim(), T0);
    f.join("bard", 1, ticket("bard", [["haste", 1]]), { x: 0, z: 8 }, T0 - 5_000);
    f.join("near", 2, ticket("near", [["backspin", 1]]), { x: 5, z: 8 }, T0 - 5_000);
    f.join("far", 3, ticket("far", [["backspin", 1]]), { x: 0, z: -12 }, T0 - 5_000);
    for (const [u, x, z] of [["bard", 0, 8], ["near", 5, 8], ["far", 0, -12]] as const)
      f.onState(u, x, z, T0);
    return f;
  };

  it("quickens everyone near, the Bard too, and tells the room", () => {
    const f = hasted();
    const { result, out } = f.skill("bard", "haste", 0, 0, T0);
    expect(result).toBe("used");
    const buffs = msgs(out, "buff").map((o) => o.msg);
    expect(buffs.map((m) => m.t === "buff" && m.id).sort()).toEqual([1, 2]);
    const v = skillValue("haste", 1);
    expect(f.engine.buffsOf("near", T0)).toEqual([
      expect.objectContaining({ id: "haste", value: v, by: "bard" }),
    ]);
    expect(f.engine.buffsOf("far", T0)).toEqual([]);
    expect(f.player("bard")?.ready.get("haste")).toBe(
      T0 + SKILL_DEFS.haste.cooldownMs,
    );
  });

  it("lets the hasted cast faster, and the unhasted not", () => {
    const pace = (haste: number) => {
      const e = new BossEngine({ hp: 1e9, maxHp: 1e9, seed: 1, now: T0 });
      if (haste) e.buff("a", { id: "haste", value: haste, until: T0 + 60_000 });
      const every = CAST_INTERVAL_MS / (1 + haste);
      let refused = 0;
      for (let i = 0; i < 40; i++) {
        const r = e.cast("a", { x: 0, z: 8 }, Math.PI, 0, statsOf(undefined), T0 + 1_000 + i * every);
        if (r === "cooldown") refused++;
      }
      return refused;
    };
    expect(pace(0)).toBe(0);
    expect(pace(0.4)).toBe(0);
    // Hasted pace without the haste: refused.
    const e = new BossEngine({ hp: 1e9, maxHp: 1e9, seed: 1, now: T0 });
    let refused = 0;
    for (let i = 0; i < 40; i++)
      if (e.cast("a", { x: 0, z: 8 }, Math.PI, 0, statsOf(undefined), T0 + 1_000 + i * (CAST_INTERVAL_MS / 1.4)) === "cooldown")
        refused++;
    expect(refused).toBeGreaterThan(5);
  });

  it("lets a herzie with Timing cast faster, and one without not", () => {
    // Well past the slack the server already gives (castEveryMs).
    const timing = 300;
    const every = CAST_INTERVAL_MS / (1 + timingAttackSpeed(timing));
    const refused = (stats: ReturnType<typeof statsOf>) => {
      const e = new BossEngine({ hp: 1e9, maxHp: 1e9, seed: 1, now: T0 });
      let n = 0;
      for (let i = 0; i < 40; i++)
        if (e.cast("a", { x: 0, z: 8 }, Math.PI, 0, stats, T0 + 1_000 + i * every) === "cooldown")
          n++;
      return n;
    };
    expect(refused(statsOf([0, 0, 0, 0, 0, 0, 0, timing]))).toBe(0);
    expect(refused(statsOf(undefined))).toBeGreaterThan(3);
  });

  it("holds a moment past its end, for a client a frame behind", () => {
    const buffs = [{ id: "haste" as const, value: 0.4, until: T0 + 5_000 }];
    expect(castSpeed(buffs, T0 + 5_100)).toBeCloseTo(1.4);
    expect(castSpeed(buffs, T0 + 6_000)).toBe(1);
  });

  it("pays its Bard for the share of the damage it added", () => {
    const f = hasted();
    f.skill("bard", "haste", 0, 0, T0);
    const { yaw, pitch } = aim(5, 8);
    // A fraction of an XP a hit: a dozen hasted hits make a point or two.
    for (let i = 0; i < 24; i++) {
      f.onState("near", 5, 8, T0 + 100 + i * 400);
      expect(f.cast("near", yaw, pitch, T0 + 100 + i * 400)).toBe("hit");
      f.step(T0 + 100 + i * 400);
    }
    f.step(T0 + 12_000);
    const xp = f.report(T0 + 12_001, true)?.skills?.xp ?? [];
    expect(xp.find((x) => x.uid === "bard" && x.skill === "haste")?.xp).toBeGreaterThan(0);
  });
});

describe("Haste's pay", () => {
  it("is once a cast, the first time someone it hasted lands a hit (a skill's too)", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("bard", 1, ticket("bard", [["haste", 1]]), { x: 0, z: 8 }, T0 - 5_000);
    f.join("near", 2, ticket("near", [["backspin", 10]]), { x: 5, z: 8 }, T0 - 5_000);
    f.onState("bard", 0, 8, T0);
    f.onState("near", 5, 8, T0);
    f.skill("bard", "haste", 0, 0, T0);
    const { yaw, pitch } = aim(5, 8);
    // Nobody hit anything yet: nothing.
    f.step(T0 + 50);
    expect(f.report(T0 + 51, true)?.skills).toBeUndefined();
    // Three discs and a dozen casts: still the one use.
    expect(f.skill("near", "backspin", yaw, pitch, T0 + 100).result).toBe("used");
    for (let i = 0; i < 12; i++) {
      f.onState("near", 5, 8, T0 + 200 + i * 400);
      f.cast("near", yaw, pitch, T0 + 200 + i * 400);
      f.step(T0 + 200 + i * 400);
    }
    f.step(T0 + 8_000);
    const xp = f.report(T0 + 8_001, true)?.skills?.xp ?? [];
    expect(xp.find((x) => x.uid === "bard" && x.skill === "haste")?.xp).toBe(
      Math.floor(skillXpPerUse("haste")),
    );
  });
});

describe("the lute's heal stance", () => {
  /** A Bard at (0, 8) and an ally at (0, 2), both hurt to 100 of 200. */
  const setup = () => {
    const f = new FightRuntime(claim(), T0);
    f.join("bard", 1, ticket("bard", [["soothing-drones", 1]], 100), { x: 0, z: 8 }, T0 - 5_000);
    f.join("ally", 2, ticket("ally", [["backspin", 1]], 100), { x: 0, z: 2 }, T0 - 5_000);
    for (let t = T0 - 1_000; t <= T0; t += 100) {
      f.onState("bard", 0, 8, t);
      f.onState("ally", 0, 2, t);
    }
    return f;
  };
  // Straight at the ally: from (0, 8) toward -z, level.
  const atAlly = { yaw: Math.PI, pitch: -0.03 };

  it("is a Bard's with its lute, and the room is told", () => {
    const f = setup();
    expect(f.stance("bard", true)).toEqual([
      { to: "all", msg: { t: "stance", id: 1, heal: true } },
    ]);
    // Again: nothing new to say.
    expect(f.stance("bard", true)).toEqual([]);
    expect(f.state(T0).healers).toEqual([1]);
    // Not a Bard: no stance to take.
    expect(f.stance("ally", true)).toEqual([]);
  });

  it("heals the ally aimed at once the bolt arrives, and hurts nothing", () => {
    const f = setup();
    f.stance("bard", true);
    const bossHp = f.engine.hp;
    expect(f.cast("bard", atAlly.yaw, atAlly.pitch, T0)).toBe("hit");
    expect(f.player("ally")?.hp).toBe(100);
    const out = f.step(T0 + 1_000);
    const heal = HEAL_BOLT * 200;
    expect(f.player("ally")?.hp).toBeCloseTo(100 + heal);
    expect(f.player("bard")?.hp).toBe(100);
    expect(f.engine.hp).toBe(bossHp);
    expect(msgs(out, "hp").map((o) => o.msg)).toContainEqual(
      expect.objectContaining({ t: "hp", id: 2 }),
    );
    expect(msgs(out, "hit")).toHaveLength(0);
    // It counts as the Bard's healing.
    const row = f.report(T0 + 1_001, true)?.boss?.damage.find((d) => d.uid === "bard");
    expect(row?.healing).toBeGreaterThan(0);
  });

  it("misses with nobody in the cone, and never heals its Bard", () => {
    const f = setup();
    f.stance("bard", true);
    expect(f.cast("bard", 0, 0, T0)).toBe("miss");
    f.step(T0 + 1_000);
    expect(f.player("bard")?.hp).toBe(100);
  });

  it("never heals past full", () => {
    const f = setup();
    f.stance("bard", true);
    const ally = f.player("ally");
    if (ally) ally.hp = 199;
    f.cast("bard", atAlly.yaw, atAlly.pitch, T0);
    f.step(T0 + 1_000);
    expect(f.player("ally")?.hp).toBe(200);
  });

  it("keeps to the pace of a wave", () => {
    const f = setup();
    f.stance("bard", true);
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      const t = T0 + i * CAST_INTERVAL_MS;
      f.onState("bard", 0, 8, t);
      f.onState("ally", 0, 2, t);
      if (f.cast("bard", atAlly.yaw, atAlly.pitch, t) === "cooldown") refused++;
      f.step(t);
    }
    expect(refused).toBe(0);
    // Faster than that: refused, as a wave would be.
    const g = setup();
    g.stance("bard", true);
    let fast = 0;
    for (let i = 0; i < 10; i++)
      if (g.cast("bard", atAlly.yaw, atAlly.pitch, T0 + i * 100) === "cooldown")
        fast++;
    expect(fast).toBeGreaterThan(5);
  });

  it("goes back to attacking when it says so, or puts its lute away", () => {
    const f = setup();
    f.stance("bard", true);
    expect(f.stance("bard", false)).toEqual([
      { to: "all", msg: { t: "stance", id: 1, heal: false } },
    ]);
    f.stance("bard", true);
    const out = f.renew("bard", { ...ticket("bard", [["soothing-drones", 1]]), look: { seed: "s", stage: 2, equipped: {} } });
    expect(out).toContainEqual({ to: "all", msg: { t: "stance", id: 1, heal: false } });
    expect(f.state(T0).healers).toBeUndefined();
  });
});

describe("Rage", () => {
  it("enrages everyone near, the Bard too, to its ceiling", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("bard", 1, ticket("bard", [["rage", 10]]), { x: 0, z: 8 }, T0 - 5_000);
    f.join("near", 2, ticket("near", [["backspin", 1]]), { x: 5, z: 8 }, T0 - 5_000);
    f.join("far", 3, ticket("far", [["backspin", 1]]), { x: 0, z: -12 }, T0 - 5_000);
    for (const [u, x, z] of [["bard", 0, 8], ["near", 5, 8], ["far", 0, -12]] as const)
      f.onState(u, x, z, T0);
    const bard = f.player("bard");
    if (!bard) throw new Error("no bard");
    // Euphony enough to pass the ceiling.
    bard.stats.euphony = 10_000;
    const { result, out } = f.skill("bard", "rage", 0, 0, T0);
    expect(result).toBe("used");
    expect(msgs(out, "buff").map((o) => o.msg.t === "buff" && o.msg.id).sort()).toEqual([1, 2]);
    expect(f.engine.buffsOf("near", T0)).toEqual([
      expect.objectContaining({ id: "rage", value: RAGE_MAX, by: "bard" }),
    ]);
    expect(f.engine.buffsOf("far", T0)).toEqual([]);
  });

  it("makes a hit on the boss land harder by its share", () => {
    const hitFor = (rage: number) => {
      const e = new BossEngine({ hp: 1e9, maxHp: 1e9, seed: 1, now: T0 });
      if (rage) e.buff("a", { id: "rage", value: rage, until: T0 + 60_000 });
      const { yaw, pitch } = aim(0, 8);
      expect(e.cast("a", { x: 0, z: 8 }, yaw, pitch, statsOf([500, 0, 0, 0]), T0 + 1_000)).toBe("hit");
      for (let t = T0 + 1_000; t <= T0 + 3_000; t += 50)
        for (const ev of e.update(t, [])) if (ev.t === "hit") return ev.damage;
      throw new Error("no hit");
    };
    const plain = hitFor(0);
    expect(hitFor(0.2)).toBe(Math.round(plain * 1.2));
  });

  it("pays its Bard for the share of the damage it added, a skill's too", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("bard", 1, ticket("bard", [["rage", 1]]), { x: 0, z: 8 }, T0 - 5_000);
    f.join("near", 2, ticket("near", [["backspin", 10]]), { x: 5, z: 8 }, T0 - 5_000);
    const near = f.player("near");
    if (!near) throw new Error("no near");
    near.stats.sonicPower = 5_000;
    f.onState("bard", 0, 8, T0);
    f.onState("near", 5, 8, T0);
    f.skill("bard", "rage", 0, 0, T0);
    const { yaw, pitch } = aim(5, 8);
    expect(f.skill("near", "backspin", yaw, pitch, T0 + 100).result).toBe("used");
    f.step(T0 + 3_000);
    const xp = f.report(T0 + 3_001, true)?.skills?.xp ?? [];
    expect(xp.find((x) => x.uid === "bard" && x.skill === "rage")?.xp).toBeGreaterThan(0);
  });
});

describe("Focus", () => {
  const focus = [{ id: "focus" as const, value: FOCUS_MAX, until: T0 + 60_000 }];

  it("quickens the cast budget as Timing would", () => {
    // Faster than the server's slack lets anyone cast, but no faster than
    // the Focus's Timing allows.
    const every = (TUNING.castEveryMs / (1 + timingAttackSpeed(FOCUS_MAX))) * 1.02;
    const refused = (focused: boolean) => {
      const e = new BossEngine({ hp: 1e9, maxHp: 1e9, seed: 1, now: T0 });
      if (focused) e.buff("a", focus[0]);
      let n = 0;
      for (let i = 0; i < 40; i++)
        if (e.cast("a", { x: 0, z: 8 }, Math.PI, 0, statsOf(undefined), T0 + 1_000 + i * every) === "cooldown")
          n++;
      return n;
    };
    expect(refused(true)).toBe(0);
    expect(refused(false)).toBeGreaterThan(0);
    expect(quickness(focus, T0, 0)).toBeCloseTo(1 + timingAttackSpeed(FOCUS_MAX));
  });

  it("raises crit chance as Timing would, over the herzie's own", () => {
    const stats = { sonicPower: 0, critChance: 10, critDamage: 50, timing: 40 };
    expect(focused(stats, focus, T0).critChance).toBeCloseTo(
      10 + timingCritChance(40 + FOCUS_MAX) - timingCritChance(40),
    );
    expect(focused(stats, focus, T0 + 60_000)).toBe(stats);
  });

  it("is everyone near's, capped, and pays its Bard for the casts it quickened", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("bard", 1, ticket("bard", [["focus", 10]]), { x: 0, z: 8 }, T0 - 5_000);
    f.join("near", 2, ticket("near", [["backspin", 1]]), { x: 5, z: 8 }, T0 - 5_000);
    f.onState("bard", 0, 8, T0);
    f.onState("near", 5, 8, T0);
    const bard = f.player("bard");
    if (!bard) throw new Error("no bard");
    bard.stats.euphony = 10_000;
    expect(f.skill("bard", "focus", 0, 0, T0).result).toBe("used");
    expect(f.engine.buffsOf("near", T0)).toEqual([
      expect.objectContaining({ id: "focus", value: FOCUS_MAX, by: "bard" }),
    ]);
    const { yaw, pitch } = aim(5, 8);
    for (let i = 0; i < 24; i++) {
      f.onState("near", 5, 8, T0 + 100 + i * 400);
      expect(f.cast("near", yaw, pitch, T0 + 100 + i * 400)).toBe("hit");
      f.step(T0 + 100 + i * 400);
    }
    f.step(T0 + 12_000);
    const xp = f.report(T0 + 12_001, true)?.skills?.xp ?? [];
    expect(xp.find((x) => x.uid === "bard" && x.skill === "focus")?.xp).toBeGreaterThan(0);
  });
});

describe("Multispin", () => {
  it("spins records round its Slinger that hit the boss beside it, paying XP", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("dj", 1, ticket("dj", [["multispin", 5]]), { x: 0, z: 8 }, T0 - 5_000);
    const at = { x: TUNING.boss.x, z: TUNING.boss.z + TUNING.boss.radius + 1 };
    f.onState("dj", at.x, at.z, T0);
    const { result, out } = f.skill("dj", "multispin", 0, 0, T0);
    expect(result).toBe("used");
    const records = multispinRecords(5);
    expect(msgs(out, "buff")[0]?.msg).toMatchObject({
      id: 1,
      buff: "multispin",
      value: records,
      until: T0 + (SKILL_DEFS.multispin.durationMs ?? 0),
    });
    const hits: Outbound[] = [];
    for (let t = T0 + 50; t <= T0 + MULTISPIN.turnMs; t += 50) {
      f.onState("dj", at.x, at.z, t);
      hits.push(...msgs(f.step(t), "hit"));
    }
    expect(hits.length).toBeGreaterThanOrEqual(records);
    f.step(T0 + 3_000);
    const xp = f.report(T0 + 3_001, true)?.skills?.xp ?? [];
    expect(xp.find((x) => x.uid === "dj" && x.skill === "multispin")?.xp).toBeGreaterThan(0);
  });
});

describe("Forbidden Frequency", () => {
  it("bleeds the boss, tells the room each stack, and pays each use that took hold", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("dj", 1, ticket("dj", [["forbidden-frequency", 5]], 1e9), { x: 0, z: 8 }, T0 - 5_000);
    const { yaw, pitch } = aim(0, 8);
    const every = SKILL_DEFS["forbidden-frequency"].cooldownMs + 100;
    const per = skillXpPerUse("forbidden-frequency");
    // Enough uses for a whole point.
    const uses = Math.ceil(1 / per);
    const said: ServerMessage[] = [];
    for (let i = 0; i < uses; i++) {
      const t = T0 + i * every;
      f.onState("dj", 0, 8, t);
      expect(f.skill("dj", "forbidden-frequency", yaw, pitch, t).result).toBe("used");
      for (let u = t + 50; u < t + every; u += 50)
        said.push(...msgs(f.step(u), "bleed").map((o) => o.msg));
    }
    expect(said.map((m) => m.t === "bleed" && m.stacks)).toEqual(
      Array.from({ length: uses }, (_, i) => Math.min(i + 1, 3)),
    );
    expect(said[0]).toMatchObject({ by: 1, target: 0, boss: true });
    // Its ticks pay nothing more.
    const xp = f.report(T0 + uses * every, true)?.skills?.xp ?? [];
    expect(xp.find((x) => x.skill === "forbidden-frequency")?.xp).toBe(
      Math.floor(uses * per + 1e-9),
    );
  });
});

describe("Silencio", () => {
  const castMs = SKILL_DEFS.silencio.castMs ?? 0;
  /** A Bard beside the boss (in reach), or far from it. */
  const bard = (z: number) => {
    const f = new FightRuntime(claim(), T0);
    f.join("bard", 1, ticket("bard", [["silencio", 5]], 200), { x: 0, z }, T0 - 5_000);
    f.onState("bard", 0, z, T0);
    return f;
  };
  const near = TUNING.boss.z + TUNING.boss.radius + 2;

  it("bursts once its wind-up is done: the boss bleeds, and each use that caught it pays once", () => {
    const f = bard(near);
    const every = SKILL_DEFS.silencio.cooldownMs + 100;
    const per = skillXpPerUse("silencio");
    const uses = Math.ceil(1 / per);
    const said: ServerMessage[] = [];
    let ticks = 0;
    for (let i = 0; i < uses; i++) {
      const t = T0 + i * every;
      f.onState("bard", 0, near, t);
      expect(f.skill("bard", "silencio", 0, 0, t).result).toBe("used");
      // Nothing yet while it winds up.
      expect(msgs(f.step(t + castMs - 50), "bleed")).toEqual([]);
      for (let u = t + castMs; u < t + every; u += 50) {
        const out = f.step(u);
        said.push(...msgs(out, "bleed").map((o) => o.msg));
        ticks += msgs(out, "hit").filter((o) => o.msg.t === "hit" && o.msg.bleed).length;
      }
    }
    expect(said).toHaveLength(uses);
    expect(said[0]).toMatchObject({ by: 1, target: 0, boss: true, skill: "silencio", stacks: 1 });
    // Its ticks hit, and pay nothing more.
    expect(ticks).toBeGreaterThan(uses);
    const xp = f.report(T0 + uses * every, true)?.skills?.xp ?? [];
    expect(xp.find((x) => x.skill === "silencio")?.xp).toBe(Math.floor(uses * per + 1e-9));
  });

  it("catching nobody pays nothing", () => {
    const f = bard(TUNING.boss.z + TUNING.boss.radius + 12);
    const every = SKILL_DEFS.silencio.cooldownMs + 100;
    const uses = Math.ceil(1 / skillXpPerUse("silencio"));
    for (let i = 0; i < uses; i++) {
      const t = T0 + i * every;
      expect(f.skill("bard", "silencio", 0, 0, t).result).toBe("used");
      for (let u = t + 50; u < t + castMs + 500; u += 50)
        expect(msgs(f.step(u), "bleed")).toEqual([]);
    }
    const xp = f.report(T0 + uses * every, true)?.skills?.xp ?? [];
    expect(xp.find((x) => x.skill === "silencio")).toBeUndefined();
  });

  it("is lost if its Bard goes down winding it up", () => {
    const f = bard(near);
    expect(f.skill("bard", "silencio", 0, 0, T0).result).toBe("used");
    const p = f.player("bard");
    if (!p) throw new Error("no bard");
    p.down = true;
    const out = f.step(T0 + 100);
    expect(msgs(out, "channel").map((o) => o.msg)).toEqual([
      { t: "channel", by: 1, target: null, until: 0 },
    ]);
    for (let u = T0 + 150; u < T0 + 2_000; u += 50)
      expect(msgs(f.step(u), "bleed")).toEqual([]);
  });
});
