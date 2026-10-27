import {
  BUMP_DAMAGE,
  CAST_INTERVAL_MS,
  DISC_DAMAGE,
  STRIKE_DAMAGE,
} from "@herzies/shared/combat";
import { TOWN_WALK_SPEED } from "@herzies/shared/town-net";
import { BOSS_WANDER } from "@herzies/shared/boss-fight";
import { describe, expect, it } from "vitest";
import {
  BossEngine,
  type BossEvent,
  type BossPlayer,
  covers,
  MAX_HIT_FRACTION,
  MAX_TELEGRAPHS,
  MIN_WINDUP_MS,
  phaseFor,
  type Telegraph,
  TUNING,
} from "../src/boss";
import { PositionHistory } from "../src/history";

const STATS = { sonicPower: 0, critChance: 0, critDamage: 0 };
const T0 = 1_000_000;

/** A player who stays where they are. */
const still = (uid: string, x: number, z: number, maxHp = 200): BossPlayer => ({
  uid,
  alive: true,
  maxHp,
  posAt: () => ({ x, z }),
});

function engine(hp = 1000, maxHp = 1000, seed = 1) {
  return new BossEngine({ hp, maxHp, seed, now: T0 });
}

/** Run to `until` in 50ms steps, collecting events. */
function run(
  e: BossEngine,
  from: number,
  until: number,
  players: BossPlayer[],
): BossEvent[] {
  const out: BossEvent[] = [];
  for (let t = from; t <= until; t += 50) out.push(...e.update(t, players));
  return out;
}

const telegraphs = (ev: BossEvent[]) =>
  ev.flatMap((x) => (x.t === "telegraph" ? [x.telegraph] : []));

describe("tuning invariants", () => {
  it("every telegraph gives at least the minimum windup", () => {
    expect(TUNING.slam.windupMs).toBeGreaterThanOrEqual(MIN_WINDUP_MS);
    expect(TUNING.ring.windupMs).toBeGreaterThanOrEqual(MIN_WINDUP_MS);
  });

  it("a level-20 herzie with no Stamina takes hits within the budget", () => {
    const max = 200;
    expect(TUNING.slam.damage).toBeLessThanOrEqual(MAX_HIT_FRACTION * max);
    expect(TUNING.ring.damage).toBeLessThanOrEqual(MAX_HIT_FRACTION * max);
  });

  it("a slam can be left on foot within its windup, with time to react", () => {
    const REACTION_MS = 600;
    const escape = (TUNING.slam.radius / TOWN_WALK_SPEED) * 1000;
    expect(escape + REACTION_MS).toBeLessThanOrEqual(TUNING.slam.windupMs);
  });

  it("the ring's safe middle can be reached from the far wall in its windup", () => {
    const REACTION_MS = 600;
    // The farthest a herzie can stand from the boss inside the room,
    // wherever in its circle the boss has walked.
    const farthest =
      Math.hypot(BOSS_WANDER.x, BOSS_WANDER.z) +
      BOSS_WANDER.radius +
      TUNING.roomRadius;
    const walk = ((farthest - TUNING.ring.inner) / TOWN_WALK_SPEED) * 1000;
    expect(walk + REACTION_MS).toBeLessThanOrEqual(TUNING.ring.windupMs);
  });

  it("the ring's safe middle is wider than the boss", () => {
    expect(TUNING.ring.inner).toBeGreaterThan(TUNING.boss.radius + 1);
  });

  it("phases get busier, and shapes are capped", () => {
    expect(TUNING.phases[2].everyMs).toBeLessThan(TUNING.phases[1].everyMs);
    expect(TUNING.phases[3].everyMs).toBeLessThan(TUNING.phases[2].everyMs);
    expect(MAX_TELEGRAPHS).toBeLessThanOrEqual(4);
  });
});

describe("phases", () => {
  it("follow the boss's health", () => {
    expect(phaseFor(1000, 1000)).toBe(1);
    expect(phaseFor(660, 1000)).toBe(2);
    expect(phaseFor(330, 1000)).toBe(3);
    expect(phaseFor(1, 1000)).toBe(3);
  });
});

