/**
 * The whole fight, headless: scripted herzies against the boss, so tuning
 * that makes it unwinnable or trivial fails here rather than in a playtest.
 */
import { CAST_INTERVAL_MS, WAVE_HAND_HEIGHT } from "@herzies/shared/combat";
import { STAT_TUNING } from "@herzies/shared/stats";
import { maxHp as maxHpOf } from "@herzies/shared/vitals";
import { TOWN_WALK_SPEED } from "@herzies/shared/town-net";
import { describe, expect, it } from "vitest";
import {
  BossEngine,
  type BossPlayer,
  covers,
  type Telegraph,
  TUNING,
} from "../src/boss";
import { PositionHistory } from "../src/history";

const STEP = 50;
const REACTION_MS = 450;
const CAST_EVERY_MS = CAST_INTERVAL_MS; // the client's real pace
const BOSS_HP = 250_000;

type Bot = {
  uid: string;
  x: number;
  z: number;
  hp: number;
  max: number;
  alive: boolean;
  dodges: boolean;
  /** When it first saw each telegraph, for the reaction delay. */
  seen: Map<number, number>;
  nextCast: number;
  hitsTaken: number;
  /** Points in Stamina: more health, and Def. */
  stamina: number;
  damageTaken: number;
  /** When it was knocked out, ms into the fight. */
  downAt: number | null;
};

function bot(i: number, dodges: boolean, level = 30, stamina = 0): Bot {
  const angle = (i / 6) * Math.PI * 2;
  const max = maxHpOf(level, stamina);
  return {
    uid: `bot${i}`,
    x: Math.sin(angle) * 6,
    z: 4 + Math.cos(angle) * 4,
    hp: max,
    max,
    alive: true,
    dodges,
    seen: new Map(),
    nextCast: 0,
    hitsTaken: 0,
    stamina,
    damageTaken: 0,
    downAt: null,
  };
}

/** The nearest spot in the room clear of every shape (with a margin),
 * found on a one-unit grid; null if standing here is already fine. */
function safeSpot(
  tgs: readonly Telegraph[],
  x: number,
  z: number,
): { x: number; z: number } | null {
  const MARGIN = 0.6;
  const clear = (px: number, pz: number) =>
    tgs.every(
      (tg) =>
        !covers({ ...tg, r: tg.r + MARGIN, inner: Math.max(0, tg.inner - MARGIN) }, px, pz),
    );
  if (clear(x, z)) return null;
  let best: { x: number; z: number } | null = null;
  let bestD = Infinity;
  const R = TUNING.roomRadius;
  for (let gx = -R; gx <= R; gx += 1) {
    for (let gz = -R; gz <= R; gz += 1) {
      if (Math.hypot(gx, gz) > R) continue;
      const d = Math.hypot(gx - x, gz - z);
      if (d < bestD && clear(gx, gz)) {
        bestD = d;
        best = { x: gx, z: gz };
      }
    }
  }
  return best;
}

