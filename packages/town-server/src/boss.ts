/**
 * The boss in the cave: what it does, and what hits it. Pure and
 * deterministic (a seeded RNG and an injected clock), so the whole fight is
 * unit-tested and simulated headlessly; `room.ts` only feeds it players and
 * relays what it says.
 *
 * Fairness rules every attack here follows (see the plan's research notes):
 * every attack is telegraphed on the floor for at least {@link MIN_WINDUP_MS}
 * before it lands; a hit deals flat damage, so health and Def matter, but
 * never more than {@link MAX_HIT_FRACTION} of a herzie's health; a herzie that was just hit, just arrived or just got
 * back up can't be hit again straight away; at most {@link MAX_TELEGRAPHS}
 * shapes are on the floor at once; and a hit is judged against where the
 * player stood a moment ago as well as where they are now.
 */

import type { AttackStyle } from "@herzies/shared/classes";
import {
  aimDirection,
  BOSS_STAND,
  bossReaches,
  CAST_INTERVAL_MS,
  DISC_DAMAGE,
  DISC_RANGE,
  discLandsAfterMs,
  type HitStats,
  hitDamage,
  MELEE_DAMAGE,
  MELEE_REACH,
  meleeReaches,
  WAVE_HAND_HEIGHT,
  WAVE_SPEED,
} from "@herzies/shared/combat";
import {
  activeBuffs,
  applyBuff,
  BACKSPIN_DISCS,
  BACKSPIN_SPREAD,
  type Buff,
  mitigate,
} from "@herzies/shared/skills";
import { defReduction } from "@herzies/shared/stats";

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
  /** A player may cast about this often: a little under the client's pace,
   * with a short burst, so network jitter never costs a real cast. */
  castEveryMs: Math.round(CAST_INTERVAL_MS * 0.88),
  /** Melee reaches this much further here than the client draws it: where
   * the server has a player is a moment behind where they see themselves. */
  meleeSlack: 0.75,
  castBurst: 2,
  /** Pause before the first attack of a fight, and after resuming. */
  openingMs: 3_000,
  phases: {
    1: { fromHp: 1, everyMs: 3_200, slams: 2, ringChance: 0 },
    2: { fromHp: 0.66, everyMs: 2_700, slams: 3, ringChance: 0.35 },
    3: { fromHp: 0.33, everyMs: 2_000, slams: 4, ringChance: 0.4 },
  },
  /** Damage is flat, before Def and buffs. Two-thirds of what a level-20
   * herzie with no Stamina took when hits were a share of max HP: casts
   * slowed to CAST_INTERVAL_MS, fights run longer, and the whole fight
   * should still cost about the same health. */
  slam: { radius: 3, windupMs: 1_600, damage: 27 },
  ring: { inner: 6.5, windupMs: 3_000, damage: 34 },
  /** The tank-buster: aimed at whoever the boss hates most, and it follows
   * them — it can't be dodged, only taken (under a Cymbrella, ideally).
   * Only once there's a party to hold its attention: solo, there's no one
   * to tank for. */
  buster: { everyMs: 10_000, windupMs: 2_000, damage: 11, minPlayers: 2 },
  /** What the boss hates: damage dealt, healing done, and the Cymbrella's
   * clang. Fades by `decayPerSec` a second, so it keeps moving. */
  threat: { perDamage: 1, perHeal: 0.5, cymbrella: 500, decayPerSec: 0.1 },
} as const;

/** The most of a herzie's health one hit may take, before Def and buffs:
 * a low level can't be one-shot by flat damage. */
export const MAX_HIT_FRACTION = 0.3;
export const MIN_WINDUP_MS = TUNING.minWindupMs;
export const MAX_TELEGRAPHS = TUNING.maxTelegraphs;

export type Phase = 1 | 2 | 3;
export type TelegraphKind = "circle" | "ring" | "buster";

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
  /** Damage it deals, before the cap, Def and buffs. */
  damage: number;
  /** A buster's target (user id); it lands on them wherever they are. */
  target?: string;
};

/** A player as the engine sees them each update. */
export type BossPlayer = {
  uid: string;
  alive: boolean;
  maxHp: number;
  /** Their Def (Stamina brings it): takes a share off every hit. */
  def?: number;
  /** Where they stood at `t` (server ms), or null if unknown. */
  posAt: (t: number) => { x: number; z: number } | null;
};