describe("covers", () => {
  const circle: Telegraph = {
    id: 1,
    kind: "circle",
    x: 0,
    z: 0,
    r: 3,
    inner: 0,
    at: 0,
    hitAt: 0,
    damage: 40,
  };
  it("a circle covers its disc", () => {
    expect(covers(circle, 2.9, 0)).toBe(true);
    expect(covers(circle, 3.1, 0)).toBe(false);
  });
  it("a ring leaves its middle safe", () => {
    const ring = { ...circle, kind: "ring" as const, r: 15, inner: 6.5 };
    expect(covers(ring, 3, 0)).toBe(false);
    expect(covers(ring, 8, 0)).toBe(true);
  });
  it("a lane covers its strip, a herzie's width either side", () => {
    // From the origin heading +z (yaw 0), 10 long, 1.3 either side.
    const lane = { ...circle, kind: "lane" as const, r: 1.3, yaw: 0, len: 10 };
    expect(covers(lane, 0, 5)).toBe(true);
    expect(covers(lane, 1.6, 9)).toBe(true);
    expect(covers(lane, 2.2, 5)).toBe(false);
    expect(covers(lane, 0, 11)).toBe(false);
    // Turned a quarter: heading +x.
    const east = { ...lane, yaw: Math.PI / 2 };
    expect(covers(east, 5, 0)).toBe(true);
    expect(covers(east, 0, 5)).toBe(false);
  });
});

describe("the boss roams", () => {
  const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    Math.hypot(a.x - b.x, a.z - b.z);

  it("keeps walking after its focus through its own slams", () => {
    const e = engine();
    const far = still("a", 6, 6);
    const ev = run(e, T0, T0 + 3_100, [far]);
    const slam = telegraphs(ev).find((t) => t.kind === "circle");
    expect(slam).toBeDefined();
    const before = e.position;
    run(e, T0 + 3_150, T0 + 3_500, [far]);
    expect(dist(e.position, before)).toBeGreaterThan(0.3);
  });

  it("stands still while its ring winds up", () => {
    const e = engine(200, 1000, 3);
    const p = still("a", 3, 6);
    let ring: Telegraph | undefined;
    for (let t = T0; t < T0 + 60_000 && !ring; t += 50) {
      ring = telegraphs(e.update(t, [p])).find((x) => x.kind === "ring");
      if (ring) {
        const at = e.position;
        run(e, t + 50, ring.hitAt - 50, [p]);
        expect(dist(e.position, at)).toBeLessThan(1e-6);
      }
    }
    expect(ring).toBeDefined();
  });

  it("closes to within a blow's reach, then shifts round whoever it's on", () => {
    const e = engine();
    const p = still("a", 0, 2);
    run(e, T0, T0 + 4_000, [p]);
    const reach = dist(e.position, { x: 0, z: 2 }) - TUNING.boss.radius - TUNING.playerRadius;
    expect(reach).toBeLessThan(1.6);
    const spots: { x: number; z: number }[] = [];
    for (let t = T0 + 4_000; t < T0 + 20_000; t += 50) {
      e.update(t, [p]);
      spots.push(e.position);
    }
    const moved = Math.max(...spots.map((s) => dist(s, spots[0])));
    expect(moved).toBeGreaterThan(1);
  });

  it("from phase 2, charges whoever keeps far off, down a lane it draws first", () => {
    const e = engine(600, 1000, 2);
    // Its focus up close (the nearest), and someone at the back.
    const tank = still("tank", 0, -1);
    const back = still("back", 3, 6);
    let lane: Telegraph | undefined;
    let t = T0;
    for (; t < T0 + 60_000 && !lane; t += 50)
      lane = telegraphs(e.update(t, [tank, back])).find((x) => x.kind === "lane");
    expect(lane).toBeDefined();
    if (!lane) return;
    expect(lane.at).toBeGreaterThanOrEqual(T0 + 3_000 + TUNING.charge.everyMs);
    expect(lane.hitAt - lane.at).toBe(TUNING.charge.windupMs);
    expect(covers(lane, 3, 6)).toBe(true);
    // It hits whoever's in the lane as it goes, and ends up down the lane.
    const after = run(e, t, lane.hitAt + 2_000, [tank, back]);
    const hit = after.find((x) => x.t === "resolve" && x.id === lane.id);
    expect(hit?.t === "resolve" && hit.hits.map((h) => h.uid)).toContain("back");
    expect(dist(e.position, { x: 3, z: 6 })).toBeLessThan(dist({ x: lane.x, z: lane.z }, { x: 3, z: 6 }));
    expect(
      Math.hypot(e.position.x - BOSS_WANDER.x, e.position.z - BOSS_WANDER.z),
    ).toBeLessThanOrEqual(BOSS_WANDER.radius + 1e-6);
  });

  it("doesn't charge in phase 1, or when everyone's close", () => {
    const calm = engine();
    const ev = run(calm, T0, T0 + 40_000, [still("a", 0, -1), still("b", 5, 9)]);
    expect(telegraphs(ev).some((t) => t.kind === "lane")).toBe(false);
    const close = engine(600, 1000, 2);
    const ev2 = run(close, T0, T0 + 40_000, [still("a", 0, -1), still("b", 1, 0)]);
    expect(telegraphs(ev2).some((t) => t.kind === "lane")).toBe(false);
  });
});

