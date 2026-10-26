/**
 * The whole raid, headless: parties of scripted herzies — Bards, Percussion-
 * ists and Record Slingers using their skills, dodging, and listening to
 * what the boss hates — through the real fight runtime, from the lock to
 * the end. Tuning that makes the raid unwinnable, trivial, or too long fails
 * here rather than in a playtest.
 *
 * The bots' stats are a level-30 herzie's with sensible gear and stat
 * points; their damage lands near what real herzies dealt before the raid
 * (about 250-340 a second each), which BOSS_HP_PER_PLAYER is sized from.
 */
import { BOSS_WANDER, bossMaxHp } from "@herzies/shared/boss-fight";
import {
  CAST_INTERVAL_MS,
  DISC_RANGE,
  MELEE_REACH,
  WAVE_HAND_HEIGHT,
} from "@herzies/shared/combat";
import { SKILL_DEFS } from "@herzies/shared/skills";
import { MOB } from "@herzies/shared/tower";
import { STAT_TUNING } from "@herzies/shared/stats";
import type { BossClaim, TownTicketPayload } from "@herzies/shared/town-net";
import { TOWN_WALK_SPEED } from "@herzies/shared/town-net";
import { maxHp as maxHpOf } from "@herzies/shared/vitals";
import { armed } from "./arms";
import { describe, expect, it } from "vitest";
import { type BossEngine, covers, type Telegraph, TUNING } from "../src/boss";
import { FightRuntime } from "../src/fight";

const STEP = 50;
const REACTION_MS = 450;
const T0 = 10_000_000;
const STARTS = T0 + 1_000;
const LEVEL = 30;
/** Print each fight's numbers, for tuning: flip on while tuning (the
 * Workers test runtime has no environment to switch it from). */
const LOG = true;

type Role = "bard" | "percussionist" | "record_slinger" | "none";

type Bot = {
  uid: string;
  role: Role;
  x: number;
  z: number;
  dodges: boolean;
  tuned: boolean;
  /** How long it takes to notice a shape on the floor. */
  reaction: number;
  seen: Map<number, number>;
  nextCast: number;
  /** A resurrect being played: stand still until then. */
  channelUntil: number;
  /** Whether it has told the room its music is on. */
  tunedTo: boolean;
};

/** A level-30 herzie's stats for its class: gear (an instrument), 58 stat
 * points, and the level's own Def. */
function statsFor(role: Role): {
  st: [number, number, number, number, number, number, number];
  stamina: number;
} {
  const levelDef = LEVEL * 0.6;
  switch (role) {
    case "record_slinger":
      // Discs (SP 8, crit 5, crit dmg 25); points into Sonic Power.
      return { st: [8 + 50, 0, 5, 25, 8, levelDef, 0], stamina: 8 };
    case "bard":
      // Lute (Euphony 12, SP 3); points split Euphony and Sonic Power.
      return { st: [3 + 28, 0, 0, 0, 0, levelDef, 12 + 30], stamina: 0 };
    case "percussionist": {
      // Stick (SP 4) and cymbal (Def 10); points mostly Stamina.
      const stamina = 40;
      return {
        st: [4 + 18, 0, 0, 0, stamina, 10 + levelDef + stamina * STAT_TUNING.defPerStamina, 0],
        stamina,
      };
    }
    default:
      return { st: [20, 0, 0, 0, 0, levelDef, 0], stamina: 0 };
  }
}

function skillsFor(role: Role): [string, number][] {
  if (role === "bard") return [["soothing-drones", 5], ["resurrect", 5]];
  if (role === "percussionist") return [["cymbrella", 5], ["taunt", 5]];
  if (role === "record_slinger") return [["backspin", 5]];
  return [];
}

function ticketFor(b: Bot): TownTicketPayload {
  const { st, stamina } = statsFor(b.role);
  const max = maxHpOf(LEVEL, stamina);
  return armed({
    uid: b.uid,
    name: b.uid,
    look: { seed: b.uid, stage: 3 },
    exp: 9e9,
    hp: { hp: max, maxHp: max, down: false },
    st,
    lv: LEVEL,
    ...(b.role !== "none" ? { cls: b.role, sk: skillsFor(b.role) } : {}),
  });
}

function party(
  roles: Role[],
  opts: { dodges?: boolean; tuned?: boolean; reaction?: number } = {},
): Bot[] {
  return roles.map((role, i) => {
    const angle = (i / Math.max(1, roles.length)) * Math.PI * 2;
    return {
      uid: `${role}-${i}`,
      role,
      x: Math.sin(angle) * 7,
      z: 4 + Math.cos(angle) * 4,
      dodges: opts.dodges ?? true,
      tuned: opts.tuned ?? true,
      reaction: opts.reaction ?? REACTION_MS,
      seen: new Map(),
      nextCast: 0,
      channelUntil: 0,
      tunedTo: false,
    };
  });
}

