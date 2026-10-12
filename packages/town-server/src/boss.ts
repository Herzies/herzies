/**
 * The boss in the cave: what it does, and what hits it. Pure and
 * deterministic (a seeded RNG and an injected clock), so the whole fight is
 * unit-tested and simulated headlessly; `room.ts` only feeds it players and
 * relays what it says.
 *
 * Fairness rules every attack here follows (see the plan's research notes):
 * every attack is telegraphed on the floor for at least {@link MIN_WINDUP_MS}
 * before it lands; no single hit takes more than {@link MAX_HIT_FRACTION} of
 * a herzie's health; a herzie that was just hit, just arrived or just got
 * back up can't be hit again straight away; at most {@link MAX_TELEGRAPHS}
 * shapes are on the floor at once; and a hit is judged against where the
 * player stood a moment ago as well as where they are now.
 */
import {
  aimDirection,
  BOSS_STAND,
  type HitStats,
  hitDamage,
  WAVE_HAND_HEIGHT,
  WAVE_SPEED,
  waveReaches,
} from "@herzies/shared/combat";

// ---------------------------------------------------------------------------
// Tuning: every balance number lives here.

export const TUNING = {
  /** Where the boss stands (the room's centre-back) and how big it is. */
  boss: BOSS_STAND,
  /** Walkable radius of the room. */
  roomRadius: 13,
  /** A telegraph is never shorter than this. */
  minWindupMs: 1_000,
  /** Most shapes on the floor at once. */
  maxTelegraphs: 4,
  /** After being hit, hit again no sooner than this. */
  invulnMs: 600,
  /** After joining or getting back up, safe from new telegraphs this long. */
  spawnSafeMs: 2_000,
  /** A hit is judged at this long before it lands too; defender's benefit. */
  rewindMs: 120,
  /** A player may cast about this often; a short burst is allowed so network
   * jitter never costs a real cast (the client casts every 340 ms). */
  castEveryMs: 300,
  castBurst: 2,
  /** Pause before the first attack of a fight, and after resuming. */
  openingMs: 3_000,
  phases: {
    1: { fromHp: 1, everyMs: 3_200, slams: 2, ringChance: 0 },
    2: { fromHp: 0.66, everyMs: 2_700, slams: 3, ringChance: 0.35 },
    3: { fromHp: 0.33, everyMs: 2_000, slams: 4, ringChance: 0.4 },
  },
  slam: { radius: 3, windupMs: 1_600, fraction: 0.2 },
  ring: { inner: 6.5, windupMs: 3_000, fraction: 0.25 },
} as const;

/** The most of a herzie's health one hit may take. */
export const MAX_HIT_FRACTION = 0.3;
export const MIN_WINDUP_MS = TUNING.minWindupMs;
export const MAX_TELEGRAPHS = TUNING.maxTelegraphs;

export type Phase = 1 | 2 | 3;
export type TelegraphKind = "circle" | "ring";

export type Telegraph = {
  id: number;
  kind: TelegraphKind;
  x: number;
  z: number;
  /** Outer radius. */
  r: number;
  /** Inner (safe) radius of a ring; 0 for a circle. */
  inner: number;
  /** When it appeared and when it lands (server ms). */
  at: number;
  hitAt: number;
  /** Fraction of the target's max HP it takes. */
  fraction: number;
};

/** A player as the engine sees them each update. */
export type BossPlayer = {
  uid: string;
  alive: boolean;
  maxHp: number;
  /** Where they stood at `t` (server ms), or null if unknown. */
  posAt: (t: number) => { x: number; z: number } | null;
};

export type BossEvent =
  | { t: "telegraph"; telegraph: Telegraph }
  | { t: "resolve"; id: number; hits: { uid: string; damage: number }[] }
  | { t: "phase"; phase: Phase }
  | {
      t: "hit";
      uid: string;
      damage: number;
      crit: boolean;
      hp: number;
    }
  | { t: "killed"; by: string };