describe("attacks", () => {
  it("waits out the opening, then telegraphs a slam on a player", () => {
    const e = engine();
    const p = still("a", 3, 4);
    expect(telegraphs(run(e, T0, T0 + TUNING.openingMs - 100, [p]))).toEqual([]);
    const tgs = telegraphs(run(e, T0 + TUNING.openingMs - 50, T0 + TUNING.openingMs + 100, [p]));
    expect(tgs).toHaveLength(1);
    expect(tgs[0]).toMatchObject({ kind: "circle", x: 3, z: 4 });
    expect(tgs[0].hitAt - tgs[0].at).toBeGreaterThanOrEqual(MIN_WINDUP_MS);
  });

  it("hits a player who stays put, for flat damage", () => {
    const e = engine();
    const p = still("a", 0, 5, 300);
    const ev = run(e, T0, T0 + 6_000, [p]);
    const resolve = ev.find((x) => x.t === "resolve");
    expect(resolve).toBeTruthy();
    if (resolve?.t !== "resolve") return;
    expect(resolve.hits).toEqual([
      // Alone, it's the one the boss is after: the slam is aimed at it.
      { uid: "a", damage: TUNING.slam.damage, absorbed: 0, blocked: 0, aimed: true },
    ]);
  });

  it("caps a hit at a share of a small herzie's health", () => {
    const e = engine();
    const p = still("a", 0, 5, 60);
    const ev = run(e, T0, T0 + 6_000, [p]);
    const resolve = ev.find((x) => x.t === "resolve");
    if (resolve?.t !== "resolve") throw new Error("no hit");
    expect(MAX_HIT_FRACTION * 60).toBeLessThan(TUNING.slam.damage);
    expect(resolve.hits[0].damage).toBe(Math.round(MAX_HIT_FRACTION * 60));
  });

  it("Def takes its share off a hit", () => {
    const e = engine();
    const p = { ...still("a", 0, 5, 300), def: 100 };
    const ev = run(e, T0, T0 + 6_000, [p]);
    const resolve = ev.find((x) => x.t === "resolve");
    if (resolve?.t !== "resolve") throw new Error("no hit");
    // 100 Def: half off.
    const damage = Math.round(TUNING.slam.damage / 2);
    // Def isn't a Cymbrella: nothing blocked.
    expect(resolve.hits).toEqual([
      { uid: "a", damage, absorbed: TUNING.slam.damage - damage, blocked: 0, aimed: true },
    ]);
  });

  it("misses a player who walked out of the zone", () => {
    const e = engine();
    let leaving = false;
    const p: BossPlayer = {
      uid: "a",
      alive: true,
      maxHp: 200,
      posAt: (t) => ({ x: leaving && t > T0 + 3_300 ? 20 : 0, z: 5 }),
    };
    const ev: BossEvent[] = [];
    for (let t = T0; t <= T0 + 6_000; t += 50) {
      if (t > T0 + 3_200) leaving = true;
      ev.push(...e.update(t, [p]));
    }
    const resolve = ev.find((x) => x.t === "resolve");
    expect(resolve?.t === "resolve" && resolve.hits).toEqual([]);
  });

  it("favours the dodger: only inside a moment ago, not now, is no hit", () => {
    const e = engine();
    const p: BossPlayer = {
      uid: "a",
      alive: true,
      maxHp: 200,
      // Standing in the zone only at the instant it lands.
      posAt: (t) => ({ x: t >= T0 + TUNING.openingMs + TUNING.slam.windupMs - 10 ? 0 : 30, z: 5 }),
    };
    const ev = run(e, T0, T0 + 6_000, [p]);
    const resolve = ev.find((x) => x.t === "resolve");
    expect(resolve?.t === "resolve" && resolve.hits).toEqual([]);
  });

  it("doesn't chain hits: a hit herzie is safe for a moment", () => {
    const e = engine(300, 1000); // phase 3: busy
    const p = still("a", 0, 5, 1000);
    const ev = run(e, T0, T0 + 20_000, [p]);
    const hits = ev
      .flatMap((x) => (x.t === "resolve" ? x.hits : []))
      .filter((h) => h.uid === "a");
    expect(hits.length).toBeGreaterThan(1);
    const resolves = ev.filter((x) => x.t === "resolve");
    expect(resolves.length).toBeGreaterThanOrEqual(hits.length);
  });

  it("never targets or hurts someone who just arrived", () => {
    const e = engine();
    e.noteSpawn("a", T0 + 2_500);
    const p = still("a", 0, 5);
    const ev = run(e, T0 + 2_500, T0 + 4_400, [p]);
    expect(telegraphs(ev)).toEqual([]);
  });

  it("skips fallen players, and aims at nobody when empty", () => {
    const e = engine();
    const dead = { ...still("a", 0, 5), alive: false };
    expect(telegraphs(run(e, T0, T0 + 8_000, [dead]))).toEqual([]);
    expect(telegraphs(run(e, T0 + 8_050, T0 + 9_000, []))).toEqual([]);
  });

  it("keeps few shapes on the floor at once", () => {
    const e = engine(300, 1000);
    const players = Array.from({ length: 12 }, (_, i) =>
      still(`p${i}`, (i % 6) * 2 - 5, Math.floor(i / 6) * 4),
    );
    let max = 0;
    for (let t = T0; t < T0 + 30_000; t += 50) {
      e.update(t, players);
      // Busters don't count against the cap (they always land).
      max = Math.max(
        max,
        e.active.filter((t) => t.kind !== "buster").length,
      );
    }
    // A few more in a bigger raid: 12 here.
    expect(max).toBeLessThanOrEqual(
      MAX_TELEGRAPHS + Math.floor(12 / TUNING.scale.perPlayers),
    );
  });

  it("is deterministic for a seed", () => {
    const run1 = run(engine(500, 1000, 7), T0, T0 + 30_000, [still("a", 1, 1), still("b", -3, 5)]);
    const run2 = run(engine(500, 1000, 7), T0, T0 + 30_000, [still("a", 1, 1), still("b", -3, 5)]);
    expect(run1).toEqual(run2);
  });
});

