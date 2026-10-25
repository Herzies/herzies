import { TOWN_SPRINT_SPEED, TOWN_WALK_SPEED } from "@herzies/shared/town-net";
import { attackTokens, FLOOR_OPENING_MS } from "@herzies/shared/tower";
import { TOWN_MAPS } from "@herzies/shared/town-net";
import { describe, expect, it } from "vitest";
import { type BossPlayer, covers } from "../src/boss";
import { TowerEngine, type TowerEvent } from "../src/tower";

// Scripted players against the Tower's mobs: the floors have to threaten
// someone who stands still and someone who runs, and still be beatable by
// someone who watches the ground and steps out of it.

const T0 = 9_000_000;
const STEP = 50;
const ARENA = {
  radius: TOWN_MAPS.tower.radius,
  entry: TOWN_MAPS.tower.spawn,
};
const STATS = { sonicPower: 0, critChance: 0, critDamage: 0 };

/** A player whose path is written as it goes, so posAt can look back. */
class Bot {
  trail: { t: number; x: number; z: number }[] = [];
  hits = 0;
  taken = 0;
  constructor(
    public x: number,
    public z: number,
  ) {}
  note(t: number) {
    this.trail.push({ t, x: this.x, z: this.z });
    if (this.trail.length > 400) this.trail.shift();
  }
  posAt = (t: number) => {
    const tr = this.trail;
    if (!tr.length) return { x: this.x, z: this.z };
    for (let i = tr.length - 1; i > 0; i--) {
      const a = tr[i - 1];
      const b = tr[i];
      if (a.t <= t && t <= b.t) {
        const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
        return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return t < tr[0].t ? tr[0] : tr[tr.length - 1];
  };
  player(): BossPlayer {
    return { uid: "u", alive: true, maxHp: 1e9, posAt: this.posAt };
  }
  /** Tally what landed on it. */
  take(ev: TowerEvent[]) {
    for (const e of ev)
      if (e.t === "resolve")
        for (const h of e.hits) {
          this.hits++;
          this.taken += h.damage;
        }
  }
  /** Walk `speed` toward (dx, dz) for one step, staying on the island. */
  go(dx: number, dz: number, speed: number) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    this.x += (dx / len) * speed * (STEP / 1000);
    this.z += (dz / len) * speed * (STEP / 1000);
    const r = ARENA.radius - 1.5;
    const out = Math.hypot(this.x, this.z);
    if (out > r) {
      this.x *= r / out;
      this.z *= r / out;
    }
  }
}

function engine(floor: number, level = floor, seed = 11) {
  return new TowerEngine({ floor, level, seed, now: T0 }, ARENA);
}

/** Cast at the nearest mob. */
function shoot(e: TowerEngine, b: Bot, t: number) {
  let best: { x: number; z: number } | null = null;
  let bd = Number.POSITIVE_INFINITY;
  for (const m of e.wireMobs()) {
    const d = Math.hypot(m.x - b.x, m.z - b.z);
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  if (!best) return;
  e.cast("u", b, Math.atan2(best.x - b.x, best.z - b.z), 0, STATS, t);
}

describe("the Tower's mobs, against scripted players", () => {
  it("gets to someone standing still soon after waking", () => {
    for (const seed of [1, 2, 3]) {
      const e = engine(1, 1, seed);
      const b = new Bot(ARENA.entry.x, ARENA.entry.z);
      let firstHit = Number.POSITIVE_INFINITY;
      for (let t = T0; t < T0 + 15_000 && firstHit === Infinity; t += STEP) {
        b.note(t);
        const ev = e.update(t, [b.player()]);
        b.take(ev);
        if (b.hits > 0) firstHit = t;
      }
      expect(firstHit - (T0 + FLOOR_OPENING_MS)).toBeLessThan(6_000);
    }
  });

  for (const [name, speed] of [
    ["walking", TOWN_WALK_SPEED],
    ["sprinting", TOWN_SPRINT_SPEED],
  ] as const) {
    it(`still lands on someone ${name} in circles (floor 6+)`, () => {
      for (const floor of [6, 12]) {
        const e = engine(floor);
        const b = new Bot(0, 9);
        let a = 0;
        const end = T0 + FLOOR_OPENING_MS + 30_000;
        for (let t = T0; t < end; t += STEP) {
          a += (speed * (STEP / 1000)) / 9;
          b.x = Math.sin(a) * 9;
          b.z = Math.cos(a) * 9;
          b.note(t);
          b.take(e.update(t, [b.player()]));
        }
        // At least one hit every 10 seconds of running.
        expect(b.hits).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("never has more mobs attacking at once than the floor's tokens", () => {
    for (const floor of [3, 9, 15, 25, 40]) {
      const e = engine(floor);
      const b = new Bot(ARENA.entry.x, ARENA.entry.z);
      const winding = new Map<number, number>();
      for (let t = T0; t < T0 + 25_000; t += STEP) {
        b.note(t);
        const ev = e.update(t, [b.player()]);
        for (const x of ev)
          if (x.t === "telegraph" && x.telegraph.mob !== undefined)
            winding.set(x.telegraph.mob, x.telegraph.hitAt);
        const swinging = [...winding.values()].filter((h) => h > t).length;
        expect(swinging).toBeLessThanOrEqual(attackTokens(floor));
      }
    }
  });

  it("can be climbed by someone who steps out of every shape", () => {
    const REACT_MS = 250;
    let e = engine(1, 5, 7);
    const b = new Bot(ARENA.entry.x, ARENA.entry.z);
    let t = T0;
    let cleared = 0;
    const seen = new Map<number, number>();
    while (cleared < 5 && t < T0 + 8 * 60_000) {
      b.note(t);
      const ev = e.update(t, [b.player()]);
      b.take(ev);
      for (const x of ev) if (x.t === "telegraph") seen.set(x.telegraph.id, t);
      if (e.isCleared) {
        cleared++;
        e.next(t);
        continue;
      }
      // Out of whatever shape it's noticed it's in: away from its middle
      // (inward, for a ring, when that's nearer).
      let dx = 0;
      let dz = 0;
      for (const tg of e.active) {
        if (t - (seen.get(tg.id) ?? t) < REACT_MS) continue;
        const grown = { ...tg, r: tg.r + 0.6, inner: Math.max(0, tg.inner - 0.6) };
        if (!covers(grown, b.x, b.z)) continue;
        const ax = b.x - tg.x;
        const az = b.z - tg.z;
        const d = Math.hypot(ax, az) || 1;
        const inward = tg.kind === "ring" && d - tg.inner < tg.r - d;
        dx += ((inward ? -ax : ax) / d) * 2;
        dz += ((inward ? -az : az) / d) * 2;
      }
      if (dx || dz) b.go(dx, dz, TOWN_WALK_SPEED);
      else {
        // Otherwise keep a little room from the nearest mob, and fire.
        const near = e
          .wireMobs()
          .map((m) => ({ m, d: Math.hypot(m.x - b.x, m.z - b.z) }))
          .sort((p, q) => p.d - q.d)[0];
        if (near && near.d < 3.5)
          b.go(b.x - near.m.x, b.z - near.m.z, TOWN_WALK_SPEED);
        if ((t - T0) % 500 === 0) shoot(e, b, t);
      }
      t += STEP;
    }
    expect(cleared).toBe(5);
    // A careful player gets through the first floors with only a few
    // scrapes; standing still takes far more.
    expect(b.hits).toBeLessThanOrEqual(6);
  });

  it("enrages a floor left too long", () => {
    const e = engine(4);
    const b = new Bot(ARENA.entry.x, ARENA.entry.z);
    expect(e.view().enrageIn).toBeGreaterThan(0);
    const late = T0 + FLOOR_OPENING_MS + 10 * 60_000;
    for (let t = T0; t <= late; t += 1_000) {
      b.note(t);
      e.update(t, []);
    }
    expect(e.enragedAt(late)).toBe(true);
    expect(e.view().enrageIn).toBe(0);
  });

  it("brings an elite every fifth floor and the Warden every tenth", () => {
    expect(engine(5).wireMobs().filter((m) => m.e === 1)).toHaveLength(1);
    expect(engine(10).wireMobs().filter((m) => m.e === 2)).toHaveLength(1);
    expect(engine(10).wireMobs().filter((m) => m.e === 1)).toHaveLength(0);
    expect(engine(7).wireMobs().filter((m) => m.e)).toHaveLength(0);
  });
});