export type BossEvent =
  | { t: "telegraph"; telegraph: Telegraph }
  | {
      t: "resolve";
      id: number;
      /** `absorbed`: what buffs took off the hit. */
      hits: { uid: string; damage: number; absorbed: number }[];
    }
  | { t: "phase"; phase: Phase }
  | {
      t: "hit";
      uid: string;
      damage: number;
      crit: boolean;
      hp: number;
      /** Set when a skill threw it, not a plain cast. */
      skill?: string;
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
  skill?: string;
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
  /** How much the boss hates each player (see TUNING.threat). */
  private threat = new Map<string, number>();
  private threatAt: number;
  private nextBusterAt: number;
  /** Buffs on players: one of each kind (applyBuff's no-stacking rule). */
  private buffs = new Map<string, Buff[]>();

  constructor(opts: { hp: number; maxHp: number; seed: number; now: number }) {
    this.maxHp = Math.max(1, opts.maxHp);
    this.hp = Math.max(0, Math.min(this.maxHp, opts.hp));
    this.rand = rng(opts.seed);
    this.phase = phaseFor(this.hp, this.maxHp);
    this.nextAttackAt = opts.now + TUNING.openingMs;
    this.nextBusterAt = opts.now + TUNING.openingMs + TUNING.buster.everyMs;
    this.threatAt = opts.now;
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
    this.threat.delete(uid);
    this.buffs.delete(uid);
  }

  /** The boss hates `uid` this much more. */
  addThreat(uid: string, amount: number): void {
    if (!(amount > 0)) return;
    this.threat.set(uid, (this.threat.get(uid) ?? 0) + amount);
  }

  threatOf(uid: string): number {
    return this.threat.get(uid) ?? 0;
  }

  /** A buff on `uid`; the same kind doesn't stack (the stronger wins). */
  buff(uid: string, next: Buff): Buff {
    const list = applyBuff(this.buffs.get(uid) ?? [], next);
    this.buffs.set(uid, list);
    return list.find((b) => b.id === next.id) as Buff;
  }

  /** Buffs still running, for a newcomer's welcome. */
  activeBuffs(now: number): { uid: string; buff: Buff }[] {
    const out: { uid: string; buff: Buff }[] = [];
    for (const [uid, list] of this.buffs)
      for (const buff of activeBuffs(list, now)) out.push({ uid, buff });
    return out;
  }

  /**
   * Backspin: three discs fanned about the aim, each a wave hit at `mult`
   * of a cast's damage. Rate-limited by the skill's cooldown (the caller's),
   * not the cast bucket. Returns how many will land.
   */
  backspin(
    uid: string,
    from: { x: number; z: number },
    yaw: number,
    pitch: number,
    stats: HitStats,
    mult: number,
    now: number,
  ): number {
    if (this.killed) return 0;
    let landed = 0;
    const half = (BACKSPIN_DISCS - 1) / 2;
    for (let i = 0; i < BACKSPIN_DISCS; i++) {
      const dir = aimDirection(yaw + (i - half) * BACKSPIN_SPREAD, pitch);
      const dist = bossReaches([from.x, WAVE_HAND_HEIGHT, from.z], dir);
      if (dist === null) continue;
      const { amount, crit } = hitDamage(stats, this.rand);
      this.pending.push({
        at: now + (dist / WAVE_SPEED) * 1000,
        uid,
        damage: Math.max(1, Math.round(amount * mult)),
        crit,
        skill: "backspin",
      });
      landed++;
    }
    return landed;
  }

  /**
   * A cast from `uid`, standing at (x, z), aiming (yaw, pitch). Accepted
   * casts that line up with the boss (with the same aim assist the client
   * draws) land after the wave's flight time. Returns whether it counted as
   * a cast (for rate limiting); a miss still uses the cooldown.
   *
   * A Record Slinger's cast is a thrown disc (`attack` "disc"): shorter
   * reach, its own speed, and a little more damage. Only its way out hits.
   * A melee blow (`attack` "melee": a Percussionist's, or a herzie without
   * a class) hits harder, but only up close and facing it; the client
   * sends it as it lands, so it lands now.
   */
  cast(
    uid: string,
    from: { x: number; z: number },
    yaw: number,
    pitch: number,
    stats: HitStats,
    now: number,
    attack: AttackStyle = "wave",
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
    if (attack === "melee") {
      const { x, z, radius } = TUNING.boss;
      if (
        !meleeReaches(
          from,
          yaw,
          { x, z, radius },
          MELEE_REACH + TUNING.meleeSlack,
        )
      )
        return "miss";
      const { amount, crit } = hitDamage(stats, this.rand);
      this.pending.push({
        at: now,
        uid,
        damage: Math.max(1, Math.round(amount * MELEE_DAMAGE)),
        crit,
      });
      return "hit";
    }
    const disc = attack === "disc";
    const dir = aimDirection(yaw, pitch);
    const dist = bossReaches(
      [from.x, WAVE_HAND_HEIGHT, from.z],
      dir,
      disc ? DISC_RANGE : undefined,
    );
    if (dist === null) return "miss";
    const { amount, crit } = hitDamage(stats, this.rand);
    this.pending.push({
      at: now + (disc ? discLandsAfterMs(dist) : (dist / WAVE_SPEED) * 1000),
      uid,
      damage: disc ? Math.max(1, Math.round(amount * DISC_DAMAGE)) : amount,
      crit,
    });
    return "hit";
  }

  /** Advance to `now`: land waves in flight, resolve attacks, start new
   * ones. Events come out in order. */
  update(now: number, players: readonly BossPlayer[]): BossEvent[] {
    const events: BossEvent[] = [];
    this.decayThreat(now);
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
      this.addThreat(p.uid, p.damage * TUNING.threat.perDamage);
      events.push({
        t: "hit",
        uid: p.uid,
        damage: p.damage,
        crit: p.crit,
        hp: this.hp,
        ...(p.skill ? { skill: p.skill } : {}),
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
      const hits: { uid: string; damage: number; absorbed: number }[] = [];
      for (const p of players) {
        if (!p.alive) continue;
        if ((this.safeUntil.get(p.uid) ?? 0) > tg.hitAt) continue;
        if ((this.invulnUntil.get(p.uid) ?? 0) > tg.hitAt) continue;
        if (tg.kind === "buster") {
          // It follows its target: no dodging, and no one else is hit.
          if (p.uid !== tg.target) continue;
        } else {
          // Defender's benefit: in the zone now AND a moment before.
          const inside = [tg.hitAt, tg.hitAt - TUNING.rewindMs].every((t) => {
            const pos = p.posAt(t);
            return !!pos && covers(tg, pos.x, pos.z);
          });
          if (!inside) continue;
        }
        const raw = Math.min(tg.damage, MAX_HIT_FRACTION * p.maxHp);
        // Def and a Cymbrella stack, under the overall clamp in `mitigate`.
        const reductions = [
          defReduction(p.def ?? 0),
          ...activeBuffs(this.buffs.get(p.uid) ?? [], tg.hitAt)
            .filter((b) => b.id === "cymbrella")
            .map((b) => b.value),
        ];
        const damage = Math.max(1, Math.round(mitigate(raw, reductions)));
        const absorbed = Math.max(0, Math.round(raw) - damage);
        hits.push({ uid: p.uid, damage, absorbed });
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
    const targets = players.filter(
      (p) => p.alive && (this.safeUntil.get(p.uid) ?? 0) <= now,
    );
    this.startBuster(now, players, targets, events);
    if (now < this.nextAttackAt) return;
    const cfg = TUNING.phases[this.phase];
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
        damage: TUNING.ring.damage,
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
        damage: TUNING.slam.damage,
      });
    }
  }

  /** The tank-buster, on its own clock: at the most hated player, once
   * there's a party. */
  private startBuster(
    now: number,
    players: readonly BossPlayer[],
    targets: readonly BossPlayer[],
    events: BossEvent[],
  ) {
    if (now < this.nextBusterAt) return;
    const cfg = TUNING.buster;
    const here = players.filter((p) => p.alive).length;
    let target: BossPlayer | undefined;
    for (const p of targets) {
      if (!target || this.threatOf(p.uid) > this.threatOf(target.uid))
        target = p;
    }
    if (here < cfg.minPlayers || !target || this.threatOf(target.uid) <= 0) {
      this.nextBusterAt = now + 500;
      return;
    }
    if (this.telegraphs.length >= MAX_TELEGRAPHS) {
      this.nextBusterAt = now + 500;
      return;
    }
    this.nextBusterAt = now + cfg.everyMs;
    const pos = target.posAt(now) ?? { x: 0, z: 0 };
    const telegraph: Telegraph = {
      id: this.nextId++,
      kind: "buster",
      x: pos.x,
      z: pos.z,
      r: 1.2,
      inner: 0,
      at: now,
      hitAt: now + cfg.windupMs,
      damage: cfg.damage,
      target: target.uid,
    };
    this.telegraphs.push(telegraph);
    events.push({ t: "telegraph", telegraph });
  }

  private decayThreat(now: number) {
    const dt = Math.max(0, now - this.threatAt) / 1000;
    this.threatAt = now;
    if (dt <= 0 || !this.threat.size) return;
    const keep = (1 - TUNING.threat.decayPerSec) ** dt;
    for (const [uid, v] of this.threat) {
      const next = v * keep;
      if (next < 0.5) this.threat.delete(uid);
      else this.threat.set(uid, next);
    }
  }
}

/** Whether a telegraph covers a point. A buster covers its target, not a
 * place: never by position. */
export function covers(tg: Telegraph, x: number, z: number): boolean {
  if (tg.kind === "buster") return false;
  const d = Math.hypot(x - tg.x, z - tg.z);
  return d <= tg.r && d >= tg.inner;
}
