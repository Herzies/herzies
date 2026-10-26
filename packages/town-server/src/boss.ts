/**
 * The boss in the cave: what it does, and what hits it. Pure and
 * deterministic (a seeded RNG and an injected clock), so the whole fight is
 * unit-tested and simulated headlessly; `fight.ts` only feeds it players and
 * relays what it says.
 *
 * Fairness rules every attack here follows (see specs/boss-fight.md): every
 * attack is telegraphed on the floor for at least {@link MIN_WINDUP_MS}
 * before it lands; a hit deals flat damage, so health and Def matter, but
 * never more than {@link MAX_HIT_FRACTION} of a herzie's health; a herzie
 * that was just hit, just arrived or just got back up can't be hit again
 * straight away; at most {@link MAX_TELEGRAPHS} shapes are on the floor at
 * once (its minions' count too); and a hit is judged against where the
 * player stood a moment ago as well as where they are now. The one
 * exception is the enrage's pulse, which ends a fight that ran too long.
 *
 * Before the lock the boss is dormant: it stands at home, can't be hurt and
 * doesn't attack. In the fight it roams after whoever it's focused on (a
 * taunter, else whoever it hates most) across most of the room, keeps
 * moving through its slams, shifts its stance around whoever it's on, and
 * from phase 2 charges at whoever keeps furthest away, down a lane drawn on
 * the floor first.
 */

import {
  BOSS_ENRAGE,
  BOSS_PHASE_AT,
  BOSS_WANDER,
  clampToWander,
  enrageFactor,
  MINION_THRESHOLDS,
  wanderReach,
  weightedRound,
} from "@herzies/shared/boss-fight";
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
  MELEE_REACH,
  meleeReaches,
  STRIKE_DAMAGE,
  WAVE_HAND_HEIGHT,
  WAVE_SPEED,
} from "@herzies/shared/combat";
import {
  activeBuffs,
  applyBuff,
  attackSpeed,
  BACKSPIN_DISCS,
  BACKSPIN_SPREAD,
  type Buff,
  type BuffId,
  buffMultiplier,
  buffReductions,
  mitigate,
} from "@herzies/shared/skills";
import { defReduction } from "@herzies/shared/stats";
import type { TowerMob } from "@herzies/shared/town-net";
import { type Mob, type MobJudge, MobPack, SEEN_LAG_MS } from "./mobs";

// ---------------------------------------------------------------------------
// Tuning: every balance number lives here.

export const TUNING = {
  /** Where the boss rests (and stands in the lobby), and how big it is. */
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
  /** A player aims at the boss as they see it: this long behind the
   * server (interpolation plus a typical trip), so a cast is judged
   * against where it stood then. */
  seenLagMs: 150,
  /** A player may cast about this often: a little under the client's pace,
   * with a short burst, so network jitter never costs a real cast. */
  castEveryMs: Math.round(CAST_INTERVAL_MS * 0.88),
  /** Melee reaches this much further here than the client draws it: where
   * the server has a player is a moment behind where they see themselves. */
  meleeSlack: 0.75,
  castBurst: 2,
  /** A Haste is honoured this long past its end (and its start): a client
   * a frame or a trip behind mustn't have a hasted cast called too soon. */
  hasteGraceMs: 300,
  /** Pause before the first attack of a fight, and after resuming. */
  openingMs: 3_000,
  /** A herzie's radius, for how close the boss walks up. */
  playerRadius: 0.5,
  phases: {
    1: { fromHp: 1, everyMs: 3_200, slams: 2, ringChance: 0 },
    2: { fromHp: BOSS_PHASE_AT[0], everyMs: 2_700, slams: 3, ringChance: 0.35 },
    3: { fromHp: BOSS_PHASE_AT[1], everyMs: 2_000, slams: 4, ringChance: 0.4 },
  },
  /** Damage is flat, before Def and buffs, and within the fairness budget
   * (a level-20 herzie without Stamina loses at most MAX_HIT_FRACTION of
   * its health to one). Raised for the raid: a slam you stand in should
   * sting a level-30 herzie, and a ring you're caught by should hurt. The
   * ring's windup lets someone at the far wall reach its middle wherever
   * the boss has walked to. */
  slam: { radius: 3, windupMs: 1_600, damage: 45 },
  ring: { inner: 6.5, windupMs: 4_200, damage: 58 },
  /** The tank-buster: aimed at whoever the boss is focused on, and it
   * follows them — it can't be dodged, only taken. Sized so that a herzie
   * who isn't tanking it is badly hurt, and a Percussionist (Def, a
   * Cymbrella, in tune) is comfortable. Without a taunt, only once there's
   * a party to hold its attention. */
  buster: { everyMs: 10_000, windupMs: 2_000, damage: 70, minPlayers: 2 },
  /** What the boss hates: damage dealt, healing done, and the Cymbrella's
   * clang. Fades by `decayPerSec` a second, so it keeps moving. */
  threat: { perDamage: 1, perHeal: 0.5, cymbrella: 500, decayPerSec: 0.1 },
  /** It changes its mind only for someone it hates clearly more than its
   * focus (WoW's 110% in melee, 130% from range), so it doesn't twitch
   * between two close damage dealers. */
  focusSwitch: { melee: 1.1, ranged: 1.3, meleeReach: 3 },
  /** Each buster leaves its target Rattled: the next one hits harder, per
   * stack, past the usual one-hit cap (to a ceiling). Fades unhit; a
   * second tank taking a turn is how it's cleared. */
  rattled: { perStack: 0.25, maxStacks: 4, ms: 20_000, maxHitFraction: 0.6 },
  /** From phase 2, now and then it charges whoever keeps furthest off (at
   * least `minDist` away): it faces them for `windupMs` as a lane `width`
   * wide fills on the floor, then barrels down it at `speed`, on through
   * them by `overshoot` (within its walk). Everyone in the lane as it goes
   * is hit. Ranged herzies can't stand still at the back forever. */
  charge: {
    fromPhase: 2,
    everyMs: 18_000,
    windupMs: 1_800,
    minDist: 7,
    width: 2.6,
    overshoot: 2,
    speed: 14,
    damage: 50,
  },
  /** In reach of whoever it's on, it doesn't stand still: every so often
   * it shifts round them by `angle` (radians either way), at `speed` of
   * its walk. Through its own slams it walks at `slamSpeed` of its walk. */
  stride: { everyMs: [4_000, 7_000], angle: [0.5, 1.1], speed: 0.6 },
  slamSpeed: 0.6,
  /** Its minions' share of the floor's shapes. */
  minionShapes: 2,
  /** A bigger raid gets more at once: one more shape and slam per this
   * many herzies, up to the most. */
  scale: { perPlayers: 6, maxShapes: 10, maxSlams: 10 },
  /** In a big raid, it marks a few herzies at once: each mark goes off
   * where its herzie stands, on everyone in it. Spread out. */
  scatter: {
    minPlayers: 20,
    everyMs: 25_000,
    windupMs: 2_500,
    radius: 2.5,
    damage: 40,
    perMarks: 6,
  },
} as const;

