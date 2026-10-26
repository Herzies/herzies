import { WAVE_HAND_HEIGHT } from "@herzies/shared/combat";
import {
  SKILL_COOLDOWN_GRACE_MS,
  SKILL_DEFS,
  skillValue,
} from "@herzies/shared/skills";
import type { ServerMessage, TownTicketPayload } from "@herzies/shared/town-net";
import { describe, expect, it } from "vitest";
import { BossEngine, type BossPlayer, TUNING } from "../src/boss";
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
): TownTicketPayload => ({
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

  it("pays XP for what it restored, and lets the database rise that far", () => {
    const f = setup([{ uid: "near", x: 3, z: 8 }]);
    f.skill("bard", "soothing-drones", 0, 0, T0);
    const r = f.report(T0 + 1, true);
    const restored = 2 * skillValue("soothing-drones", 1) * 200;
    expect(r?.skills?.xp).toEqual([
      {
        uid: "bard",
        skill: "soothing-drones",
        xp: Math.floor(restored * SKILL_DEFS["soothing-drones"].xpPerUnit),
      },
    ]);
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
  it("puts the buff on its caster for everyone to see", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("tank", 1, ticket("tank", [["cymbrella", 10]]), { x: 0, z: 8 }, T0 - 5_000);
    f.onState("tank", 0, 8, T0);
    const { out } = f.skill("tank", "cymbrella", 0, 0, T0);
    expect(msgs(out, "buff")[0].msg).toEqual({
      t: "buff",
      id: 1,
      buff: "cymbrella",
      value: skillValue("cymbrella", 10),
      until: T0 + (SKILL_DEFS.cymbrella.durationMs ?? 0),
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

  it("strengthens a Cymbrella, by less", () => {
    const f = new FightRuntime(claim(), T0);
    const tank = ticket("tank", [["cymbrella", 1]]);
    tank.st = [0, 0, 0, 0, 0, 0, 50];
    f.join("tank", 1, tank, { x: 0, z: 8 }, T0 - 5_000);
    f.onState("tank", 0, 8, T0);
    const { out } = f.skill("tank", "cymbrella", 0, 0, T0);
    const buff = msgs(out, "buff")[0].msg;
    if (buff.t !== "buff") throw new Error("no buff");
    // 50 Euphony: a quarter again.
    expect(buff.value).toBeCloseTo(skillValue("cymbrella", 1) * 1.25);
  });
});

describe("ticket stats", () => {
  it("reads Def and Euphony when the ticket has them", () => {
    expect(statsOf([12, 5, 3, 50, 20, 20, 8])).toEqual({
      sonicPower: 12,
      critChance: 3,
      critDamage: 50,
      def: 20,
      euphony: 8,
    });
  });

  it("reads them as 0 on a ticket from before stat points, or no stats", () => {
    expect(statsOf([12, 5, 3, 50])).toEqual({
      sonicPower: 12,
      critChance: 3,
      critDamage: 50,
      def: 0,
      euphony: 0,
    });
    expect(statsOf(undefined).def).toBe(0);
  });
});

describe("Backspin", () => {
  it("throws three discs that land for a share of a hit, paying XP", () => {
    const f = new FightRuntime(claim(), T0);
    f.join("dj", 1, ticket("dj", [["backspin", 1]]), { x: 0, z: 8 }, T0 - 5_000);
    f.onState("dj", 0, 8, T0);
    const { yaw, pitch } = aim(0, 8);
    expect(f.skill("dj", "backspin", yaw, pitch, T0).result).toBe("used");
    const out = f.step(T0 + 2_000);
    expect(msgs(out, "hit")).toHaveLength(3);
    const r = f.report(T0 + 2_000, true);
    expect(r?.skills?.xp[0]).toMatchObject({ uid: "dj", skill: "backspin" });
  });
});

describe("the boss's side", () => {
  const player = (uid: string, at: { x: number; z: number }): BossPlayer => ({
    uid,
    alive: true,
    maxHp: 200,
    posAt: () => at,
  });

  it("a Cymbrella takes its share off a slam, and the same buff doesn't stack", () => {
    const boss = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0 });
    boss.buff("a", { id: "cymbrella", value: 0.4, until: T0 + 60_000 });
    boss.buff("a", { id: "cymbrella", value: 0.4, until: T0 + 60_000 });
    const a = player("a", { x: 0, z: 8 });
    let hits: {
      uid: string;
      damage: number;
      absorbed: number;
      blocked: number;
    }[] = [];
    for (let t = T0; t < T0 + 10_000 && !hits.length; t += 50) {
      for (const ev of boss.update(t, [a])) if (ev.t === "resolve") hits = ev.hits;
    }
    const raw = TUNING.slam.damage;
    // 40% off once: two Cymbrellas are still one. Without Def, all of what
    // came off is the Cymbrella's.
    const taken = Math.round(raw) - Math.round(raw * 0.6);
    expect(hits[0]).toEqual({
      uid: "a",
      damage: Math.round(raw * 0.6),
      absorbed: taken,
      blocked: taken,
      aimed: true,
    });
  });

  it("with Def too, only the Cymbrella's own share counts as blocked", () => {
    const boss = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0 });
    boss.buff("a", { id: "cymbrella", value: 0.4, until: T0 + 60_000 });
    const a = { ...player("a", { x: 0, z: 8 }), def: 100 };
    let hit: { damage: number; absorbed: number; blocked: number } | undefined;
    for (let t = T0; t < T0 + 10_000 && !hit; t += 50) {
      for (const ev of boss.update(t, [a]))
        if (ev.t === "resolve") hit = ev.hits[0];
    }
    if (!hit) throw new Error("no hit");
    const raw = TUNING.slam.damage;
    // Def alone halves it; the Cymbrella takes 40% of what's left.
    const defOnly = Math.round(raw / 2);
    expect(hit.blocked).toBe(defOnly - hit.damage);
    expect(hit.blocked).toBeLessThan(hit.absorbed);
    expect(hit.blocked).toBeGreaterThan(0);
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