function fight(bots: Bot[], seed: number, limitMs = 30 * 60_000) {
  const t0 = 1_000_000;
  const boss = new BossEngine({ hp: BOSS_HP, maxHp: BOSS_HP, seed, now: t0 });
  const history = new PositionHistory();
  for (const b of bots) boss.noteSpawn(b.uid, t0);
  let t = t0;
  let killedAt: number | null = null;
  while (t - t0 < limitMs && killedAt === null) {
    t += STEP;
    // Bots: dodge, then cast.
    for (const b of bots) {
      if (!b.alive) continue;
      if (b.dodges) {
        // React only to shapes it has had REACTION_MS to notice.
        const noticed = boss.active.filter((tg) => {
          if (!b.seen.has(tg.id)) b.seen.set(tg.id, t);
          return t - (b.seen.get(tg.id) as number) >= REACTION_MS;
        });
        const target = safeSpot(noticed, b.x, b.z);
        if (target) {
          const dx = target.x - b.x;
          const dz = target.z - b.z;
          const d = Math.hypot(dx, dz);
          const step = Math.min(d, (TOWN_WALK_SPEED * STEP) / 1000);
          if (d > 1e-6) {
            b.x += (dx / d) * step;
            b.z += (dz / d) * step;
          }
          const r = Math.hypot(b.x, b.z);
          if (r > TUNING.roomRadius) {
            b.x *= TUNING.roomRadius / r;
            b.z *= TUNING.roomRadius / r;
          }
        }
      }
      history.record(b.uid, t, b.x, b.z);
      if (t >= b.nextCast) {
        b.nextCast = t + CAST_EVERY_MS;
        const dx = TUNING.boss.x - b.x;
        const dz = TUNING.boss.z - b.z;
        boss.cast(
          b.uid,
          { x: b.x, z: b.z },
          Math.atan2(dx, dz),
          Math.atan2(TUNING.boss.chest - WAVE_HAND_HEIGHT, Math.hypot(dx, dz)),
          { sonicPower: 0, critChance: 5, critDamage: 50 },
          t,
        );
      }
    }
    const players: BossPlayer[] = bots.map((b) => ({
      uid: b.uid,
      alive: b.alive,
      maxHp: b.max,
      def: b.stamina * STAT_TUNING.defPerStamina,
      posAt: (at) => history.at(b.uid, at),
    }));
    for (const ev of boss.update(t, players)) {
      if (ev.t === "resolve") {
        for (const h of ev.hits) {
          const b = bots.find((x) => x.uid === h.uid) as Bot;
          b.hp -= h.damage;
          b.hitsTaken++;
          b.damageTaken += h.damage;
          if (b.hp <= 0 && b.alive) {
            b.alive = false;
            b.downAt = t - t0;
          }
        }
      }
      if (ev.t === "killed") killedAt = t - t0;
    }
  }
  return { killedAt, boss };
}

describe("a full fight, simulated", () => {
  it("five attentive players win, with little damage taken", () => {
    const bots = Array.from({ length: 5 }, (_, i) => bot(i, true));
    const { killedAt } = fight(bots, 1);
    expect(killedAt).not.toBeNull();
    // A few minutes: long enough to be a fight, short enough to be fun.
    expect(killedAt as number).toBeGreaterThan(60_000);
    expect(killedAt as number).toBeLessThan(6 * 60_000);
    expect(bots.every((b) => b.alive)).toBe(true);
    for (const b of bots) expect(b.hp / b.max).toBeGreaterThan(0.4);
  });

  it("a lone attentive player can win, but it takes a while", () => {
    const bots = [bot(0, true)];
    const { killedAt } = fight(bots, 2);
    expect(killedAt).not.toBeNull();
    expect(bots[0].alive).toBe(true);
    expect(killedAt as number).toBeGreaterThan(5 * 60_000);
  });

  it("someone who never moves is knocked out: dodging matters", () => {
    const bots = [bot(0, false)];
    fight(bots, 3, 10 * 60_000);
    expect(bots[0].alive).toBe(false);
  });

  it("a mixed group still wins; the idle ones pay for it", () => {
    const bots = [
      ...[0, 1, 2].map((i) => bot(i, true)),
      ...[3, 4].map((i) => bot(i, false)),
    ];
    const { killedAt } = fight(bots, 4);
    expect(killedAt).not.toBeNull();
    expect(bots.filter((b) => b.dodges).every((b) => b.alive)).toBe(true);
    expect(bots.filter((b) => !b.dodges).some((b) => b.hitsTaken > 0)).toBe(true);
  });

  it("Stamina lets someone who stands in it last much longer", () => {
    // Level 30, every point in Stamina, standing still: no dodging at all.
    const plain = [bot(0, false)];
    const tank = [bot(0, false, 30, 60)];
    fight(plain, 5, 10 * 60_000);
    fight(tank, 5, 10 * 60_000);
    expect(plain[0].downAt).not.toBeNull();
    // Def takes a share off every hit…
    expect(tank[0].damageTaken / tank[0].hitsTaken).toBeLessThan(
      0.8 * (plain[0].damageTaken / plain[0].hitsTaken),
    );
    // …and the bigger bar lasts several times as long.
    expect(tank[0].downAt ?? Infinity).toBeGreaterThan(
      3 * (plain[0].downAt as number),
    );
  });

  it("is winnable across seeds", () => {
    for (let seed = 10; seed < 20; seed++) {
      const bots = Array.from({ length: 4 }, (_, i) => bot(i, true));
      const { killedAt } = fight(bots, seed);
      expect(killedAt, `seed ${seed}`).not.toBeNull();
      expect(bots.filter((b) => !b.alive), `seed ${seed}`).toHaveLength(0);
    }
  });
});