describe("casts", () => {
  /** Aim from (x, z) at the boss. */
  const aim = (x: number, z: number) => ({
    yaw: Math.atan2(TUNING.boss.x - x, TUNING.boss.z - z),
    // From the hand's height to the boss's chest.
    pitch: Math.atan2(
      TUNING.boss.chest - 1.2,
      Math.hypot(TUNING.boss.x - x, TUNING.boss.z - z),
    ),
  });

  it("lands a cast on the boss after the wave's flight", () => {
    const e = engine();
    const { yaw, pitch } = aim(0, 8);
    expect(e.cast("a", { x: 0, z: 8 }, yaw, pitch, STATS, T0)).toBe("hit");
    expect(e.update(T0 + 10, []).filter((x) => x.t === "hit")).toEqual([]);
    const ev = e.update(T0 + 1_000, []);
    const hit = ev.find((x) => x.t === "hit");
    expect(hit?.t === "hit" && hit.damage).toBeGreaterThan(80);
    expect(e.hp).toBeLessThan(1000);
  });

  it("misses when aimed away", () => {
    const e = engine();
    const { pitch } = aim(0, 8);
    expect(e.cast("a", { x: 0, z: 8 }, 0, pitch, STATS, T0)).toBe("miss");
  });

  it("allows a short burst, then holds to the pace; a miss costs a cast too", () => {
    const e = engine();
    const { yaw, pitch } = aim(0, 8);
    const at = { x: 0, z: 8 };
    expect(e.cast("a", at, 0, pitch, STATS, T0)).toBe("miss");
    expect(e.cast("a", at, yaw, pitch, STATS, T0 + 10)).toBe("hit");
    expect(e.cast("a", at, yaw, pitch, STATS, T0 + 20)).toBe("cooldown");
    // The pace refills: one more cast every castEveryMs.
    expect(
      e.cast("a", at, yaw, pitch, STATS, T0 + 20 + TUNING.castEveryMs),
    ).toBe("hit");
  });

  it("never drops a cast at the client's own pace, even with jitter", () => {
    const e = engine();
    const { yaw, pitch } = aim(0, 8);
    const at = { x: 0, z: 8 };
    let t = T0;
    for (let i = 0; i < 200; i++) {
      // The client casts every CAST_INTERVAL_MS; the network adds up to
      // 120 ms of jitter either way.
      t += CAST_INTERVAL_MS + (i % 3 === 0 ? 120 : i % 3 === 1 ? -120 : 0);
      expect(e.cast("a", at, yaw, pitch, STATS, t), `cast ${i}`).not.toBe(
        "cooldown",
      );
    }
  });

  it("forgives a little aim, as the client's assist does", () => {
    const e = engine();
    const { yaw, pitch } = aim(0, 8);
    expect(e.cast("a", { x: 0, z: 8 }, yaw + 0.03, pitch, STATS, T0)).toBe("hit");
  });

  it("is out of reach past the range", () => {
    const e = engine();
    const { yaw, pitch } = aim(0, 60);
    expect(e.cast("a", { x: 0, z: 60 }, yaw, pitch, STATS, T0)).toBe("miss");
  });

  it("kills once, announces it once, and stops attacking", () => {
    const e = engine(50, 1000);
    const { yaw, pitch } = aim(0, 8);
    e.cast("a", { x: 0, z: 8 }, yaw, pitch, { ...STATS, sonicPower: 100 }, T0);
    e.cast("b", { x: 0, z: 8 }, yaw, pitch, STATS, T0);
    const ev = e.update(T0 + 1_500, [still("a", 0, 8)]);
    expect(ev.filter((x) => x.t === "killed")).toHaveLength(1);
    expect(e.dead).toBe(true);
    expect(e.hp).toBe(0);
    expect(e.cast("c", { x: 0, z: 8 }, yaw, pitch, STATS, T0 + 2_000)).toBe("dead");
    expect(telegraphs(run(e, T0 + 2_000, T0 + 10_000, [still("a", 0, 8)]))).toEqual([]);
  });

  it("announces a change of phase and gives a breather", () => {
    const e = engine(670, 1000);
    const { yaw, pitch } = aim(0, 8);
    e.cast("a", { x: 0, z: 8 }, yaw, pitch, { ...STATS, sonicPower: 200 }, T0);
    const ev = e.update(T0 + 1_500, []);
    expect(ev.some((x) => x.t === "phase" && x.phase === 2)).toBe(true);
  });
});

