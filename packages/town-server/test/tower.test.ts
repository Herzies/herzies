import { IN_TUNE } from "@herzies/shared/boss-fight";
import { DOME, discChain } from "@herzies/shared/combat";
import {
  MULTISPIN,
  RIMSHOT,
  SHUFFLE_REACH,
  SKILL_DEFS,
  shuffleBounces,
} from "@herzies/shared/skills";
import {
  CONTACT,
  FLOOR_OPENING_MS,
  levelGapMods,
  MOB,
  MOB_KINDS,
  MOB_SWING,
  mobsOnFloor,
  TOWER_CHEST,
  TOWER_BOONS,
  type TowerBoon,
  towerBoonOffers,
  towerBoonSeed,
  towerBoonTotals,
  towerMob,
  WARDEN,
} from "@herzies/shared/tower";
import {
  type ServerMessage,
  TOWN_MAPS,
  type TownTicketPayload,
} from "@herzies/shared/town-net";
import { armed } from "./arms";
import { describe, expect, it } from "vitest";
import { type BossPlayer, TUNING } from "../src/boss";
import { FightRuntime, type Outbound } from "../src/fight";
import { TowerEngine, type TowerEvent } from "../src/tower";
import { LOOT_REACH_SLACK } from "../src/wilds-loot";

const T0 = 7_000_000;
const STATS = { sonicPower: 0, critChance: 0, critDamage: 0 };
const ARENA = {
  radius: TOWN_MAPS.tower.radius,
  entry: TOWN_MAPS.tower.spawn,
};

function engine(floor = 1, level = 1, seed = 3) {
  return new TowerEngine({ floor, level, seed, now: T0 }, ARENA);
}

/** A player who walks along `path(t)`. */
function player(
  path: (t: number) => { x: number; z: number },
  maxHp = 500,
): BossPlayer {
  return { uid: "u", alive: true, maxHp, posAt: path };
}

function run(
  e: TowerEngine,
  from: number,
  until: number,
  players: BossPlayer[],
): TowerEvent[] {
  const out: TowerEvent[] = [];
  for (let t = from; t <= until; t += 50) out.push(...e.update(t, players));
  return out;
}