/** The nearest spot clear of every shape (with a margin), on a half-unit
 * grid; null if standing here is fine. */
function safeSpot(
  tgs: readonly Telegraph[],
  x: number,
  z: number,
): { x: number; z: number } | null {
  const MARGIN = 0.6;
  const clear = (px: number, pz: number) =>
    tgs.every(
      (tg) =>
        tg.kind === "buster" ||
        tg.lethal ||
        !covers({ ...tg, r: tg.r + MARGIN, inner: Math.max(0, tg.inner - MARGIN) }, px, pz),
    );
  if (clear(x, z)) return null;
  let best: { x: number; z: number } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  const R = TUNING.roomRadius - 0.5;
  for (let gx = -R; gx <= R; gx += 0.5) {
    for (let gz = -R; gz <= R; gz += 0.5) {
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

function stepToward(b: Bot, to: { x: number; z: number }, stop = 0) {
  const dx = to.x - b.x;
  const dz = to.z - b.z;
  const d = Math.hypot(dx, dz);
  if (d <= stop + 1e-3) return;
  const step = Math.min(d - stop, (TOWN_WALK_SPEED * STEP) / 1000);
  b.x += (dx / d) * step;
  b.z += (dz / d) * step;
  const r = Math.hypot(b.x, b.z);
  if (r > TUNING.roomRadius - 0.3) {
    b.x *= (TUNING.roomRadius - 0.3) / r;
    b.z *= (TUNING.roomRadius - 0.3) / r;
  }
}

type Result = {
  outcome: "victory" | "escaped" | "wiped" | null;
  /** Ms from the lock to the end. */
  ms: number;
  maxHp: number;
  downs: number;
  revives: number;
  /** The furthest the boss got from the middle of its circle. */
  wander: number;
  /** Its minions that fell. */
  minions: number;
};

function raid(bots: Bot[], seed: number, limitMs = 17 * 60_000): Result {
  const claim: BossClaim = {
    event: "sim",
    until: (T0 + 3_600_000) / 1000,
    hp: 1,
    maxHp: 1,
    starts: STARTS / 1000,
  };
  const f = new FightRuntime(claim, T0, seed);
  bots.forEach((b, i) => f.join(b.uid, i + 1, ticketFor(b), b, T0));
  const boss = f.engine as BossEngine;
  let downs = 0;
  let revives = 0;
  let hitsTaken = 0;
  let wander = 0;
  let minionsDown = 0;
  let minHp = 1;
  let shapes = 0;
  let lanes = 0;
  let t = T0;
  while (t - STARTS < limitMs && !f.closeWhy) {
    t += STEP;
    const at = boss.position;
    const standing = bots.filter((b) => !f.player(b.uid)?.down);
    const centre = standing.length
      ? {
          x: standing.reduce((n, b) => n + b.x, 0) / standing.length,
          z: standing.reduce((n, b) => n + b.z, 0) / standing.length,
        }
      : { x: 0, z: 6 };
    for (const b of bots) {
      const me = f.player(b.uid);
      if (me) minHp = Math.min(minHp, me.hp / me.maxHp);
      if (!me || me.down) continue;
      if (b.tuned && !b.tunedTo) {
        f.tune(b.uid, true, t);
        b.tunedTo = true;
      }
      const channeling = t < b.channelUntil;
      const noticed = boss.active.filter((tg) => {
        if (!b.seen.has(tg.id)) b.seen.set(tg.id, t);
        return t - (b.seen.get(tg.id) as number) >= b.reaction;
      });
      // A scatter mark, as a bot reads it: the marked herzie moves clear of
      // everyone; everyone else moves clear of the marked.
      const shapesSeen = noticed.flatMap((tg): Telegraph[] => {
        if (tg.kind !== "scatter") return [tg];
        if (tg.target === b.uid)
          return bots
            .filter((o) => o !== b && !f.player(o.uid)?.down)
            .map((o) => ({ ...tg, kind: "circle", x: o.x, z: o.z }));
        const marked = bots.find((o) => o.uid === tg.target);
        return marked ? [{ ...tg, kind: "circle", x: marked.x, z: marked.z }] : [];
      });
      const escape = b.dodges && !channeling ? safeSpot(shapesSeen, b.x, b.z) : null;
      const toBoss = Math.hypot(at.x - b.x, at.z - b.z);
      if (escape) stepToward(b, escape);
      else if (!channeling && b.dodges) {
        if (b.role === "bard") {
          // A downed ally to bring back, if the raid has a revive.
          const fallen = bots.find((o) => f.player(o.uid)?.down);
          const ready = (me.ready.get("resurrect") ?? 0) <= t;
          if (fallen && ready) stepToward(b, fallen, 2.5);
          else stepToward(b, { x: centre.x, z: Math.max(centre.z, at.z + 8) }, 3);
        } else if (b.role === "percussionist") {
          stepToward(b, at, TUNING.boss.radius + MELEE_REACH * 0.6);
        } else if (b.role === "record_slinger") {
          if (toBoss > DISC_RANGE - 6) stepToward(b, at, DISC_RANGE - 8);
          else if (toBoss < 7)
            stepToward(b, { x: b.x + (b.x - at.x), z: b.z + (b.z - at.z) });
        } else {
          stepToward(b, at, 1.5 + TUNING.boss.radius);
        }
      }
      f.onState(b.uid, b.x, b.z, t);

      // Skills first.
      if (b.role === "bard") {
        const fallen = bots.find((o) => {
          const p = f.player(o.uid);
          return p?.down && Math.hypot(o.x - b.x, o.z - b.z) <= (SKILL_DEFS.resurrect.radius ?? 0);
        });
        if (fallen && !channeling) {
          const r = f.skill(b.uid, "resurrect", 0, 0, t);
          if (r.result === "used") b.channelUntil = t + (SKILL_DEFS.resurrect.channelMs ?? 0) + STEP;
        }
        const hurt = bots.some((o) => {
          const p = f.player(o.uid);
          return (
            p &&
            !p.down &&
            p.hp / p.maxHp < 0.7 &&
            Math.hypot(o.x - b.x, o.z - b.z) <= (SKILL_DEFS["soothing-drones"].radius ?? 0)
          );
        });
        if (hurt && !channeling) f.skill(b.uid, "soothing-drones", 0, 0, t);
      } else if (b.role === "percussionist") {
        f.skill(b.uid, "taunt", 0, 0, t);
        const aimedAtMe = boss.active.some((tg) => tg.target === b.uid || tg.aimedAt === b.uid);
        if (aimedAtMe) f.skill(b.uid, "cymbrella", 0, 0, t);
      }
      if (channeling) continue;
      if (t >= b.nextCast) {
        b.nextCast = t + CAST_INTERVAL_MS;
        // Adds first, for everyone but the tank: the nearest Thornling.
        let aim: { x: number; z: number; chest: number } = {
          x: at.x,
          z: at.z,
          chest: TUNING.boss.chest,
        };
        if (b.role !== "percussionist") {
          let best = Number.POSITIVE_INFINITY;
          for (const m of boss.wireMobs()) {
            const d = Math.hypot(m.x - b.x, m.z - b.z);
            if (d < best && d < (b.role === "record_slinger" ? DISC_RANGE : 40)) {
              best = d;
              aim = { x: m.x, z: m.z, chest: MOB.chest };
            }
          }
        }
        const dx = aim.x - b.x;
        const dz = aim.z - b.z;
        const yaw = Math.atan2(dx, dz);
        const pitch = Math.atan2(aim.chest - WAVE_HAND_HEIGHT, Math.hypot(dx, dz));
        if (b.role === "record_slinger") f.skill(b.uid, "backspin", yaw, pitch, t);
        f.cast(b.uid, yaw, pitch, t);
      }
    }
    {
      const at = boss.position;
      wander = Math.max(
        wander,
        Math.hypot(at.x - BOSS_WANDER.x, at.z - BOSS_WANDER.z),
      );
    }
    for (const o of f.step(t)) {
      if (o.msg.t === "resolve") hitsTaken += o.msg.hits.length;
      if (o.msg.t === "mobDown") minionsDown++;
      if (o.msg.t === "telegraph") {
        shapes++;
        if (o.msg.kind === "lane") lanes++;
      }
      if (o.msg.t === "down") downs++;
      if (o.msg.t === "revived") revives++;
    }
  }
  if (LOG)
    console.log(
    `SIM ${bots.map((b) => b.role[0]).join("")} seed=${seed} -> ${f.closeWhy} in ${min(t - STARTS)} min, maxHp=${f.engine.maxHp}, hp left=${Math.round(f.engine.hp)}, downs=${downs}, revives=${revives}, minions=${minionsDown}, hits=${hitsTaken}, shapes=${shapes}, charges=${lanes}, minHp=${Math.round(minHp * 100)}%`,
  );
  return {
    outcome: f.closeWhy,
    ms: t - STARTS,
    maxHp: f.engine.maxHp,
    downs,
    revives,
    wander,
    minions: minionsDown,
  };
}

const TRIO: Role[] = ["bard", "percussionist", "record_slinger"];
const min = (ms: number) => Math.round((ms / 60_000) * 10) / 10;

describe("the raid, simulated", () => {
  it("a trio of the three classes wins in six to eight minutes, give or take", () => {
    const r = raid(party(TRIO), 1);
    expect(r.outcome, `after ${min(r.ms)} min`).toBe("victory");
    expect(r.maxHp).toBe(bossMaxHp(3));
    // Both packs called (at half and a quarter), and dealt with.
    expect(r.minions).toBeGreaterThanOrEqual(4);
    expect(r.ms).toBeGreaterThan(4 * 60_000);
    expect(r.ms).toBeLessThan(10 * 60_000);
  });

  it("six and twelve win in about the same time: health scales with the roster", () => {
    const six = raid(party([...TRIO, ...TRIO]), 2);
    const twelve = raid(party([...TRIO, ...TRIO, ...TRIO, ...TRIO]), 3);
    for (const r of [six, twelve]) {
      expect(r.outcome, `after ${min(r.ms)} min`).toBe("victory");
      expect(r.ms).toBeGreaterThan(3.5 * 60_000);
      expect(r.ms).toBeLessThan(10 * 60_000);
    }
    // A bigger group has a slight edge, never a slower fight.
    expect(twelve.ms).toBeLessThan(six.ms * 1.15);
  });

  it("twenty and forty win too, with more on the floor and the scatter marks", () => {
    const big = (n: number) =>
      party(Array.from({ length: n }, (_, i) => TRIO[i % 3]));
    const twenty = raid(big(20), 4);
    const forty = raid(big(40), 5);
    for (const r of [twenty, forty]) {
      expect(r.outcome, `after ${min(r.ms)} min`).toBe("victory");
      expect(r.ms).toBeGreaterThan(3.5 * 60_000);
      expect(r.ms).toBeLessThan(10 * 60_000);
    }
  }, 60_000);

  it("a lone Record Slinger can win, before the enrage ends it", () => {
    const r = raid(party(["record_slinger"]), 4);
    expect(r.outcome, `after ${min(r.ms)} min`).toBe("victory");
    expect(r.ms).toBeLessThan(15 * 60_000);
  });

  it("listening to what the boss hates makes the fight shorter", () => {
    const tuned = raid(party(TRIO, { tuned: true }), 5);
    const deaf = raid(party(TRIO, { tuned: false }), 5);
    expect(tuned.outcome).toBe("victory");
    expect(tuned.ms).toBeLessThan(deaf.ms);
  });

  it("a slow-to-react party takes hits, and its Bards bring the fallen back", () => {
    // Slower than a roaming boss gives (it rarely parks long enough to
    // catch the sluggish at 1.25 s); retuned with heal mode in the sim.
    const r = raid(party(TRIO, { reaction: 1_600 }), 8);
    expect(r.downs).toBeGreaterThan(0);
    expect(r.revives).toBeGreaterThan(0);
  });

  it("a party that never moves is beaten: dodging matters", () => {
    const r = raid(party(["none", "none", "none"], { dodges: false }), 6);
    expect(r.outcome).toBe("wiped");
  });

  it("the enrage ends a fight that runs too long", () => {
    // Three classless bumpers, dodging but dealing next to nothing.
    const bots = party(["none", "none", "none"]);
    const r = raid(bots, 7, 20 * 60_000);
    expect(r.outcome).toBe("wiped");
    expect(r.ms).toBeGreaterThan(14 * 60_000);
    expect(r.ms).toBeLessThan(16 * 60_000);
  });

  it("the trio wins across seeds", () => {
    const times: number[] = [];
    for (let seed = 10; seed < 18; seed++) {
      const r = raid(party(TRIO), seed);
      expect(r.outcome, `seed ${seed}, ${min(r.ms)} min`).toBe("victory");
      times.push(r.ms);
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    expect(mean).toBeGreaterThan(5 * 60_000);
    expect(mean).toBeLessThan(9 * 60_000);
  });

  it("the boss walks, but never out of its circle", () => {
    for (const roles of [TRIO, ["record_slinger" as Role], [...TRIO, ...TRIO]]) {
      const r = raid(party(roles), 20, 4 * 60_000);
      expect(r.wander).toBeGreaterThan(0.5);
      expect(r.wander).toBeLessThanOrEqual(BOSS_WANDER.radius + 1e-6);
    }
  });;
});