describe("position history", () => {
  it("interpolates and forgets", () => {
    const h = new PositionHistory();
    h.record("a", 0, 0, 0);
    h.record("a", 100, 10, 0);
    expect(h.at("a", 50)).toEqual({ x: 5, z: 0 });
    expect(h.at("a", 500)).toEqual({ x: 10, z: 0 });
    expect(h.at("a", -50)).toEqual({ x: 0, z: 0 });
    expect(h.at("nobody", 0)).toBeNull();
    for (let t = 200; t <= 5_000; t += 100) h.record("a", t, t, 0);
    expect(h.at("a", 3_000)?.x).toBeGreaterThan(2_000);
    h.forget("a");
    expect(h.at("a", 0)).toBeNull();
  });
});

describe("melee damage", () => {
  // Pressed against its front, facing it.
  const front = { x: TUNING.boss.x, z: TUNING.boss.z + TUNING.boss.radius + 1 };
  const dealt = (melee?: number) => {
    const e = engine(10_000, 10_000);
    e.cast("a", front, Math.PI, 0, STATS, T0, "melee", melee);
    e.update(T0 + 1, [still("a", front.x, front.z)]);
    return 10_000 - e.hp;
  };

  it("a classless bump hits lighter than a Percussionist's stick", () => {
    expect(dealt(BUMP_DAMAGE)).toBeLessThan(dealt(STRIKE_DAMAGE));
    expect(dealt()).toBe(dealt(STRIKE_DAMAGE));
  });

  it("no blow out-hits the Record Slinger's disc", () => {
    expect(BUMP_DAMAGE).toBeLessThan(STRIKE_DAMAGE);
    expect(STRIKE_DAMAGE).toBeLessThan(DISC_DAMAGE);
  });
});

