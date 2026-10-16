import {
  FLOOR_OPENING_MS,
  levelGapMods,
  MOB_SWING,
  mobsOnFloor,
  towerMob,
} from "@herzies/shared/tower";
import {
  type ServerMessage,
  TOWN_MAPS,
  type TownTicketPayload,
} from "@herzies/shared/town-net";
import { describe, expect, it } from "vitest";
import type { BossPlayer } from "../src/boss";
import { FightRuntime, type Outbound } from "../src/fight";
import { TowerEngine, type TowerEvent } from "../src/tower";

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

describe("TowerEngine", () => {
  it("spawns a floor's worth of mobs, away from the entry", () => {
    const e = engine(4);
    const mobs = e.wireMobs();
    expect(mobs).toHaveLength(mobsOnFloor(4));
    for (const m of mobs) {
      expect(m.hp).toBe(towerMob(4).hp);
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
    const high = towerMob(20).damage;
    expect(high).toBeGreaterThan(low);
    const take = (level: number) => {
      const e = engine(20, level);
      const ev = run(e, T0, T0 + 20_000, [player(() => ARENA.entry, 10_000)]);
      const tg = ev.find((x) => x.t === "telegraph");
      if (tg?.t !== "telegraph") throw new Error("no swing");
      return tg.telegraph.damage;
    };
    expect(take(1)).toBeGreaterThan(take(40));
    expect(take(1)).toBe(Math.round(high * levelGapMods(19).taken));
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
});

const ticket = (over: Partial<TownTicketPayload> = {}): TownTicketPayload => ({
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

  it("won't go on before the floor's cleared", () => {
    const f = tower();
    expect(f.next("u", T0)).toEqual([]);
  });
});