/** Aim from (x, z) straight at a mob. */
function aimAt(from: { x: number; z: number }, to: { x: number; z: number }) {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

type Trap = Extract<TowerEvent, { t: "trap" }>;

/** Step 50 ms at a time until a Cymbal Trap holds a mob: the hold, when,
 * and everything that happened till then. Null: none did. */
function trapAt(
  e: TowerEngine,
  from: number,
  until: number,
  players: BossPlayer[],
): { ev: Trap; at: number; events: TowerEvent[] } | null {
  const events: TowerEvent[] = [];
  for (let t = from; t <= until; t += 50) {
    const step = e.update(t, players);
    events.push(...step);
    const ev = step.find((x): x is Trap => x.t === "trap");
    if (ev) return { ev, at: t, events };
  }
  return null;
}

describe("TowerEngine", () => {
  it("spawns a floor's worth of mobs, away from the entry", () => {
    const e = engine(4);
    const mobs = e.wireMobs();
    expect(mobs).toHaveLength(mobsOnFloor(4));
    for (const m of mobs) {
      expect(m.hp).toBe(
        Math.round(towerMob(4).hp * MOB_KINDS[m.k ?? "brute"].hp),
      );
      const fromEntry = Math.hypot(m.x - ARENA.entry.x, m.z - ARENA.entry.z);
      expect(fromEntry).toBeGreaterThan(8);
      expect(Math.hypot(m.x, m.z)).toBeLessThan(ARENA.radius);
    }
  });

  it("is the same floor for the same seed", () => {
    expect(engine(5, 1, 9).wireMobs()).toEqual(engine(5, 1, 9).wireMobs());
  });

  it("waits out the opening, then chases you", () => {
    const e = engine();
    const at = ARENA.entry;
    const p = player(() => at);
    const before = e.wireMobs();
    run(e, T0, T0 + FLOOR_OPENING_MS - 100, [p]);
    expect(e.wireMobs()).toEqual(before);
    run(e, T0 + FLOOR_OPENING_MS, T0 + FLOOR_OPENING_MS + 1_000, [p]);
    for (const [i, m] of e.wireMobs().entries()) {
      const was = before[i];
      expect(Math.hypot(m.x - at.x, m.z - at.z)).toBeLessThan(
        Math.hypot(was.x - at.x, was.z - at.z),
      );
    }
  });

  it("winds up in reach, and the swing lands only if you stay", () => {
    const e = engine();
    const at = ARENA.entry;
    const stay = run(e, T0, T0 + 20_000, [player(() => at)]);
    const tg = stay.find((x) => x.t === "telegraph");
    expect(tg).toBeDefined();
    if (tg?.t !== "telegraph") return;
    expect(tg.telegraph.hitAt - tg.telegraph.at).toBe(MOB_SWING.windupMs);
    const landed = stay.find(
      (x) => x.t === "resolve" && x.id === tg.telegraph.id,
    );
    expect(landed?.t === "resolve" && landed.hits.length).toBe(1);

    // The same floor, but step well away the moment a shape goes down.
    const f = engine();
    let dodgeAt = Number.POSITIVE_INFINITY;
    const dodger = player((t) =>
      t >= dodgeAt ? { x: at.x, z: at.z + 6 } : at,
    );
    const ev: TowerEvent[] = [];
    for (let t = T0; t <= T0 + 20_000 && dodgeAt === Infinity; t += 50) {
      for (const x of f.update(t, [dodger])) {
        ev.push(x);
        if (x.t === "telegraph") dodgeAt = t + 1;
      }
    }
    const first = ev.find((x) => x.t === "telegraph");
    if (first?.t !== "telegraph") throw new Error("no swing");
    const after = run(f, dodgeAt + 49, first.telegraph.hitAt + 100, [dodger]);
    const res = after.find(
      (x) => x.t === "resolve" && x.id === first.telegraph.id,
    );
    expect(res?.t === "resolve" && res.hits).toEqual([]);
  });

  it("hits harder on higher floors, and harder still above your level", () => {
    const low = towerMob(1).damage;
    expect(towerMob(20).damage).toBeGreaterThan(low);
    // Floor 21: no elite, no Warden. A brute's swing, which is the floor's
    // plain damage.
    const high = towerMob(21).damage;
    const take = (level: number) => {
      const e = engine(21, level);
      const brutes = new Set(
        e.wireMobs().filter((m) => !m.k && !m.e).map((m) => m.id),
      );
      const ev = run(e, T0, T0 + 20_000, [player(() => ARENA.entry, 10_000)]);
      const tg = ev.find(
        (x) => x.t === "telegraph" && brutes.has(x.telegraph.mob ?? -1),
      );
      if (tg?.t !== "telegraph") throw new Error("no swing");
      return tg.telegraph.damage;
    };
    expect(take(1)).toBeGreaterThan(take(40));
    expect(take(1)).toBe(Math.round(high * levelGapMods(20).taken));
  });

  it("takes less from you the higher it is above you", () => {
    const dealt = (level: number) => {
      const e = engine(10, level);
      const mob = e.wireMobs()[0];
      const from = { x: mob.x, z: mob.z - 6 };
      e.cast("u", from, aimAt(from, mob), 0, STATS, T0);
      const ev = run(e, T0, T0 + 1_000, []);
      const hit = ev.find((x) => x.t === "hit");
      if (hit?.t !== "hit") throw new Error("no hit");
      expect(hit.mob).toBe(mob.id);
      return hit.damage;
    };
    expect(dealt(1)).toBeLessThan(dealt(10));
  });

  it("clears when the last mob falls, then opens the next floor", () => {
    const e = engine(1, 50);
    expect(e.next(T0)).toBe(false);
    const ev: TowerEvent[] = [];
    let t = T0;
    // Stand still and fire at whatever's left, far from the entry so they
    // never reach you first (no players: they idle).
    while (!e.isCleared && t < T0 + 120_000) {
      const mob = e.wireMobs()[0];
      const from = { x: mob.x - 5, z: mob.z };
      e.cast("u", from, aimAt(from, mob), 0, STATS, t);
      t += 500;
      ev.push(...e.update(t, []));
    }
    expect(e.isCleared).toBe(true);
    expect(ev.filter((x) => x.t === "mobDown")).toHaveLength(mobsOnFloor(1));
    expect(ev.filter((x) => x.t === "cleared")).toEqual([
      { t: "cleared", floor: 1 },
    ]);
    expect(e.next(t)).toBe(true);
    expect(e.floor).toBe(2);
    expect(e.wireMobs()).toHaveLength(mobsOnFloor(2));
    expect(e.isCleared).toBe(false);
  });

  it("takes a fallen mob's swing off the ground", () => {
    const e = engine(1, 99);
    const at = ARENA.entry;
    let t = T0;
    let swing: Extract<TowerEvent, { t: "telegraph" }> | undefined;
    while (!swing && t < T0 + 20_000) {
      t += 50;
      swing = e
        .update(t, [player(() => at)])
        .find((x): x is Extract<TowerEvent, { t: "telegraph" }> => x.t === "telegraph");
    }
    if (!swing) throw new Error("no swing");
    const mob = e.wireMobs().find((m) => m.id === swing.telegraph.mob);
    if (!mob) throw new Error("no mob");
    // Melee it until it drops, before the swing lands.
    const ev: TowerEvent[] = [];
    for (let i = 0; i < 40 && e.wireMobs().some((m) => m.id === mob.id); i++) {
      e.cast("u", at, aimAt(at, mob), 0, { ...STATS, sonicPower: 1000 }, t, "melee");
      t += 10;
      ev.push(...e.update(t, []));
    }
    expect(t).toBeLessThan(swing.telegraph.hitAt);
    expect(ev).toContainEqual({ t: "resolve", id: swing.telegraph.id, hits: [] });
  });

  it("under a Shuffle, a disc bounces on through the pack, weaker each time", () => {
    const e = engine(6);
    const mobs = e.wireMobs();
    const mob = mobs[0];
    const from = { x: mob.x, z: mob.z - 1 };
    e.buff("u", { id: "shuffle", value: 5, until: T0 + 10_000 });
    expect(e.cast("u", from, aimAt(from, mob), 0, STATS, T0, "disc")).toBe("hit");
    const hits = run(e, T0, T0 + 3_000, []).filter(
      (x): x is Extract<TowerEvent, { t: "hit" }> => x.t === "hit",
    );
    const bodies = mobs.map((m) => ({ ref: m.id, x: m.x, z: m.z, radius: 0 }));
    const chain = discChain(mob.id, mob, bodies, 5, SHUFFLE_REACH);
    expect(chain.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.mob)).toEqual([mob.id, ...chain.map((c) => c.body.ref)]);
    expect(hits[0].skill).toBeUndefined();
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].skill).toBe("shuffle");
      expect(hits[i].damage).toBeLessThan(hits[i - 1].damage);
    }
  });

  it("without a Shuffle, or with a wave, a cast hits one mob", () => {
    const once = (attack: "disc" | "wave", shuffle: boolean) => {
      const e = engine(6);
      const mob = e.wireMobs()[0];
      const from = { x: mob.x, z: mob.z - 1 };
      if (shuffle) e.buff("u", { id: "shuffle", value: 5, until: T0 + 10_000 });
      e.cast("u", from, aimAt(from, mob), 0, STATS, T0, attack);
      return run(e, T0, T0 + 3_000, []).filter((x) => x.t === "hit").length;
    };
    expect(once("disc", false)).toBe(1);
    expect(once("wave", true)).toBe(1);
  });

  it("judges a cast against where the mob was a moment ago", () => {
    const e = engine();
    const at = ARENA.entry;
    run(e, T0, T0 + FLOOR_OPENING_MS + 1_500, [player(() => at)]);
    const now = T0 + FLOOR_OPENING_MS + 1_500;
    const mob = e.wireMobs()[0];
    // Where it was drawn a moment ago is a little further off than now;
    // aiming at its middle then still finds it.
    const from = { x: at.x, z: at.z };
    const yaw = aimAt(from, mob);
    expect(e.cast("u", from, yaw, 0, STATS, now)).toBe("hit");
    // Aimed well away: a miss.
    expect(e.cast("u", from, yaw + 1.2, 0, STATS, now + 1_000)).toBe("miss");
  });

  it("hurts a herzie who walks into a mob, a share of their health each beat", () => {
    const e = engine(1);
    const mob = e.wireMobs()[0];
    // Stood right on it: it holds still, so the herzie stays inside it.
    const on = player(() => ({ x: mob.x, z: mob.z }));
    const evs = run(e, T0, T0 + FLOOR_OPENING_MS + 3_000, [on]);
    const bumps = evs.filter(
      (ev): ev is Extract<TowerEvent, { t: "contact" }> => ev.t === "contact",
    );
    expect(bumps.length).toBeGreaterThan(0);
    for (const b of bumps) {
      expect(b.mob).toBe(mob.id);
      expect(b.hit.uid).toBe("u");
      expect(b.hit.damage).toBe(Math.round(500 * CONTACT.hp));
    }
  });

  it("hits a herzie once per attack, with no breather between attacks", () => {
    // Stood still on floors with lungers, whose lane is several shapes.
    for (const floor of [3, 6, 9, 12]) {
      const e = engine(floor, 10, 5);
      const still = player(() => ({ x: 0, z: 0 }), 1e6);
      const evs = run(e, T0, T0 + FLOOR_OPENING_MS + 20_000, [still]);
      const shapes = new Map<number, string>();
      const landed = new Map<string, number>();
      for (const ev of evs) {
        if (ev.t === "telegraph")
          shapes.set(
            ev.telegraph.id,
            `${ev.telegraph.mob}:${ev.telegraph.hitAt}`,
          );
        if (ev.t === "resolve")
          for (const h of ev.hits) {
            const k = `${shapes.get(ev.id)}:${h.uid}`;
            landed.set(k, (landed.get(k) ?? 0) + 1);
          }
      }
      expect(landed.size).toBeGreaterThan(0);
      for (const n of landed.values()) expect(n).toBe(1);
    }
  });

  it("leaves a herzie alone who only stands near a mob", () => {
    const e = engine(1);
    const mob = e.wireMobs()[0];
    // Out of the mob's body, though inside its swing.
    const near = player(() => ({ x: mob.x + 1.4, z: mob.z }));
    const evs = run(e, T0, T0 + FLOOR_OPENING_MS + 3_000, [near]);
    expect(evs.some((ev) => ev.t === "contact")).toBe(false);
  });
});