describe("production pass: fairness and the raid's size", () => {
  it("its minions never wind up faster than the boss's own minimum", () => {
    const e = engine(10_000, 10_000);
    const players = [still("a", 0, 6), still("b", 3, 6)];
    e.update(T0, players);
    e.summon(T0, 6, 30, 10, []);
    const windups: number[] = [];
    for (let t = T0; t < T0 + 30_000; t += 50) {
      for (const ev of e.update(t, players))
        if (ev.t === "telegraph" && ev.telegraph.mob !== undefined)
          windups.push(ev.telegraph.hitAt - ev.telegraph.at);
    }
    expect(windups.length).toBeGreaterThan(0);
    expect(Math.min(...windups)).toBeGreaterThanOrEqual(TUNING.minWindupMs);
  });

  it("a bigger raid gets more slams in a volley", () => {
    const volley = (n: number) => {
      const e = engine(300, 1000);
      const players = Array.from({ length: n }, (_, i) =>
        still(`p${i}`, ((i % 8) - 4) * 2.5, Math.floor(i / 8) * 2.5 + 2),
      );
      let most = 0;
      for (let t = T0; t < T0 + 20_000; t += 50)
        most = Math.max(
          most,
          e.update(t, players).filter(
            (ev) => ev.t === "telegraph" && ev.telegraph.kind === "circle",
          ).length,
        );
      return most;
    };
    expect(volley(36)).toBeGreaterThan(volley(8));
  });

  it("a buster leaves its target Rattled, and the next one hits harder", () => {
    const e = engine(1000, 1000);
    const tank: BossPlayer = { ...still("tank", 0, 5, 1_000) };
    const other = still("dps", 6, 9, 1_000);
    e.setTaunt("tank", T0 + 60_000, T0);
    const hits: number[] = [];
    let stacks = 0;
    for (let t = T0; t < T0 + 40_000; t += 50) {
      for (const ev of e.update(t, [tank, other])) {
        if (ev.t === "rattled") stacks = ev.stacks;
        if (ev.t === "resolve")
          for (const h of ev.hits)
            if (h.uid === "tank" && h.aimed) hits.push(h.damage + h.absorbed);
      }
    }
    expect(stacks).toBeGreaterThanOrEqual(2);
    // Busters only (slams on the focus are aimed too): the biggest grow.
    const sorted = [...hits].sort((a, b) => a - b);
    expect(sorted[sorted.length - 1]).toBeGreaterThan(TUNING.buster.damage);
  });

  it("doesn't flip its focus between two who hate it about the same", () => {
    const e = engine(100_000, 100_000);
    const a = still("a", -2, 4);
    const b = still("b", 2, 4);
    e.update(T0, [a, b]);
    e.addThreat("a", 1_000);
    e.update(T0 + 50, [a, b]);
    expect(e.focus).toBe("a");
    // b pulls a little ahead, but not 30% ahead: it stays on a.
    e.addThreat("b", 1_100);
    e.update(T0 + 100, [a, b]);
    expect(e.focus).toBe("a");
    e.addThreat("b", 500);
    e.update(T0 + 150, [a, b]);
    expect(e.focus).toBe("b");
  });

  it("in a big raid, scatter marks go off on whoever stands close to the marked", () => {
    const e = engine(1_000_000, 1_000_000, 3);
    // Twenty in pairs: whoever's marked takes their partner with them.
    const players = Array.from({ length: 20 }, (_, i) =>
      still(`p${i}`, (Math.floor(i / 2) - 5) * 2.4, 6 + (i % 2) * 0.5),
    );
    let marks = 0;
    let shared = 0;
    for (let t = T0; t < T0 + 40_000; t += 50) {
      for (const ev of e.update(t, players)) {
        if (ev.t === "telegraph" && ev.telegraph.kind === "scatter") marks++;
        if (ev.t === "resolve" && ev.hits.length > 1) shared++;
      }
    }
    expect(marks).toBeGreaterThanOrEqual(Math.ceil(20 / TUNING.scatter.perMarks));
    expect(shared).toBeGreaterThan(0);
  });
});