/** How far an off-centre ring reaches: from anywhere the boss can walk, to
 * past the far wall. */
export const RING_REACH =
  TUNING.roomRadius +
  Math.hypot(BOSS_WANDER.x, BOSS_WANDER.z) +
  BOSS_WANDER.radius +
  2;

/** The most of a herzie's health one hit may take, before Def and buffs:
 * a low level can't be one-shot by flat damage. */
export const MAX_HIT_FRACTION = 0.3;
export const MIN_WINDUP_MS = TUNING.minWindupMs;
export const MAX_TELEGRAPHS = TUNING.maxTelegraphs;

/** How long of the boss's path is kept, for judging casts against where
 * it stood a moment ago. */
const PATH_MS = 1_000;

export type Phase = 1 | 2 | 3;
export type TelegraphKind = "circle" | "ring" | "buster" | "scatter" | "lane";

export type Telegraph = {
  id: number;
  kind: TelegraphKind;
  x: number;
  z: number;
  /** Outer radius (a lane's: how far either side of its line). */
  r: number;
  /** A lane: heading from (x, z), and how long. */
  yaw?: number;
  len?: number;
  /** Inner (safe) radius of a ring; 0 for a circle. */
  inner: number;
  /** When it appeared and when it lands (server ms). */
  at: number;
  hitAt: number;
  /** Damage it deals, before the cap, Def and buffs. */
  damage: number;
  /** A buster's or a scatter mark's target (user id): a buster lands on
   * them wherever they are, a mark goes off around them. */
  target?: string;
  /** Whom it was aimed at (a buster, or a slam on the boss's focus): a
   * taunt is paid for what it draws. */
  aimedAt?: string;
  /** The enrage's pulse: lands on everyone, for all their health. */
  lethal?: boolean;
  /** In the Tower (or a minion in the cave): the mob swinging it. */
  mob?: number;
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

export type BossHit = {
  uid: string;
  damage: number;
  /** What Def and buffs took off the hit. */
  absorbed: number;
  /** The Cymbrella's share of that alone. */
  blocked: number;
  /** The hit was aimed at them (a taunt draws these). */
  aimed?: boolean;
};

export type BossEvent =
  | { t: "telegraph"; telegraph: Telegraph }
  /** A buster left `uid` Rattled: `stacks` of it, until `until`. */
  | { t: "rattled"; uid: string; stacks: number; until: number }
  | { t: "resolve"; id: number; hits: BossHit[] }
  | { t: "phase"; phase: Phase }
  | {
      t: "hit";
      uid: string;
      damage: number;
      crit: boolean;
      hp: number;
      /** Set when a skill threw it, not a plain cast. */
      skill?: string;
      /** In the Tower: the mob it hit. */
      mob?: number;
    }
  | { t: "killed"; by: string }
  /** It began to quicken (once), and began the pulses that end the fight
   * (once). */
  | { t: "enrage" }
  | { t: "pulse" }
  /** A taunt ran out, or its holder fell or left. */
  | { t: "untaunt"; uid: string }
  /** Its health fell past a minion threshold: time to call a pack (the
   * fight decides how many). */
  | { t: "minions"; share: number }
  /** One of its minions fell (or crumbled with it: `by` empty). */
  | { t: "mobDown"; mob: number; by: string; x: number; z: number };

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

export type BossOptions = {
  hp: number;
  maxHp: number;
  seed: number;
  now: number;
  /** In the lobby: stands still, can't be hurt, doesn't attack, until
   * {@link BossEngine.wake}. */
  dormant?: boolean;
  /** When the fight locked (server ms), for the enrage; default `now`. */
  lockedAt?: number;
  /** Never walks (unit tests that aim at it from a fixed spot). */
  pinned?: boolean;
  /** Hands out telegraph ids, shared with the minions so theirs never
   * collide with the boss's. */
  nextId?: () => number;
};

export class BossEngine {
  hp: number;
  maxHp: number;
  private phase: Phase;
  private nextAttackAt: number;
  private readonly nextId: () => number;
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
  private sleeping: boolean;
  private lockedAt: number;
  private readonly pinned: boolean;
  /** Where it stands and faces now, and where it stood the last second. */
  private at: { x: number; z: number };
  private facing = Math.PI;
  private path: { t: number; x: number; z: number }[] = [];
  private lastMoveAt: number;
  /** It walked (or turned) since the last {@link takeMoved}. */
  private moved = false;
  /** Who it's after, as of the last update (a user id). */
  private focusUid: string | null = null;
  /** The last taunt: whoever cast it holds the boss until `until`. */
  private taunt: { uid: string; until: number } | null = null;
  /** A charge under way: down `yaw` from `from`, `len` long; it sets off
   * at `goAt` and gets there at `endAt` (server ms). */
  private charging: {
    from: { x: number; z: number };
    yaw: number;
    len: number;
    goAt: number;
    endAt: number;
  } | null = null;
  private nextChargeAt: number;
  /** Where it's shifting to round its focus, and when it next shifts. */
  private strideTo: { x: number; z: number } | null = null;
  private nextStrideAt = 0;
  private enraged = false;
  private pulsing = false;
  private nextPulseAt = 0;
  /** Its minions, once it has called any. */
  private mobs: MobPack | null = null;
  /** The last update's time, and how many herzies were in it. */
  private clock = 0;
  private raidSize = 0;
  /** Rattled by busters: stacks and until when (server ms), by user id. */
  private rattled = new Map<string, { stacks: number; until: number }>();
  private nextScatterAt = 0;
  /** Minion thresholds not yet crossed. */
  private thresholds: number[] = [...MINION_THRESHOLDS];
  /** How a minion's hit on a herzie is judged: by the boss's own breathers
   * and buffs, so the two never stack up unfairly. */
  private readonly judge: MobJudge = {
    safe: (uid, t) => (this.safeUntil.get(uid) ?? 0) > t,
    invuln: (uid, t) => (this.invulnUntil.get(uid) ?? 0) > t,
    hitAt: (uid, t) => this.invulnUntil.set(uid, t + TUNING.invulnMs),
    buffs: (uid) => this.buffs.get(uid) ?? [],
  };

  constructor(opts: BossOptions) {
    this.maxHp = Math.max(1, opts.maxHp);
    this.hp = Math.max(0, Math.min(this.maxHp, opts.hp));
    this.rand = rng(opts.seed);
    let id = 1;
    this.nextId = opts.nextId ?? (() => id++);
    this.phase = phaseFor(this.hp, this.maxHp);
    // A room picked up mid-fight has already called the packs above its
    // health (it would call them all at once on the first hit).
    this.thresholds = this.thresholds.filter((t) => this.hp / this.maxHp > t);
    this.nextAttackAt = opts.now + TUNING.openingMs;
    this.nextBusterAt = opts.now + TUNING.openingMs + TUNING.buster.everyMs;
    this.nextChargeAt = opts.now + TUNING.openingMs + TUNING.charge.everyMs;
    this.threatAt = opts.now;
    this.killed = this.hp <= 0;
    this.sleeping = !!opts.dormant;
    this.lockedAt = opts.lockedAt ?? opts.now;
    this.pinned = !!opts.pinned;
    this.at = { x: BOSS_STAND.x, z: BOSS_STAND.z };
    this.lastMoveAt = opts.now;
    this.path.push({ t: opts.now, ...this.at });
  }

  get dead(): boolean {
    return this.killed;
  }

  get dormant(): boolean {
    return this.sleeping;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  /** What's on the floor (its own shapes and its minions'), for a
   * newcomer's welcome. */
  get active(): readonly Telegraph[] {
    return this.mobs?.active.length
      ? [...this.telegraphs, ...this.mobs.active]
      : this.telegraphs;
  }

  /** Its minions as the wire carries them (none before it calls any). */
  wireMobs(): TowerMob[] {
    return this.mobs?.wire() ?? [];
  }

  /** Only the minions that changed since the last call. */
  wireMobsChanged(): TowerMob[] {
    return this.mobs?.wireChanged() ?? [];
  }

  /** How many of its minions stand. */
  get minionsUp(): number {
    return this.mobs?.alive.length ?? 0;
  }

  /**
   * Calls `count` Thornlings as strong as Tower floor `floor`, set against
   * the raid's average `level`, along the room's far edge from where it
   * stands and clear of the herzies at `herzies`.
   */
  summon(
    now: number,
    count: number,
    floor: number,
    level: number,
    herzies: readonly { x: number; z: number }[],
  ): void {
    if (count <= 0) return;
    if (!this.mobs) {
      this.mobs = new MobPack(
        { floor, level, now, rand: this.rand, nextId: this.nextId },
        { radius: TUNING.roomRadius, entry: { x: 0, z: 10 } },
        () => ({ x: this.at.x, z: this.at.z, r: TUNING.boss.radius }),
      );
      // The cave's fairness rules hold for its minions too.
      this.mobs.minWindupMs = TUNING.minWindupMs;
      this.mobs.maxShapes = TUNING.minionShapes;
      this.mobs.taunter = () => this.taunter(this.clock);
    }
    this.mobs.floor = Math.max(1, Math.floor(floor));
    this.mobs.level = Math.max(1, Math.floor(level));
    this.mobs.spawnPack(now, count, this.at, herzies);
  }

  /** Where it stands and which way it faces. */
  get position(): { x: number; z: number; yaw: number } {
    return { x: this.at.x, z: this.at.z, yaw: this.facing };
  }

  /** Who it's after (a user id), if anyone. */
  get focus(): string | null {
    return this.focusUid;
  }

  /** Whoever holds a taunt at `now`, if anyone. */
  taunter(now: number): string | null {
    return this.taunt && this.taunt.until > now ? this.taunt.uid : null;
  }

  /** When the enrage starts and when its pulse comes (server ms). */
  get enrageAt(): number {
    return this.lockedAt + BOSS_ENRAGE.softMs;
  }
  get hardAt(): number {
    return this.lockedAt + BOSS_ENRAGE.hardMs;
  }

  /** Whether it walked or turned since last asked (and forget that it did). */
  takeMoved(): boolean {
    const m = this.moved;
    this.moved = false;
    return m;
  }

  /** Where it stood at `t` (server ms), from its path over the last
   * second; its oldest known spot before that. */
  positionAt(t: number): { x: number; z: number } {
    const path = this.path;
    if (!path.length || t >= path[path.length - 1].t) return { ...this.at };
    if (t <= path[0].t) return { x: path[0].x, z: path[0].z };
    for (let i = path.length - 1; i > 0; i--) {
      const a = path[i - 1];
      const b = path[i];
      if (t >= a.t) {
        const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
        return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return { x: path[0].x, z: path[0].z };
  }

  /** The lobby's over: the fight is on, at this health. The enrage counts
   * from `now`. */
  wake(now: number, hp: number, maxHp: number): void {
    this.maxHp = Math.max(1, maxHp);
    this.hp = Math.max(0, Math.min(this.maxHp, hp));
    this.killed = this.hp <= 0;
    this.phase = phaseFor(this.hp, this.maxHp);
    this.sleeping = false;
    this.lockedAt = now;
    this.nextAttackAt = now + TUNING.openingMs;
    this.nextBusterAt = now + TUNING.openingMs + TUNING.buster.everyMs;
    this.nextChargeAt = now + TUNING.openingMs + TUNING.charge.everyMs;
    this.lastMoveAt = now;
  }

  /** The database's word on its health (after the lock, or a restart). */
  setHealth(hp: number, maxHp: number): void {
    this.maxHp = Math.max(1, maxHp);
    this.hp = Math.max(0, Math.min(this.maxHp, hp));
    this.phase = phaseFor(this.hp, this.maxHp);
    this.killed = this.hp <= 0;
    // Thresholds already behind it (a restart mid-fight) don't call again.
    const share = this.hp / this.maxHp;
    this.thresholds = this.thresholds.filter((t) => share > t);
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
    if (this.taunt?.uid === uid) this.taunt = null;
  }

  /** The boss hates `uid` this much more. */
  addThreat(uid: string, amount: number): void {
    if (!(amount > 0)) return;
    this.threat.set(uid, (this.threat.get(uid) ?? 0) + amount);
  }

  /** A taunt's threat: a clear lead over whoever it hates most. */
  tauntThreat(uid: string): void {
    let top = 0;
    for (const [other, v] of this.threat)
      if (other !== uid) top = Math.max(top, v);
    const mine = this.threatOf(uid);
    this.threat.set(
      uid,
      Math.max(mine + TUNING.threat.cymbrella, top * TUNING.focusSwitch.ranged),
    );
  }

  threatOf(uid: string): number {
    return this.threat.get(uid) ?? 0;
  }

  /** A taunt: the boss is `uid`'s until `until`. The last one cast wins.
   * Returns who held it before, if anyone else did. */
  setTaunt(uid: string, until: number, now: number): string | null {
    const before = this.taunter(now);
    this.taunt = { uid, until };
    return before && before !== uid ? before : null;
  }

  /** `uid`'s taunt ends now (they fell or left), if they hold it. */
  dropTaunt(uid: string): boolean {
    if (this.taunt?.uid !== uid) return false;
    this.taunt = null;
    return true;
  }

  /** A buff on `uid`; the same kind doesn't stack (the stronger wins). */
  buff(uid: string, next: Buff): Buff {
    const list = applyBuff(this.buffs.get(uid) ?? [], next);
    this.buffs.set(uid, list);
    return list.find((b) => b.id === next.id) as Buff;
  }

  /** `uid` loses its buff `id` now. Whether it had one. */
  clearBuff(uid: string, id: BuffId): boolean {
    const list = this.buffs.get(uid);
    if (!list?.some((b) => b.id === id)) return false;
    this.buffs.set(
      uid,
      list.filter((b) => b.id !== id),
    );
    return true;
  }

  /** `uid`'s buffs at `now`. */
  buffsOf(uid: string, now: number): Buff[] {
    return activeBuffs(this.buffs.get(uid) ?? [], now);
  }

  /** Buffs still running, for a newcomer's welcome. */
  activeBuffs(now: number): { uid: string; buff: Buff }[] {
    const out: { uid: string; buff: Buff }[] = [];
    for (const [uid, list] of this.buffs)
      for (const buff of activeBuffs(list, now)) out.push({ uid, buff });
    return out;
  }

  /** How much harder `uid` hits right now (an in-tune Record Slinger). */
  private damageMult(uid: string, now: number): number {
    return buffMultiplier(this.buffs.get(uid) ?? [], "damage", now);
  }

  /** Where a cast from `now` is judged to find the boss: where its caster
   * saw it. */
  private seenAt(now: number): { x: number; z: number } {
    return this.positionAt(now - TUNING.seenLagMs);
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
    if (this.killed || this.sleeping) return 0;
    let landed = 0;
    const half = (BACKSPIN_DISCS - 1) / 2;
    const boost = this.damageMult(uid, now);
    for (let i = 0; i < BACKSPIN_DISCS; i++) {
      const dir = aimDirection(yaw + (i - half) * BACKSPIN_SPREAD, pitch);
      const hit = this.nearest(from, dir, now);
      if (!hit) continue;
      const at = now + (hit.dist / WAVE_SPEED) * 1000;
      if (hit.mob) {
        this.mobs?.queue(uid, hit.mob, at, stats, mult * boost, "backspin");
      } else {
        const { amount, crit } = hitDamage(stats, this.rand);
        this.pending.push({
          at,
          uid,
          damage: Math.max(1, Math.round(amount * mult * boost)),
          crit,
          skill: "backspin",
        });
      }
      landed++;
    }
    return landed;
  }

  /** What a cast along `dir` from (x, z) finds first: the boss, or one of
   * its minions (as the caster saw them), and how far away. */
  private nearest(
    from: { x: number; z: number },
    dir: readonly [number, number, number],
    now: number,
    range?: number,
  ): { dist: number; mob?: Mob } | null {
    const boss = bossReaches(
      [from.x, WAVE_HAND_HEIGHT, from.z],
      dir,
      range,
      this.seenAt(now),
    );
    const mob = this.mobs?.along(from, dir, now - SEEN_LAG_MS, range) ?? null;
    if (mob && (boss === null || mob.dist < boss)) return mob;
    return boss === null ? null : { dist: boss };
  }

  /**
   * A cast from `uid`, standing at (x, z), aiming (yaw, pitch). Accepted
   * casts that line up with the boss (with the same aim assist the client
   * draws) — or with one of its minions, if one is nearer along the aim —
   * land after the wave's flight time. Returns whether it counted as a cast
   * (for rate limiting); a miss still uses the cooldown. A dormant boss
   * can't be hurt: every cast misses.
   *
   * A Record Slinger's cast is a thrown disc (`attack` "disc"): shorter
   * reach, its own speed, and a little more damage. Only its way out hits.
   * A melee blow (`attack` "melee": a Percussionist's stick, or a herzie
   * without a class bumping into it) hits for `melee` of a wave, only up
   * close and facing it — the boss and every minion in front of it at once;
   * the client sends it as it lands, so it lands now.
   */
  cast(
    uid: string,
    from: { x: number; z: number },
    yaw: number,
    pitch: number,
    stats: HitStats,
    now: number,
    attack: AttackStyle = "wave",
    melee: number = STRIKE_DAMAGE,
  ): "cooldown" | "miss" | "hit" | "dead" {
    if (this.killed) return "dead";
    const bucket = this.casts.get(uid) ?? {
      tokens: TUNING.castBurst,
      at: now,
    };
    bucket.tokens = Math.min(
      TUNING.castBurst,
      bucket.tokens +
        (Math.max(0, now - bucket.at) / TUNING.castEveryMs) *
          castSpeed(this.buffs.get(uid) ?? [], now),
    );
    bucket.at = now;
    this.casts.set(uid, bucket);
    if (bucket.tokens < 1) return "cooldown";
    bucket.tokens -= 1;
    if (this.sleeping) return "miss";
    const boost = this.damageMult(uid, now);
    if (attack === "melee") {
      const boss = this.seenAt(now);
      const onBoss = meleeReaches(
        from,
        yaw,
        { x: boss.x, z: boss.z, radius: TUNING.boss.radius },
        MELEE_REACH + TUNING.meleeSlack,
      );
      const onMobs = this.mobs?.inReach(from, yaw, now - SEEN_LAG_MS) ?? [];
      if (!onBoss && !onMobs.length) return "miss";
      for (const m of onMobs)
        this.mobs?.queue(uid, m, now, stats, melee * boost);
      if (onBoss) {
        const { amount, crit } = hitDamage(stats, this.rand);
        this.pending.push({
          at: now,
          uid,
          damage: Math.max(1, Math.round(amount * melee * boost)),
          crit,
        });
      }
      return "hit";
    }
    const disc = attack === "disc";
    const hit = this.nearest(
      from,
      aimDirection(yaw, pitch),
      now,
      disc ? DISC_RANGE : undefined,
    );
    if (!hit) return "miss";
    const at =
      now +
      (disc ? discLandsAfterMs(hit.dist) : (hit.dist / WAVE_SPEED) * 1000);
    const mult = (disc ? DISC_DAMAGE : 1) * boost;
    if (hit.mob) {
      this.mobs?.queue(uid, hit.mob, at, stats, mult);
      return "hit";
    }
    const { amount, crit } = hitDamage(stats, this.rand);
    this.pending.push({
      at,
      uid,
      damage: Math.max(1, Math.round(amount * mult)),
      crit,
    });
    return "hit";
  }

  /** Advance to `now`: land waves in flight, resolve attacks, walk, start
   * new ones. Events come out in order. */
  update(now: number, players: readonly BossPlayer[]): BossEvent[] {
    const events: BossEvent[] = [];
    this.clock = now;
    this.raidSize = players.length;
    this.decayThreat(now);
    if (this.sleeping) {
      this.pending = [];
      this.lastMoveAt = now;
      return events;
    }
    this.landWaves(now, events);
    if (this.killed) {
      this.telegraphs = [];
      // Its minions crumble with it.
      for (const m of this.mobs?.dismiss() ?? [])
        events.push({ t: "mobDown", mob: m.id, by: "", x: m.x, z: m.z });
      return events;
    }
    if (this.mobs) events.push(...this.mobs.update(now, players, this.judge));
    this.checkTaunt(now, players, events);
    this.resolveDue(now, players, events);
    this.pickFocus(now, players);
    this.walk(now, players);
    this.startEnrage(now, players, events);
    this.startAttacks(now, players, events);
    return events;
  }

  /** A taunt ends early when its holder can't hold it: down, or gone. */
  private checkTaunt(
    now: number,
    players: readonly BossPlayer[],
    events: BossEvent[],
  ) {
    const t = this.taunt;
    if (!t) return;
    const holder = players.find((p) => p.uid === t.uid);
    if (t.until <= now || !holder?.alive) {
      this.taunt = null;
      events.push({ t: "untaunt", uid: t.uid });
    }
  }

  /** Who it's after: a taunter, else whoever it hates most, else whoever
   * stands nearest. */
  private pickFocus(now: number, players: readonly BossPlayer[]) {
    const alive = players.filter((p) => p.alive && p.posAt(now));
    const taunter = this.taunter(now);
    let focus = taunter ? alive.find((p) => p.uid === taunter) : undefined;
    if (!focus) {
      let best = 0;
      for (const p of alive) {
        const t = this.threatOf(p.uid);
        if (t > best) {
          best = t;
          focus = p;
        }
      }
      // Keep the one it's on unless someone's clearly ahead.
      const current = alive.find((p) => p.uid === this.focusUid);
      if (focus && current && focus !== current) {
        const held = this.threatOf(current.uid);
        const at = focus.posAt(now) as { x: number; z: number };
        const reach =
          Math.hypot(at.x - this.at.x, at.z - this.at.z) - TUNING.boss.radius;
        const need =
          reach <= TUNING.focusSwitch.meleeReach
            ? TUNING.focusSwitch.melee
            : TUNING.focusSwitch.ranged;
        if (held > 0 && best < held * need) focus = current;
      }
    }
    if (!focus) {
      let near = Number.POSITIVE_INFINITY;
      for (const p of alive) {
        const at = p.posAt(now) as { x: number; z: number };
        const d = Math.hypot(at.x - this.at.x, at.z - this.at.z);
        if (d < near) {
          near = d;
          focus = p;
        }
      }
    }
    this.focusUid = focus?.uid ?? null;
  }

  /** Roam after the focus (within the wander circle) and face it. It
   * stands still only while its own ring (or the enrage's pulse) winds up
   * and while it lines up a charge; through a slam it walks slower. In
   * reach, it shifts its stance round its focus now and then. */
  private walk(now: number, players: readonly BossPlayer[]) {
    const dt = Math.max(0, Math.min(250, now - this.lastMoveAt)) / 1000;
    this.lastMoveAt = now;
    if (this.charging) {
      this.stepCharge(now, dt);
      this.record(now);
      return;
    }
    const target = this.focusUid
      ? players.find((p) => p.uid === this.focusUid)?.posAt(now)
      : null;
    if (!target || dt <= 0) {
      this.record(now);
      return;
    }
    const dx = target.x - this.at.x;
    const dz = target.z - this.at.z;
    this.turnToward(Math.atan2(dx, dz), dt);
    let ringing = false;
    let slamming = false;
    for (const t of this.telegraphs) {
      if (t.mob !== undefined || t.hitAt <= now) continue;
      if (t.kind === "ring") ringing = true;
      else if (t.kind === "circle" || t.kind === "scatter") slamming = true;
    }
    if (this.pinned || ringing) {
      this.record(now);
      return;
    }
    const pace = BOSS_WANDER.speed * (slamming ? TUNING.slamSpeed : 1);
    const d = Math.hypot(dx, dz);
    const gap = d - TUNING.boss.radius - TUNING.playerRadius;
    // A little slack before it gives chase again, so having just stopped
    // at its distance it doesn't keep "chasing" by a hair.
    if (gap > BOSS_WANDER.keep + 0.15) {
      // After it.
      this.strideTo = null;
      this.stepToward(
        dx / d,
        dz / d,
        Math.min(pace * dt, gap - BOSS_WANDER.keep),
      );
    } else {
      // In reach: now and then, round them a little.
      if (!this.strideTo && now >= this.nextStrideAt) {
        const [lo, hi] = TUNING.stride.angle;
        const turn =
          (lo + (hi - lo) * this.rand()) * (this.rand() < 0.5 ? -1 : 1);
        const away = Math.atan2(-dx, -dz) + turn;
        const r = TUNING.boss.radius + TUNING.playerRadius + BOSS_WANDER.keep;
        this.strideTo = clampToWander({
          x: target.x + Math.sin(away) * r,
          z: target.z + Math.cos(away) * r,
        });
        const [a, b] = TUNING.stride.everyMs;
        this.nextStrideAt = now + a + (b - a) * this.rand();
      }
      const to = this.strideTo;
      if (to) {
        const sx = to.x - this.at.x;
        const sz = to.z - this.at.z;
        const sd = Math.hypot(sx, sz);
        if (sd < 0.05) this.strideTo = null;
        else
          this.stepToward(
            sx / sd,
            sz / sd,
            Math.min(pace * TUNING.stride.speed * dt, sd),
          );
      }
    }
    this.record(now);
  }

  private turnToward(want: number, dt: number) {
    let turn = Math.atan2(
      Math.sin(want - this.facing),
      Math.cos(want - this.facing),
    );
    const maxTurn = BOSS_WANDER.turn * dt;
    turn = Math.max(-maxTurn, Math.min(maxTurn, turn));
    if (Math.abs(turn) > 1e-4) {
      this.facing += turn;
      this.moved = true;
    }
  }

  private stepToward(ux: number, uz: number, step: number) {
    if (!(step > 0)) return;
    const next = clampToWander({
      x: this.at.x + ux * step,
      z: this.at.z + uz * step,
    });
    if (
      Math.abs(next.x - this.at.x) > 1e-4 ||
      Math.abs(next.z - this.at.z) > 1e-4
    ) {
      this.at = next;
      this.moved = true;
    }
  }

  /** A charge: lining up (turning to its lane), then down it. */
  private stepCharge(now: number, dt: number) {
    const c = this.charging;
    if (!c) return;
    if (now < c.goAt) {
      this.turnToward(c.yaw, dt * 3);
      return;
    }
    this.facing = c.yaw;
    const k = Math.min(1, (now - c.goAt) / Math.max(1, c.endAt - c.goAt));
    this.at = clampToWander({
      x: c.from.x + Math.sin(c.yaw) * c.len * k,
      z: c.from.z + Math.cos(c.yaw) * c.len * k,
    });
    this.moved = true;
    if (k >= 1) this.charging = null;
  }

  private record(now: number) {
    const last = this.path[this.path.length - 1];
    if (last && last.x === this.at.x && last.z === this.at.z) {
      last.t = now;
    } else {
      this.path.push({ t: now, x: this.at.x, z: this.at.z });
    }
    while (this.path.length > 2 && this.path[1].t < now - PATH_MS)
      this.path.shift();
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
      const share = this.hp / this.maxHp;
      while (
        this.thresholds.length &&
        share <= this.thresholds[0] &&
        this.hp > 0
      )
        events.push({ t: "minions", share: this.thresholds.shift() as number });
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
    // Where each scatter mark goes off: on its herzie, as they stand.
    const centres = new Map<number, { x: number; z: number }>();
    for (const tg of due)
      if (tg.kind === "scatter" && tg.target) {
        const pos = players.find((p) => p.uid === tg.target)?.posAt(tg.hitAt);
        if (pos) centres.set(tg.id, pos);
      }
    this.telegraphs = this.telegraphs.filter((t) => t.hitAt > now);
    for (const tg of due) {
      const hits: BossHit[] = [];
      for (const p of players) {
        if (!p.alive) continue;
        if (tg.lethal) {
          // The pulse: everyone, for everything.
          hits.push({ uid: p.uid, damage: p.maxHp, absorbed: 0, blocked: 0 });
          continue;
        }
        if ((this.safeUntil.get(p.uid) ?? 0) > tg.hitAt) continue;
        // A buster always lands (a slam a moment before doesn't spare its
        // target): it's the tank's to take.
        if (
          tg.kind !== "buster" &&
          (this.invulnUntil.get(p.uid) ?? 0) > tg.hitAt
        )
          continue;
        if (tg.kind === "buster") {
          // It follows its target: no dodging, and no one else is hit.
          if (p.uid !== tg.target) continue;
        } else if (tg.kind === "scatter") {
          // A mark goes off where its herzie stands now.
          const c = centres.get(tg.id);
          const pos = p.posAt(tg.hitAt);
          if (!c || !pos || Math.hypot(pos.x - c.x, pos.z - c.z) > tg.r)
            continue;
        } else {
          // Defender's benefit: in the zone now AND a moment before.
          const inside = [tg.hitAt, tg.hitAt - TUNING.rewindMs].every((t) => {
            const pos = p.posAt(t);
            return !!pos && covers(tg, pos.x, pos.z);
          });
          if (!inside) continue;
        }
        if (tg.kind === "buster") {
          const r = this.rattledOf(p.uid, tg.hitAt);
          hits.push(
            mitigatedHit(p, tg, this.buffs.get(p.uid) ?? [], {
              mult: 1 + TUNING.rattled.perStack * r,
              cap: r > 0 ? TUNING.rattled.maxHitFraction : MAX_HIT_FRACTION,
            }),
          );
          const stacks = Math.min(TUNING.rattled.maxStacks, r + 1);
          const until = tg.hitAt + TUNING.rattled.ms;
          this.rattled.set(p.uid, { stacks, until });
          events.push({ t: "rattled", uid: p.uid, stacks, until });
        } else hits.push(mitigatedHit(p, tg, this.buffs.get(p.uid) ?? []));
        this.invulnUntil.set(p.uid, tg.hitAt + TUNING.invulnMs);
      }
      events.push({ t: "resolve", id: tg.id, hits });
    }
  }

  /** How many stacks of Rattled `uid` carries at `t`. */
  rattledOf(uid: string, t: number): number {
    const r = this.rattled.get(uid);
    return r && r.until > t ? r.stacks : 0;
  }

  /** The soft enrage (once, a heads-up), and the hard one: a lethal pulse
   * on everyone, again and again, until the fight is over. */
  private startEnrage(
    now: number,
    players: readonly BossPlayer[],
    events: BossEvent[],
  ) {
    if (!this.enraged && now >= this.enrageAt) {
      this.enraged = true;
      events.push({ t: "enrage" });
    }
    if (now < this.hardAt) return;
    if (!this.pulsing) {
      this.pulsing = true;
      this.nextPulseAt = now;
      events.push({ t: "pulse" });
    }
    if (now < this.nextPulseAt || !players.some((p) => p.alive)) return;
    this.nextPulseAt = now + BOSS_ENRAGE.pulseEveryMs;
    const telegraph: Telegraph = {
      id: this.nextId(),
      kind: "ring",
      x: this.at.x,
      z: this.at.z,
      r: RING_REACH,
      inner: 0,
      at: now,
      hitAt: now + BOSS_ENRAGE.pulseWindupMs,
      damage: 0,
      lethal: true,
    };
    this.telegraphs.push(telegraph);
    events.push({ t: "telegraph", telegraph });
  }

  /** Most of its own shapes on the floor at once: more in a big raid. Its
   * minions have their own share; busters and the pulse don't count. */
  private get maxShapes(): number {
    const s = TUNING.scale;
    return Math.min(
      s.maxShapes,
      MAX_TELEGRAPHS + Math.floor(this.raidSize / s.perPlayers),
    );
  }

  private room(): boolean {
    let n = 0;
    for (const t of this.telegraphs) if (t.kind !== "buster" && !t.lethal) n++;
    return n < this.maxShapes;
  }

  private startAttacks(
    now: number,
    players: readonly BossPlayer[],
    events: BossEvent[],
  ) {
    if (this.pulsing) return;
    const targets = players.filter(
      (p) => p.alive && (this.safeUntil.get(p.uid) ?? 0) <= now,
    );
    const fury = enrageFactor(now - this.lockedAt);
    this.startBuster(now, players, targets, events, fury);
    this.startScatter(now, targets, events, fury);
    this.startCharge(now, targets, events, fury);
    if (now < this.nextAttackAt) return;
    const cfg = TUNING.phases[this.phase];
    if (!targets.length) {
      // Nobody to aim at: check again soon, without burning the cadence.
      this.nextAttackAt = now + 500;
      return;
    }
    this.nextAttackAt = now + Math.round(cfg.everyMs / fury);
    const add = (tg: Omit<Telegraph, "id" | "at">) => {
      if (!this.room()) return;
      const telegraph: Telegraph = { ...tg, id: this.nextId(), at: now };
      this.telegraphs.push(telegraph);
      events.push({ t: "telegraph", telegraph });
    };
    // No ring while it charges: it's not where the ring would be.
    if (!this.charging && this.rand() < cfg.ringChance) {
      add({
        kind: "ring",
        x: this.at.x,
        z: this.at.z,
        r: RING_REACH,
        inner: TUNING.ring.inner,
        hitAt: now + TUNING.ring.windupMs,
        damage: Math.round(TUNING.ring.damage * fury),
      });
      return;
    }
    // Slams: about one per two herzies, up to the phase's count, one fewer
    // while its minions are up. The first lands on whoever it's after, the
    // rest on random others.
    const most = Math.min(
      TUNING.scale.maxSlams,
      cfg.slams + Math.floor(this.raidSize / TUNING.scale.perPlayers),
    );
    const expected = Math.min(most, targets.length / 2);
    let n = Math.max(1, weightedRound(expected, this.rand));
    if (this.minionsUp > 0) n = Math.max(1, n - 1);
    const pool = [...targets];
    const first = pool.findIndex((p) => p.uid === this.focusUid);
    const order: BossPlayer[] = [];
    if (first >= 0) order.push(...pool.splice(first, 1));
    while (pool.length)
      order.push(...pool.splice(Math.floor(this.rand() * pool.length), 1));
    for (let i = 0; i < n && i < order.length; i++) {
      const p = order[i];
      const pos = p.posAt(now);
      if (!pos) continue;
      add({
        kind: "circle",
        x: pos.x,
        z: pos.z,
        r: TUNING.slam.radius,
        inner: 0,
        hitAt: now + TUNING.slam.windupMs,
        damage: Math.round(TUNING.slam.damage * fury),
        ...(p.uid === this.focusUid ? { aimedAt: p.uid } : {}),
      });
    }
  }

  /** A charge, on its own clock from phase 2: at whoever keeps furthest
   * off, if anyone's far enough. Not while its own ring winds up. */
  private startCharge(
    now: number,
    targets: readonly BossPlayer[],
    events: BossEvent[],
    fury: number,
  ) {
    const cfg = TUNING.charge;
    if (this.phase < cfg.fromPhase || this.charging || now < this.nextChargeAt)
      return;
    const ringing = this.telegraphs.some(
      (t) => t.mob === undefined && t.kind === "ring" && t.hitAt > now,
    );
    let far: { x: number; z: number } | null = null;
    let best: number = cfg.minDist;
    for (const p of targets) {
      const at = p.posAt(now);
      if (!at) continue;
      const d = Math.hypot(at.x - this.at.x, at.z - this.at.z);
      if (d >= best) {
        best = d;
        far = at;
      }
    }
    if (ringing || !far || !this.room()) {
      this.nextChargeAt = now + 1_000;
      return;
    }
    const yaw = Math.atan2(far.x - this.at.x, far.z - this.at.z);
    // How far its middle goes; the lane runs on by its body, which sweeps
    // ahead of it.
    const len = Math.min(best + cfg.overshoot, wanderReach(this.at, yaw));
    if (len < cfg.minDist * 0.6) {
      // Its circle won't let it get near them from here: try again soon.
      this.nextChargeAt = now + 1_000;
      return;
    }
    this.nextChargeAt = now + Math.round(cfg.everyMs / fury);
    const goAt = now + cfg.windupMs;
    this.charging = {
      from: { ...this.at },
      yaw,
      len,
      goAt,
      endAt: goAt + (len / cfg.speed) * 1000,
    };
    this.strideTo = null;
    const telegraph: Telegraph = {
      id: this.nextId(),
      kind: "lane",
      x: this.at.x,
      z: this.at.z,
      yaw,
      len: len + TUNING.boss.radius,
      r: cfg.width / 2,
      inner: 0,
      at: now,
      hitAt: goAt,
      damage: Math.round(cfg.damage * fury),
    };
    this.telegraphs.push(telegraph);
    events.push({ t: "telegraph", telegraph });
  }

  /** The tank-buster, on its own clock: at its focus. A taunt always
   * draws it; otherwise only once there's a party, at whoever it hates
   * most. */
  private startBuster(
    now: number,
    players: readonly BossPlayer[],
    targets: readonly BossPlayer[],
    events: BossEvent[],
    fury: number,
  ) {
    if (now < this.nextBusterAt) return;
    const cfg = TUNING.buster;
    const taunter = this.taunter(now);
    let target = taunter ? targets.find((p) => p.uid === taunter) : undefined;
    if (!target) {
      const here = players.filter((p) => p.alive).length;
      let hated: BossPlayer | undefined;
      for (const p of targets) {
        if (!hated || this.threatOf(p.uid) > this.threatOf(hated.uid))
          hated = p;
      }
      if (here >= cfg.minPlayers && hated && this.threatOf(hated.uid) > 0)
        target = hated;
    }
    if (!target) {
      this.nextBusterAt = now + 500;
      return;
    }
    this.nextBusterAt = now + Math.round(cfg.everyMs / fury);
    const pos = target.posAt(now) ?? { x: 0, z: 0 };
    const telegraph: Telegraph = {
      id: this.nextId(),
      kind: "buster",
      x: pos.x,
      z: pos.z,
      r: 1.2,
      inner: 0,
      at: now,
      hitAt: now + cfg.windupMs,
      damage: Math.round(cfg.damage * fury),
      target: target.uid,
      aimedAt: target.uid,
    };
    this.telegraphs.push(telegraph);
    events.push({ t: "telegraph", telegraph });
  }

  /** In a big raid: a few herzies marked at once, each mark going off
   * around them. Never on the one tanking, nor on anyone just up. */
  private startScatter(
    now: number,
    targets: readonly BossPlayer[],
    events: BossEvent[],
    fury: number,
  ) {
    const cfg = TUNING.scatter;
    if (this.raidSize < cfg.minPlayers) return;
    if (!this.nextScatterAt) this.nextScatterAt = now + cfg.everyMs;
    if (now < this.nextScatterAt) return;
    this.nextScatterAt = now + Math.round(cfg.everyMs / fury);
    const pool = targets.filter((p) => p.uid !== this.focusUid);
    const marks = Math.min(
      pool.length,
      Math.ceil(this.raidSize / cfg.perMarks),
    );
    for (let i = 0; i < marks; i++) {
      const p = pool.splice(Math.floor(this.rand() * pool.length), 1)[0];
      const pos = p.posAt(now);
      if (!pos) continue;
      const telegraph: Telegraph = {
        id: this.nextId(),
        kind: "scatter",
        x: pos.x,
        z: pos.z,
        r: cfg.radius,
        inner: 0,
        at: now,
        hitAt: now + cfg.windupMs,
        damage: Math.round(cfg.damage * fury),
        target: p.uid,
      };
      this.telegraphs.push(telegraph);
      events.push({ t: "telegraph", telegraph });
    }
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

/** A telegraph's hit on `p`: capped at a share of their health, then Def
 * and their damage-cutting buffs, under the overall clamp. Shared with the
 * minions, so a Thornling's hit is judged exactly like the boss's. */
export function mitigatedHit(
  p: BossPlayer,
  tg: Telegraph,
  buffs: readonly Buff[],
  /** Rattled: a multiplier on the hit, and the cap it may reach. */
  opts: { mult?: number; cap?: number } = {},
): BossHit {
  const raw = Math.min(
    tg.damage * (opts.mult ?? 1),
    (opts.cap ?? MAX_HIT_FRACTION) * p.maxHp,
  );
  const fromBuffs = buffReductions(buffs, tg.hitAt);
  const reductions = [defReduction(p.def ?? 0), ...fromBuffs];
  const damage = Math.max(1, Math.round(mitigate(raw, reductions)));
  const absorbed = Math.max(0, Math.round(raw) - damage);
  // What the Cymbrella took off on top of Def and the other buffs: their
  // hit without it, less this one.
  const cymbrella = activeBuffs(buffs, tg.hitAt).some(
    (b) => b.id === "cymbrella",
  );
  const withoutCymbrella = cymbrella
    ? Math.max(
        1,
        Math.round(
          mitigate(raw, [
            defReduction(p.def ?? 0),
            ...buffReductions(
              buffs.filter((b) => b.id !== "cymbrella"),
              tg.hitAt,
            ),
          ]),
        ),
      )
    : damage;
  const blocked = Math.max(0, withoutCymbrella - damage);
  return {
    uid: p.uid,
    damage,
    absorbed,
    blocked,
    ...(tg.aimedAt === p.uid ? { aimed: true } : {}),
  };
}

/** How much faster a hasted herzie may cast at `now`: its Haste, honoured
 * {@link TUNING.hasteGraceMs} either side, so a client a little ahead or
 * behind the server's clock is never refused a cast it was allowed. */
export function castSpeed(buffs: readonly Buff[], now: number): number {
  const g = TUNING.hasteGraceMs;
  return Math.max(
    attackSpeed(buffs, now),
    attackSpeed(buffs, now - g),
    attackSpeed(buffs, now + g),
  );
}

/** Whether a telegraph covers a point. A buster covers its target, not a
 * place: never by position. */
export function covers(tg: Telegraph, x: number, z: number): boolean {
  if (tg.kind === "buster" || tg.kind === "scatter") return false;
  if (tg.kind === "lane") {
    // Along its line, and within its width either side (a herzie's own
    // radius counts: brushed by it is hit).
    const yaw = tg.yaw ?? 0;
    const dx = x - tg.x;
    const dz = z - tg.z;
    const along = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const across = Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw));
    return (
      along >= -TUNING.boss.radius &&
      along <= (tg.len ?? 0) + TUNING.playerRadius &&
      across <= tg.r + TUNING.playerRadius
    );
  }
  const d = Math.hypot(x - tg.x, z - tg.z);
  return d <= tg.r && d >= tg.inner;
}