/** Where a seeded sequence starts: mulberry32. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function phaseFor(hp: number, maxHp: number): Phase {
  const f = maxHp > 0 ? hp / maxHp : 0;
  if (f <= TUNING.phases[3].fromHp) return 3;
  if (f <= TUNING.phases[2].fromHp) return 2;
  return 1;
}

type PendingHit = {
  at: number;
  uid: string;
  damage: number;
  crit: boolean;
};

export class BossEngine {
  hp: number;
  readonly maxHp: number;
  private phase: Phase;
  private nextAttackAt: number;
  private nextId = 1;
  private telegraphs: Telegraph[] = [];
  private pending: PendingHit[] = [];
  /** Cast tokens per player: refill one per `castEveryMs`, up to the burst. */
  private casts = new Map<string, { tokens: number; at: number }>();
  private invulnUntil = new Map<string, number>();
  private safeUntil = new Map<string, number>();
  private killed = false;
  private readonly rand: () => number;

  constructor(opts: { hp: number; maxHp: number; seed: number; now: number }) {
    this.maxHp = Math.max(1, opts.maxHp);
    this.hp = Math.max(0, Math.min(this.maxHp, opts.hp));
    this.rand = rng(opts.seed);
    this.phase = phaseFor(this.hp, this.maxHp);
    this.nextAttackAt = opts.now + TUNING.openingMs;
    this.killed = this.hp <= 0;
  }

  get dead(): boolean {
    return this.killed;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  /** What's on the floor, for a newcomer's welcome. */
  get active(): readonly Telegraph[] {
    return this.telegraphs;
  }

  /** Someone arrived or got back up: no telegraph targets or lands on them
   * for a moment. */
  noteSpawn(uid: string, now: number): void {
    this.safeUntil.set(uid, now + TUNING.spawnSafeMs);
  }

  forget(uid: string): void {
    this.casts.delete(uid);
    this.invulnUntil.delete(uid);
    this.safeUntil.delete(uid);
  }

  /**
   * A cast from `uid`, standing at (x, z), aiming (yaw, pitch). Accepted
   * casts that line up with the boss (with the same aim assist the client
   * draws) land after the wave's flight time. Returns whether it counted as
   * a cast (for rate limiting); a miss still uses the cooldown.
   */
  cast(
    uid: string,
    from: { x: number; z: number },
    yaw: number,
    pitch: number,
    stats: HitStats,
    now: number,
  ): "cooldown" | "miss" | "hit" | "dead" {
    if (this.killed) return "dead";
    const bucket = this.casts.get(uid) ?? {
      tokens: TUNING.castBurst,
      at: now,
    };
    bucket.tokens = Math.min(
      TUNING.castBurst,
      bucket.tokens + Math.max(0, now - bucket.at) / TUNING.castEveryMs,
    );
    bucket.at = now;
    this.casts.set(uid, bucket);
    if (bucket.tokens < 1) return "cooldown";
    bucket.tokens -= 1;
    const dir = aimDirection(yaw, pitch);
    const dist = waveReaches([from.x, WAVE_HAND_HEIGHT, from.z], dir, {
      x: TUNING.boss.x,
      y: TUNING.boss.chest,
      z: TUNING.boss.z,
      radius: TUNING.boss.radius,
    });
    if (dist === null) return "miss";
    const { amount, crit } = hitDamage(stats, this.rand);
    this.pending.push({
      at: now + (dist / WAVE_SPEED) * 1000,
      uid,
      damage: amount,
      crit,
    });
    return "hit";
  }

  /** Advance to `now`: land waves in flight, resolve attacks, start new
   * ones. Events come out in order. */
  update(now: number, players: readonly BossPlayer[]): BossEvent[] {
    const events: BossEvent[] = [];
    this.landWaves(now, events);
    if (this.killed) {
      this.telegraphs = [];
      return events;
    }
    this.resolveDue(now, players, events);
    this.startAttacks(now, players, events);
    return events;
  }

  private landWaves(now: number, events: BossEvent[]) {
    if (!this.pending.length) return;
    this.pending.sort((a, b) => a.at - b.at);
    while (this.pending.length && this.pending[0].at <= now) {
      const p = this.pending.shift() as PendingHit;
      if (this.killed) continue;
      this.hp = Math.max(0, this.hp - p.damage);
      events.push({
        t: "hit",
        uid: p.uid,
        damage: p.damage,
        crit: p.crit,
        hp: this.hp,
      });
      const phase = phaseFor(this.hp, this.maxHp);
      if (phase !== this.phase) {
        this.phase = phase;
        // A breather as the fight changes gear.
        this.nextAttackAt = Math.max(this.nextAttackAt, now + 1_500);
        events.push({ t: "phase", phase });
      }
      if (this.hp <= 0) {
        this.killed = true;
        this.pending = [];
        events.push({ t: "killed", by: p.uid });
      }
    }
  }

  private resolveDue(
    now: number,
    players: readonly BossPlayer[],
    events: BossEvent[],
  ) {
    const due = this.telegraphs.filter((t) => t.hitAt <= now);
    if (!due.length) return;
    this.telegraphs = this.telegraphs.filter((t) => t.hitAt > now);
    for (const tg of due) {
      const hits: { uid: string; damage: number }[] = [];
      for (const p of players) {
        if (!p.alive) continue;
        if ((this.safeUntil.get(p.uid) ?? 0) > tg.hitAt) continue;
        if ((this.invulnUntil.get(p.uid) ?? 0) > tg.hitAt) continue;
        // Defender's benefit: in the zone now AND a moment before.
        const inside = [tg.hitAt, tg.hitAt - TUNING.rewindMs].every((t) => {
          const pos = p.posAt(t);
          return !!pos && covers(tg, pos.x, pos.z);
        });
        if (!inside) continue;
        const damage = Math.max(
          1,
          Math.round(Math.min(tg.fraction, MAX_HIT_FRACTION) * p.maxHp),
        );
        hits.push({ uid: p.uid, damage });
        this.invulnUntil.set(p.uid, tg.hitAt + TUNING.invulnMs);
      }
      events.push({ t: "resolve", id: tg.id, hits });
    }
  }

  private startAttacks(
    now: number,
    players: readonly BossPlayer[],
    events: BossEvent[],
  ) {
    if (now < this.nextAttackAt) return;
    const cfg = TUNING.phases[this.phase];
    const targets = players.filter(
      (p) => p.alive && (this.safeUntil.get(p.uid) ?? 0) <= now,
    );
    if (!targets.length) {
      // Nobody to aim at: check again soon, without burning the cadence.
      this.nextAttackAt = now + 500;
      return;
    }
    this.nextAttackAt = now + cfg.everyMs;
    const add = (tg: Omit<Telegraph, "id" | "at">) => {
      if (this.telegraphs.length >= MAX_TELEGRAPHS) return;
      const telegraph: Telegraph = { ...tg, id: this.nextId++, at: now };
      this.telegraphs.push(telegraph);
      events.push({ t: "telegraph", telegraph });
    };
    if (this.rand() < cfg.ringChance) {
      add({
        kind: "ring",
        x: TUNING.boss.x,
        z: TUNING.boss.z,
        r: TUNING.roomRadius + 2,
        inner: TUNING.ring.inner,
        hitAt: now + TUNING.ring.windupMs,
        fraction: TUNING.ring.fraction,
      });
      return;
    }
    // Slams on random players, at most `slams`, never more than there are.
    const pool = [...targets];
    const n = Math.min(cfg.slams, Math.max(1, Math.ceil(pool.length / 2)));
    for (let i = 0; i < n && pool.length; i++) {
      const [p] = pool.splice(Math.floor(this.rand() * pool.length), 1);
      const pos = p.posAt(now);
      if (!pos) continue;
      add({
        kind: "circle",
        x: pos.x,
        z: pos.z,
        r: TUNING.slam.radius,
        inner: 0,
        hitAt: now + TUNING.slam.windupMs,
        fraction: TUNING.slam.fraction,
      });
    }
  }
}

/** Whether a telegraph covers a point. */
export function covers(tg: Telegraph, x: number, z: number): boolean {
  const d = Math.hypot(x - tg.x, z - tg.z);
  return d <= tg.r && d >= tg.inner;
}