const ticket = (over: Partial<TownTicketPayload> = {}): TownTicketPayload =>
  armed({
    uid: "u",
    name: "u",
    look: { seed: "s", stage: 2 },
    cls: "bard",
    exp: 9e9,
    hp: { hp: 500, maxHp: 500, down: false },
    st: [0, 0, 0, 0],
    lv: 5,
    ...over,
  });

const said = (out: Outbound[], t: ServerMessage["t"]) =>
  out.filter((o) => o.msg.t === t);

describe("the Percussionist in the Tower", () => {
  it("a dome shoves the pack out, keeps it out, and shelters whoever's inside", () => {
    const e = engine(6, 1);
    const at = ARENA.entry;
    const p = player(() => at, 10_000);
    // Let them come close first.
    let t = T0;
    for (; t < T0 + FLOOR_OPENING_MS + 6_000; t += 50) e.update(t, [p]);
    const close = e
      .wireMobs()
      .filter((m) => Math.hypot(m.x - at.x, m.z - at.z) < DOME.radius);
    expect(close.length).toBeGreaterThan(0);
    e.addDome("tank", at.x, at.z, t, 4_000);
    const events: TowerEvent[] = [];
    const end = t + 4_000;
    for (t += 50; t < end - 50; t += 50) {
      events.push(...e.update(t, [p]));
      if (t < end - 4_000 + DOME.growMs + 100) continue;
      for (const m of e.wireMobs())
        expect(Math.hypot(m.x - at.x, m.z - at.z)).toBeGreaterThan(DOME.radius);
    }
    // Nothing they did in there landed on the herzie.
    for (const ev of events)
      if (ev.t === "resolve")
        for (const h of ev.hits) {
          expect(h.damage).toBe(0);
          expect(h.shelteredBy).toBe("tank");
        }
    expect(events.some((ev) => ev.t === "contact")).toBe(false);
  });

  it("a Rimshot hits every mob round it, and a stun stops a mob and its swing", () => {
    const e = engine(1, 1);
    const at = ARENA.entry;
    const p = player(() => at, 100_000);
    // Wait for a mob winding up on the herzie.
    let t = T0;
    let swing: Extract<TowerEvent, { t: "telegraph" }> | undefined;
    while (!swing && t < T0 + 30_000) {
      t += 50;
      swing = e
        .update(t, [p])
        .find((x): x is Extract<TowerEvent, { t: "telegraph" }> => x.t === "telegraph");
    }
    if (!swing) throw new Error("no swing");
    const mob = e.wireMobs().find((m) => m.id === swing.telegraph.mob);
    if (!mob) throw new Error("no mob");
    const from = { x: mob.x, z: mob.z - 1.2 };
    const inReach = e
      .wireMobs()
      .filter((m) => Math.hypot(m.x - from.x, m.z - from.z) <= RIMSHOT.radius);
    // At 40% of a plain hit: five strikes then land as two did, leaving
    // the stunned mob standing to be watched.
    const r = e.rimshot("u", from, { ...STATS, sonicPower: -60 }, 1, t);
    expect(r.hit).toBeGreaterThanOrEqual(inReach.length);
    expect(r.stunned).toBe(r.hit);
    expect(e.wireMobs().find((m) => m.id === mob.id)?.st).toBe(t + RIMSHOT.stunMs);
    const next = e.update(t + 50, [p]);
    // Its swing came off the floor, landing on nobody.
    expect(next).toContainEqual({ t: "resolve", id: swing.telegraph.id, hits: [] });
    const hits = next.filter((x) => x.t === "hit");
    expect(hits).toHaveLength(r.hit);
    expect(hits.every((h) => h.t === "hit" && h.skill === "rimshot")).toBe(true);
    // It stands there while stunned.
    const still = e.wireMobs().find((m) => m.id === mob.id);
    for (let u = t + 100; u < t + RIMSHOT.stunMs - 100; u += 50) e.update(u, [p]);
    const after = e.wireMobs().find((m) => m.id === mob.id);
    expect(after?.x).toBeCloseTo(still?.x ?? Number.NaN, 1);
    expect(after?.z).toBeCloseTo(still?.z ?? Number.NaN, 1);
  });

  it("a Rimshot misses a mob past its reach", () => {
    const e = engine(1, 1);
    // Where herzies arrive: mobs start well away from it.
    const far = ARENA.entry;
    const near = e.wireMobs().filter(
      (m) => Math.hypot(m.x - far.x, m.z - far.z) <= RIMSHOT.radius + 1.2,
    );
    expect(near).toHaveLength(0);
    expect(e.rimshot("u", far, STATS, 1, T0)).toEqual({ hit: 0, stunned: 0 });
  });

  it("a stun again soon after is shorter, and none lands while it's stunned", () => {
    // High up, so three slams don't fell it.
    const e = engine(40, 1);
    const mob = e.wireMobs()[0];
    const from = { x: mob.x, z: mob.z - 1.2 };
    const st = () => e.wireMobs().find((m) => m.id === mob.id)?.st;
    e.rimshot("u", from, STATS, 1, T0);
    expect(st()).toBe(T0 + RIMSHOT.stunMs);
    e.rimshot("u", from, STATS, 1, T0 + 500);
    expect(st()).toBe(T0 + RIMSHOT.stunMs);
    const later = T0 + RIMSHOT.stunMs + 100;
    e.update(later, []);
    e.rimshot("u", from, STATS, 1, later);
    expect(st()).toBe(later + RIMSHOT.stunMs / 2);
  });

  it("without the luck, a Rimshot stuns nothing", () => {
    const e = engine(1, 1);
    const mob = e.wireMobs()[0];
    const from = { x: mob.x, z: mob.z - 1.2 };
    const r = e.rimshot("u", from, STATS, 0, T0);
    expect(r.hit).toBeGreaterThan(0);
    expect(r.stunned).toBe(0);
  });

  it("in a fight, a Rimshot winds up first, lands at the end of it, and a fall cancels it", () => {
    const towerClaim = { event: "tower-1", until: (T0 + 3_600_000) / 1000, floor: 6 };
    const f = FightRuntime.tower(towerClaim, "u", 20, ARENA, T0, 3);
    f.join("u", 1, ticket({ cls: "percussionist", lv: 20, sk: [["rimshot", 10]] }), ARENA.entry, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    const mob = tw.wireMobs()[0];
    const from = { x: mob.x, z: mob.z - 1.2 };
    for (let t = T0; t <= T0 + 200; t += 50) f.onState("u", from.x, from.z, t);
    expect(f.skill("u", "rimshot", 0, 0, T0 + 200).result).toBe("used");
    const cast = SKILL_DEFS.rimshot.castMs ?? 0;
    const hitsBy = (until: number, start: number) => {
      const out: Outbound[] = [];
      for (let t = start; t <= until; t += 50) {
        f.onState("u", from.x, from.z, t);
        out.push(...f.step(t));
      }
      return said(out, "hit").length;
    };
    expect(hitsBy(T0 + 200 + cast - 60, T0 + 250)).toBe(0);
    expect(hitsBy(T0 + 200 + cast + 100, T0 + 200 + cast - 10)).toBeGreaterThan(0);
    // Knocked out mid-wind-up: it never lands.
    const later = T0 + 200 + SKILL_DEFS.rimshot.cooldownMs + 100;
    for (let t = T0 + 200 + cast + 150; t <= later; t += 50) {
      f.onState("u", from.x, from.z, t);
      f.step(t);
    }
    expect(f.skill("u", "rimshot", 0, 0, later).result).toBe("used");
    const me = f.player("u");
    if (!me) throw new Error("no player");
    me.down = true;
    const out = f.step(later + 100);
    expect(said(out, "channel")[0]?.msg).toMatchObject({ target: null });
    expect(hitsBy(later + cast + 200, later + 150)).toBe(0);
  });

  it("a Cymbal Trap holds the first mob along the aim: it takes no step, yet still swings", () => {
    const e = engine(1, 1);
    const herzie: { at: { x: number; z: number } } = { at: ARENA.entry };
    const p = player(() => herzie.at, 100_000);
    // The pack's awake and coming on.
    let t = T0;
    for (; t < T0 + FLOOR_OPENING_MS + 500; t += 50) e.update(t, [p]);
    const mob = e.wireMobs()[0];
    expect(e.cymbalTrap("u", { x: mob.x, z: mob.z - 3 }, 0, 0, STATS, 6_000, t)).toBe(true);
    const caught = trapAt(e, t + 50, t + 1_000, [p]);
    if (!caught) throw new Error("no trap");
    const { ev, at, events } = caught;
    expect(ev).toEqual({ t: "trap", uid: "u", mob: ev.mob, until: at + 6_000 });
    expect(events).toContainEqual(
      expect.objectContaining({ t: "hit", uid: "u", mob: ev.mob, skill: "cymbal-trap" }),
    );
    // It doesn't come on at the herzie; once the herzie walks up beside it,
    // it turns and swings, but never moves.
    const held = e.wireMobs().find((m) => m.id === ev.mob);
    if (!held) throw new Error("no mob");
    let swung = false;
    for (t = at + 50; t < ev.until - 50; t += 50) {
      if (t >= at + 2_000) herzie.at = { x: held.x + 1, z: held.z };
      swung ||= e
        .update(t, [p])
        .some((x) => x.t === "telegraph" && x.telegraph.mob === ev.mob);
      const now = e.wireMobs().find((m) => m.id === ev.mob);
      expect(now?.x).toBeCloseTo(held.x, 1);
      expect(now?.z).toBeCloseTo(held.z, 1);
    }
    expect(swung).toBe(true);
  });

  it("a Cymbal Trap's hold again soon after is half as long, and none lands while it's held", () => {
    // High up, so three blows don't fell it.
    const e = engine(40, 1);
    const mob = e.wireMobs()[0];
    const from = { x: mob.x, z: mob.z - 2 };
    e.cymbalTrap("u", from, 0, 0, STATS, 2_000, T0);
    const first = trapAt(e, T0, T0 + 500, []);
    if (!first) throw new Error("no trap");
    expect(first.ev.until).toBe(first.at + 2_000);
    // Held already: the blow lands, the hold is as it was.
    e.cymbalTrap("u", from, 0, 0, STATS, 2_000, first.at + 100);
    const again = trapAt(e, first.at + 100, first.at + 600, []);
    expect(again).toBeNull();
    const later = first.ev.until + 100;
    e.cymbalTrap("u", from, 0, 0, STATS, 2_000, later);
    const second = trapAt(e, later, later + 500, []);
    if (!second) throw new Error("no trap");
    expect(second.ev.mob).toBe(first.ev.mob);
    expect(second.ev.until).toBe(second.at + 1_000);
  });

  it("in a fight, a Cymbal Trap's hold is told to everyone", () => {
    const towerClaim = { event: "tower-1", until: (T0 + 3_600_000) / 1000, floor: 6 };
    const f = FightRuntime.tower(towerClaim, "u", 20, ARENA, T0, 3);
    f.join("u", 1, ticket({ cls: "percussionist", lv: 20, sk: [["cymbal-trap", 10]] }), ARENA.entry, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    const mob = tw.wireMobs()[0];
    const from = { x: mob.x, z: mob.z - 3 };
    for (let t = T0; t <= T0 + 200; t += 50) f.onState("u", from.x, from.z, t);
    const thrown = f.skill("u", "cymbal-trap", 0, 0, T0 + 200);
    expect(thrown.result).toBe("used");
    expect(said(thrown.out, "trap")).toEqual([]);
    const out: Outbound[] = [];
    for (let t = T0 + 250; t <= T0 + 1_000; t += 50) {
      f.onState("u", from.x, from.z, t);
      out.push(...f.step(t));
    }
    const traps = said(out, "trap");
    expect(traps).toHaveLength(1);
    expect(traps[0].to).toBe("all");
    expect(traps[0].msg).toMatchObject({ t: "trap", by: 1, mob: true });
    expect(said(out, "hit").length).toBeGreaterThan(0);
  });
});

describe("the Record Slinger's Multispin in the Tower", () => {
  it("hits the mob beside its Slinger, none out of its records' reach, and a fall stops it", () => {
    const towerClaim = { event: "tower-1", until: (T0 + 3_600_000) / 1000, floor: 6 };
    const f = FightRuntime.tower(towerClaim, "u", 20, ARENA, T0, 3);
    f.join("u", 1, ticket({ cls: "record_slinger", lv: 20, sk: [["multispin", 5]] }), ARENA.entry, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    // The pack sleeps through the opening: nobody moves.
    const mobs = tw.wireMobs();
    const mob = mobs[0];
    const at = { x: mob.x - MULTISPIN.radius, z: mob.z };
    const reach = MULTISPIN.radius + MULTISPIN.recordRadius + MOB.radius * WARDEN.scale;
    const apart = (m: { x: number; z: number }) => Math.hypot(m.x - at.x, m.z - at.z);
    expect(mobs.some((m) => apart(m) > reach)).toBe(true);
    for (let t = T0; t <= T0 + 200; t += 50) f.onState("u", at.x, at.z, t);
    const cast = f.skill("u", "multispin", 0, 0, T0 + 200);
    expect(cast.result).toBe("used");
    expect(said(cast.out, "buff")[0]?.msg).toMatchObject({ buff: "multispin" });
    const hit = new Set<number>();
    for (let t = T0 + 250; t <= T0 + 200 + MULTISPIN.turnMs; t += 50) {
      f.onState("u", at.x, at.z, t);
      for (const o of said(f.step(t), "hit"))
        if (o.msg.t === "hit" && o.msg.mob !== undefined) hit.add(o.msg.mob);
    }
    expect(hit.has(mob.id)).toBe(true);
    for (const id of hit) {
      const m = mobs.find((x) => x.id === id);
      expect(m && apart(m)).toBeLessThanOrEqual(reach);
    }
    const me = f.player("u");
    if (!me) throw new Error("no player");
    me.down = true;
    const out = f.step(T0 + 1_500);
    expect(said(out, "buffOff")[0]?.msg).toMatchObject({ id: 1, buff: "multispin" });
    expect(said(out, "hit")).toEqual([]);
  });

  it("hits a mob hugging its Slinger, inside the records' ring", () => {
    const towerClaim = { event: "tower-1", until: (T0 + 3_600_000) / 1000, floor: 6 };
    const f = FightRuntime.tower(towerClaim, "u", 20, ARENA, T0, 3);
    f.join("u", 1, ticket({ cls: "record_slinger", lv: 20, sk: [["multispin", 5]] }), ARENA.entry, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    const mob = tw.wireMobs()[0];
    // Right up against it: its centre well inside the ring.
    const at = { x: mob.x - 0.3, z: mob.z };
    for (let t = T0; t <= T0 + 200; t += 50) f.onState("u", at.x, at.z, t);
    expect(f.skill("u", "multispin", 0, 0, T0 + 200).result).toBe("used");
    const hit: number[] = [];
    for (let t = T0 + 250; t <= T0 + 200 + MULTISPIN.turnMs; t += 50) {
      f.onState("u", at.x, at.z, t);
      for (const o of said(f.step(t), "hit"))
        if (o.msg.t === "hit" && o.msg.mob === mob.id) hit.push(o.msg.mob);
    }
    // Each of its five records, about once a turn.
    expect(hit.length).toBeGreaterThanOrEqual(5);
  });
});

describe("Tower boons", () => {
  const BIG = { sonicPower: 5_000, critChance: 0, critDamage: 0 };
  const b = (id: TowerBoon["id"], rarity: TowerBoon["rarity"] = "common") => ({
    id,
    rarity,
  });
  /** A climb started on `floor`, with `boons` picked and `skips` skipped
   * (climb 2). */
  const climb = (
    floor: number,
    boons: TowerBoon[] = [],
    st?: TownTicketPayload["st"],
    skips = 0,
  ) => {
    const claim = {
      event: "tower-1",
      until: (T0 + 3_600_000) / 1000,
      floor,
      boons,
      skips,
      climb: 2,
    };
    const f = FightRuntime.tower(claim, "u", 20, ARENA, T0, 3);
    f.join("u", 1, ticket({ lv: 20, ...(st ? { st } : {}) }), ARENA.entry, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    return { f, tw };
  };

  const EVERY = TOWER_BOONS.every;

  it("offers the seeded three for each pick, and takes one or skips", () => {
    // Two picks' worth of floors cleared before.
    const { f, tw } = climb(2 * EVERY + 1);
    const first = f.floorView(tw);
    expect(first).toMatchObject({ boons: [], picks: 2 });
    expect(first.offers).toEqual(
      towerBoonOffers(towerBoonSeed("u", "tower-1", 2, 0), EVERY),
    );
    const taken = first.offers?.[1];
    const after = said(f.towerPick("u", 1), "floor")[0]?.msg as
      | Extract<ServerMessage, { t: "floor" }>
      | undefined;
    expect(after).toMatchObject({ boons: [taken], picks: 1 });
    // The next pick's offers are its own.
    expect(after?.offers).toEqual(
      towerBoonOffers(towerBoonSeed("u", "tower-1", 2, 1), 2 * EVERY),
    );
    // Skipping spends it.
    expect(said(f.towerPick("u", null), "floor")[0]?.msg).toMatchObject({
      boons: [taken],
      picks: 0,
    });
    expect(f.towerPick("u", 0)).toEqual([]);
    // The database hears of it all, with the climb's number.
    expect(f.report(T0 + 1, true)?.tower).toMatchObject({
      uid: "u",
      climb: 2,
      boons: [taken],
      skips: 1,
    });
  });

  it("refuses an offer that isn't there, and a pick not earned", () => {
    expect(climb(EVERY + 1).f.towerPick("u", 3)).toEqual([]);
    expect(climb(EVERY + 1, [], undefined, 1).f.towerPick("u", 0)).toEqual([]);
    expect(climb(EVERY).f.towerPick("u", 0)).toEqual([]);
  });

  it("a pick is earned every few floors, as the floor clears", () => {
    const { f, tw } = climb(EVERY);
    expect(f.floorView(tw).picks).toBe(0);
    let t = T0;
    while (!tw.isCleared && t < T0 + 120_000) {
      const mob = tw.wireMobs()[0];
      const at = { x: mob.x - 5, z: mob.z };
      tw.cast("u", at, aimAt(at, mob), 0, BIG, t);
      for (let i = 0; i < 10 && !tw.isCleared; i++) f.step((t += 50));
    }
    expect(f.floorView(tw).picks).toBe(1);
  });

  /** What `uid`'s first cast at the nearest mob hits for, with `boons`;
   * `hurt` takes the mob down to a quarter of its health first. */
  const hitFor = (boons: TowerBoon[], hurt = false) => {
    const e = engine(1, 1);
    e.setBoons("u", towerBoonTotals(boons));
    const mob = e.wireMobs()[0];
    if (hurt) {
      const pack = (
        e as unknown as {
          pack: { byId(id: number): { hp: number; maxHp: number } };
        }
      ).pack;
      const m = pack.byId(mob.id);
      m.hp = m.maxHp / 4;
    }
    const at = { x: mob.x - 3, z: mob.z };
    expect(
      e.cast("u", at, aimAt(at, mob), 0, { ...STATS, sonicPower: 500 }, T0),
    ).toBe("hit");
    for (let t = T0 + 50; t <= T0 + 2_000; t += 50)
      for (const ev of e.update(t, [])) if (ev.t === "hit") return ev.damage;
    throw new Error("no hit");
  };

  it("damage: its hits land harder", () => {
    const plain = hitFor([]);
    const boosted = hitFor([b("damage", "rare"), b("damage", "rare")]);
    expect(Math.abs(boosted - plain * 1.24)).toBeLessThanOrEqual(1);
  });

  it("executioner: harder only on a mob under a third of its health", () => {
    const ex = [b("executioner", "rare")];
    expect(hitFor(ex)).toBe(hitFor([]));
    expect(
      Math.abs(hitFor(ex, true) - hitFor([], true) * 1.25),
    ).toBeLessThanOrEqual(1);
  });

  it("speed: its attacks come quicker", () => {
    const every = (TUNING.castEveryMs / 1.1) * 1.02;
    const refused = (boons: TowerBoon[]) => {
      const e = engine(1, 1);
      e.setBoons("u", towerBoonTotals(boons));
      let n = 0;
      for (let i = 0; i < 40; i++)
        if (e.spendCast("u", T0 + 1_000 + i * every) === false) n++;
      return n;
    };
    expect(refused([b("speed", "rare")])).toBe(0);
    expect(refused([])).toBeGreaterThan(0);
  });

  /** Standing in the first floor's mobs for 20 s: the health it lost, and
   * the damage the mobs took. */
  const stand = (boons: TowerBoon[]) => {
    const { f, tw } = climb(1, boons, [0, 0, 0, 0, 0, 60, 0, 0]);
    const full = tw.wireMobs().reduce((s, m) => s + m.hp, 0);
    for (let t = T0; t <= T0 + 20_000; t += 50) {
      f.onState("u", ARENA.entry.x, ARENA.entry.z, t);
      f.step(t);
    }
    const p = f.player("u");
    if (!p) throw new Error("no player");
    const left = tw.wireMobs().reduce((s, m) => s + m.hp, 0);
    return { lost: p.maxHp - p.hp, dealt: full - left };
  };

  it("def: the mobs' hits take less of its health", () => {
    const plain = stand([]).lost;
    expect(plain).toBeGreaterThan(0);
    expect(
      stand([b("def", "legendary"), b("def", "legendary")]).lost,
    ).toBeLessThan(plain);
  });

  it("thorns: a mob that hits it takes some back", () => {
    expect(stand([]).dealt).toBe(0);
    expect(stand([b("thorns", "mythic")]).dealt).toBeGreaterThan(0);
  });

  it("tempo: its skills come back sooner", () => {
    const readyAfter = (boons: TowerBoon[]) => {
      const claim = {
        event: "tower-1",
        until: (T0 + 3_600_000) / 1000,
        floor: 1,
        boons,
        climb: 2,
      };
      const f = FightRuntime.tower(claim, "u", 20, ARENA, T0, 3);
      f.join(
        "u",
        1,
        ticket({ lv: 20, sk: [["soothing-drones", 1]] }),
        ARENA.entry,
        T0,
      );
      const r = f.skill("u", "soothing-drones", 0, 0, T0 + 100);
      expect(r.result).toBe("used");
      return r.readyAt - (T0 + 100);
    };
    expect(readyAfter([b("tempo", "mythic")])).toBe(
      Math.round(readyAfter([]) * 0.8),
    );
  });
});

describe("FightRuntime in the Tower", () => {
  const claim = { event: "tower-1", until: (T0 + 3_600_000) / 1000, floor: 3 };

  function tower() {
    const f = FightRuntime.tower(claim, "u", 5, ARENA, T0, 3);
    f.join("u", 1, ticket(), ARENA.entry, T0);
    return f;
  }

  it("welcomes you onto your floor", () => {
    const f = tower();
    const state = f.state(T0);
    expect(state.tower?.floor).toBe(3);
    expect(state.tower?.mobs).toHaveLength(mobsOnFloor(3));
    expect(state.tower?.you).toBe(5);
  });

  it("sends the mobs every step, and no boss", () => {
    const f = tower();
    const out = f.step(T0 + 50);
    expect(said(out, "mobs")).toHaveLength(1);
    expect(said(out, "boss")).toHaveLength(0);
  });

  it("reports kills and the floor cleared in a batch, no boss damage", () => {
    const f = FightRuntime.tower(
      { ...claim, floor: 1 },
      "u",
      60,
      ARENA,
      T0,
      3,
    );
    // Somewhere the mobs won't reach in time.
    f.join("u", 1, ticket(), { x: 0, z: 0 }, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    let t = T0;
    const out: Outbound[] = [];
    while (!tw.isCleared && t < T0 + 60_000) {
      const mob = tw.wireMobs()[0];
      f.onState("u", mob.x - 4, mob.z, t);
      t += 50;
      f.onState("u", mob.x - 4, mob.z, t);
      f.cast("u", Math.PI / 2, 0, t);
      for (let i = 0; i < 10; i++) {
        t += 50;
        f.onState("u", mob.x - 4, mob.z, t);
        out.push(...f.step(t));
      }
    }
    expect(tw.isCleared).toBe(true);
    expect(said(out, "mobDown")).toHaveLength(mobsOnFloor(1));
    const floor = said(out, "floor").at(-1)?.msg;
    expect(floor?.t === "floor" && floor.cleared).toBe(true);
    const report = f.report(t, true);
    expect(report?.boss).toBeUndefined();
    expect(report?.results).toBeUndefined();
    expect(report?.tower?.kills).toHaveLength(mobsOnFloor(1));
    expect(report?.tower?.cleared).toBe(1);
    expect(report?.tower?.uid).toBe("u");
    // Until it lands, the same batch goes again.
    const again = f.report(t + 10, true);
    expect(again?.tower?.batch).toBe(report?.tower?.batch);
    if (report) f.reported(report);
    expect(f.report(t + 20, true)?.tower).toBeUndefined();

    // On to the next.
    const next = f.next("u", t);
    expect(said(next, "floor")).toHaveLength(1);
    expect(tw.floor).toBe(2);
  });

  it("plays a Shuffle: the disc bounces through the pack, and only the bounces pay it", () => {
    const f = FightRuntime.tower({ ...claim, floor: 6 }, "u", 20, ARENA, T0, 3);
    const sk: [string, number][] = [
      ["backspin", 1],
      ["shuffle", 10],
    ];
    f.join("u", 1, ticket({ cls: "record_slinger", lv: 20, sk }), ARENA.entry, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    const mobs = tw.wireMobs();
    const mob = mobs[0];
    const from = { x: mob.x, z: mob.z - 1 };
    for (let t = T0; t <= T0 + 200; t += 50) f.onState("u", from.x, from.z, t);
    const used = f.skill("u", "shuffle", 0, 0, T0 + 200);
    expect(used.result).toBe("used");
    expect(said(used.out, "buff")[0]?.msg).toMatchObject({
      buff: "shuffle",
      value: shuffleBounces(10),
    });
    const yaw = Math.atan2(mob.x - from.x, mob.z - from.z);
    expect(f.cast("u", yaw, 0, T0 + 300)).toBe("hit");
    const out: Outbound[] = [];
    for (let t = T0 + 300; t <= T0 + 3_000; t += 50) {
      f.onState("u", from.x, from.z, t);
      out.push(...f.step(t));
    }
    const bodies = mobs.map((m) => ({ ref: m.id, x: m.x, z: m.z, radius: 0 }));
    const chain = discChain(mob.id, mob, bodies, 5, SHUFFLE_REACH);
    expect(chain.length).toBeGreaterThan(0);
    const hits = said(out, "hit").map((o) => o.msg);
    expect(hits).toHaveLength(1 + chain.length);
    const xp = f.report(T0 + 3_001, true)?.skills?.xp ?? [];
    expect(xp.find((x) => x.skill === "shuffle")?.xp).toBeGreaterThan(0);
    expect(xp.find((x) => x.skill === "backspin")).toBeUndefined();
  });

  it("takes a class and a level from a renewed ticket", () => {
    const f = FightRuntime.tower(claim, "u", 1, ARENA, T0, 3);
    // No class yet: a bump, only up close.
    f.join("u", 1, ticket({ cls: undefined, lv: 1 }), { x: 0, z: 0 }, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    const mob = tw.wireMobs()[0];
    const from = { x: mob.x - 8, z: mob.z };
    f.onState("u", from.x, from.z, T0);
    f.onState("u", from.x, from.z, T0 + 400);
    expect(f.cast("u", Math.PI / 2, 0, T0 + 400)).toBe("miss");
    // Picked a class and levelled up: the renewed ticket says so.
    const out = f.renew("u", ticket({ cls: "record_slinger", lv: 15 }));
    expect(tw.level).toBe(15);
    expect(said(out, "floor")).toHaveLength(1);
    f.onState("u", from.x, from.z, T0 + 1_400);
    expect(f.cast("u", Math.PI / 2, 0, T0 + 1_400)).toBe("hit");
  });

  it("joins at today's level, though the room is older", () => {
    const f = FightRuntime.tower(claim, "u", 1, ARENA, T0, 3);
    f.join("u", 1, ticket({ lv: 12 }), ARENA.entry, T0);
    expect(f.tower?.level).toBe(12);
  });

  it("won't go on before the floor's cleared", () => {
    const f = tower();
    expect(f.next("u", T0)).toEqual([]);
  });

  it("music is the cave's bonus here too: in after the settle, out after the linger", () => {
    const f = FightRuntime.tower(claim, "u", 5, ARENA, T0, 3);
    const tough = { hp: { hp: 1e6, maxHp: 1e6, down: false } };
    f.join("u", 1, ticket({ cls: "record_slinger", ...tough }), { x: 0, z: 0 }, T0);
    const steps = (from: number, until: number) => {
      const out: Outbound[] = [];
      for (let t = from; t <= until; t += 50) out.push(...f.step(t));
      return out;
    };
    f.tune("u", true, T0);
    expect(said(steps(T0, T0 + IN_TUNE.settleMs - 100), "buff")).toEqual([]);
    const on = steps(T0 + IN_TUNE.settleMs - 50, T0 + IN_TUNE.settleMs + 100);
    expect(said(on, "buff").map((o) => o.msg)).toMatchObject([
      { id: 1, buff: "in_tune", kind: "damage", value: IN_TUNE.damage },
    ]);
    // The engine has it, so the Tower's hits are that much harder.
    const at = T0 + IN_TUNE.settleMs + 200;
    expect(f.tower?.buffsOf("u", at)).toMatchObject([
      { id: "in_tune", kind: "damage", value: IN_TUNE.damage },
    ]);
    f.tune("u", false, at);
    expect(said(steps(at, at + IN_TUNE.lingerMs - 100), "buffOff")).toEqual([]);
    const off = steps(at + IN_TUNE.lingerMs - 50, at + IN_TUNE.lingerMs + 100);
    expect(said(off, "buffOff").map((o) => o.msg)).toMatchObject([
      { id: 1, buff: "in_tune" },
    ]);
    expect(f.tower?.buffsOf("u", at + IN_TUNE.lingerMs + 200)).toEqual([]);
  });

  it("an in-tune Record Slinger hits a Tower mob a quarter harder", () => {
    const dealt = (tuned: boolean) => {
      const e = engine(10, 10);
      if (tuned)
        e.buff("u", { id: "in_tune", kind: "damage", value: IN_TUNE.damage, until: T0 + 1e7 });
      const mob = e.wireMobs()[0];
      const from = { x: mob.x, z: mob.z - 6 };
      e.cast("u", from, aimAt(from, mob), 0, { ...STATS, sonicPower: 200 }, T0);
      const hit = run(e, T0, T0 + 1_000, []).find((x) => x.t === "hit");
      if (hit?.t !== "hit") throw new Error("no hit");
      return hit.damage;
    };
    const plain = dealt(false);
    expect(plain).toBeGreaterThan(20);
    expect(Math.abs(dealt(true) - plain * IN_TUNE.damage)).toBeLessThanOrEqual(1);
  });
});

describe("the Warden's chest", () => {
  /** Hard enough to fell a Warden in a few waves. */
  const BIG = { sonicPower: 5_000, critChance: 0, critDamage: 0 };

  /** Fires at whatever's left from out of its reach, stepping with `step`,
   * till the floor's cleared. Returns when it was. */
  function clearWith(
    tw: TowerEngine,
    from: number,
    step: (t: number) => void,
  ): number {
    let t = from;
    while (!tw.isCleared && t < from + 120_000) {
      const mob = tw.wireMobs()[0];
      const at = { x: mob.x - 5, z: mob.z };
      tw.cast("u", at, aimAt(at, mob), 0, BIG, t);
      for (let i = 0; i < 10 && !tw.isCleared; i++) step((t += 50));
    }
    if (!tw.isCleared) throw new Error("not cleared");
    return t;
  }

  it("stands only on a cleared 10th floor", () => {
    for (const floor of [9, 10, 11, 20]) {
      const e = engine(floor, 99);
      expect(e.view().chest).toBeUndefined();
      clearWith(e, T0, (t) => e.update(t, []));
      expect(e.view().chest).toEqual(
        floor % 10 === 0 ? TOWER_CHEST.at : undefined,
      );
    }
  });

  it("opens to E by it, once, after it's landed; walking up opens nothing", () => {
    const e = engine(10, 99);
    const cleared = clearWith(e, T0, (t) => e.update(t, []));
    const near = { x: TOWER_CHEST.reach - 0.2, z: 0 };
    const far = { x: TOWER_CHEST.reach + LOOT_REACH_SLACK + 0.5, z: 0 };
    const after = cleared + TOWER_CHEST.settleMs;
    // Stood on it, nothing opens by itself.
    const evs = run(e, cleared, after + 2_000, [player(() => near)]);
    expect(evs.filter((x) => x.t === "chest")).toEqual([]);
    expect(e.view().chest).toEqual(TOWER_CHEST.at);
    // Landing: even on the star, it waits; from too far, never.
    expect(e.openChestAt(near, cleared + TOWER_CHEST.settleMs - 100)).toBeNull();
    expect(e.openChestAt(far, after + 2_000)).toBeNull();
    expect(e.openChestAt(near, after + 2_050)).toEqual({
      t: "chest",
      floor: 10,
      x: TOWER_CHEST.at.x,
      z: TOWER_CHEST.at.z,
    });
    expect(e.view().chest).toBeUndefined();
    expect(e.openChestAt(near, after + 2_100)).toBeNull();
    expect(e.openChest()).toBeNull();
    // On to 11: none there.
    expect(e.next(after + 6_100)).toBe(true);
    expect(e.view().chest).toBeUndefined();
  });

  function fight() {
    const claim = { event: "tower-1", until: (T0 + 3_600_000) / 1000, floor: 10 };
    const f = FightRuntime.tower(claim, "u", 99, ARENA, T0, 3);
    f.join("u", 1, ticket({ lv: 99 }), ARENA.entry, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    const out: Outbound[] = [];
    let at: { x: number; z: number } = ARENA.entry;
    const step = (t: number) => {
      f.onState("u", at.x, at.z, t);
      out.push(...f.step(t));
    };
    const t = clearWith(tw, T0, step);
    const goTo = (to: { x: number; z: number }) => {
      at = to;
    };
    return { f, tw, out, step, goTo, t };
  }

  it("in a fight: E by it opens it once, and its loot comes out of it", () => {
    const { f, out, step, goTo, t } = fight();
    const floors = () =>
      said(out, "floor").map((o) => (o.msg.t === "floor" ? o.msg : null));
    expect(floors().at(-1)?.chest).toEqual(TOWER_CHEST.at);
    const first = f.report(t, true);
    expect(first?.tower?.cleared).toBe(10);
    expect(first?.tower?.chest).toBeUndefined();
    if (first) f.reported(first);

    goTo(TOWER_CHEST.at);
    let now = t;
    while (now < t + TOWER_CHEST.settleMs + 500) step((now += 50));
    // Standing by it opens nothing; E does.
    expect(floors().at(-1)?.chest).toEqual(TOWER_CHEST.at);
    out.push(...f.chestOpen("u", now));
    expect(floors().at(-1)?.chest).toBeUndefined();
    const report = f.report(now, true);
    const batch = report?.tower;
    expect(batch?.chest).toEqual({ floor: 10, ...TOWER_CHEST.at });
    if (!report || !batch) throw new Error("no batch");
    const loot = f.towerLoot(
      { drops: [], chest: [{ id: "d1", item: "ghost" }] },
      batch,
    );
    expect(loot.map((o) => o.msg)).toEqual([
      { t: "loot", drops: [{ id: "d1", item: "ghost" }], at: TOWER_CHEST.at },
    ]);
    f.reported(report);
    // Standing on, or going on: no second chest.
    while (now < t + 5_000) step((now += 50));
    expect(f.report(now, true)?.tower?.chest).toBeUndefined();
    f.next("u", now);
    expect(f.report(now + 50, true)?.tower?.chest).toBeUndefined();
  });

  it("in a fight: going on with it shut opens it on the way", () => {
    const { f, tw, t } = fight();
    expect(tw.view().chest).toEqual(TOWER_CHEST.at);
    const next = f.next("u", t);
    expect(tw.floor).toBe(11);
    const floor = said(next, "floor")[0]?.msg;
    expect(floor?.t === "floor" && floor.chest).toBeUndefined();
    expect(f.report(t + 50, true)?.tower?.chest).toEqual({
      floor: 10,
      ...TOWER_CHEST.at,
    });
  });
});
