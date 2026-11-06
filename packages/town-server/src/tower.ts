/**
 * The Tower's floors. Pure and deterministic like `BossEngine` (a seeded
 * RNG, an injected clock), and shaped like it — the same casts, telegraphs
 * and resolves — so `FightRuntime` runs a floor just as it runs the boss:
 * health, knock-outs, skills, eating and reports all come for free.
 *
 * Each floor is a {@link MobPack} of Thornlings (see mobs.ts for what they
 * do); this file is the floors themselves: one pack after another, the
 * herzie's casts, and "cleared" once the last mob falls. No breather
 * after a hit here: every attack that lands, lands.
 * Linger past a floor's par time and its mobs enrage.
 */

import type { AttackStyle } from "@herzies/shared/classes";
import {
  aimDirection,
  DISC_DAMAGE,
  DISC_RANGE,
  discLandsAfterMs,
  type HitStats,
  STRIKE_DAMAGE,
  WAVE_SPEED,
} from "@herzies/shared/combat";
import {
  activeBuffs,
  applyBuff,
  BACKSPIN_DISCS,
  BACKSPIN_SPREAD,
  type Buff,
  buffMultiplier,
  RIMSHOT,
  shuffleOn,
} from "@herzies/shared/skills";
import { timingAttackSpeed } from "@herzies/shared/stats";
import { towerMob } from "@herzies/shared/tower";
import type { TowerFloor, TowerMob } from "@herzies/shared/town-net";
import {
  type BossEvent,
  type BossPlayer,
  castSpeed,
  type Phase,
  rng,
  type ShelterDome,
  type Telegraph,
  TUNING,
} from "./boss";
import { DiscHands } from "./hands";
import { type MobJudge, MobPack, SEEN_LAG_MS, type TowerArena } from "./mobs";

export { predict, SEEN_LAG_MS, type TowerArena } from "./mobs";

/** The Tower's extra events, beside the boss's. */
export type TowerEvent =
  | BossEvent
  | { t: "mobDown"; mob: number; by: string; x: number; z: number }
  | { t: "cleared"; floor: number };

export class TowerEngine {
  private readonly pack: MobPack;
  private cleared = false;
  private casts = new Map<string, { tokens: number; at: number }>();
  /** A Slinger's discs: a hand throws once its disc is back. */
  private hands = new DiscHands();
  private safeUntil = new Map<string, number>();
  private buffs = new Map<string, Buff[]>();
  /** Cymbrella domes standing (or about to). */
  private domes: ShelterDome[] = [];
  /** For a Rimshot's stun (apart from the pack's own rolls). */
  private readonly rand: () => number;
  private readonly judge: MobJudge = {
    safe: (uid, t) => (this.safeUntil.get(uid) ?? 0) > t,
    invuln: () => false,
    hitAt: () => {},
    buffs: (uid) => this.buffs.get(uid) ?? [],
  };

  constructor(
    opts: {
      floor: number;
      level: number;
      seed: number;
      now: number;
    },
    arena: TowerArena,
  ) {
    let id = 1;
    this.pack = new MobPack(
      {
        floor: opts.floor,
        level: opts.level,
        now: opts.now,
        rand: rng(opts.seed),
        nextId: () => id++,
      },
      arena,
    );
    this.pack.domes = () => this.domes;
    this.rand = rng(opts.seed + 7_919);
    this.pack.spawnFloor(opts.now);
  }

  /** The floor being fought. */
  get floor(): number {
    return this.pack.floor;
  }

  /** The herzie's level, against the floor's for the level gap. Kept up to
   * date from their tickets (they level up by listening meanwhile). */
  get level(): number {
    return this.pack.level;
  }
  set level(level: number) {
    this.pack.level = Math.max(1, Math.floor(level));
  }

  // --- What FightRuntime reads off an engine.

  /** The floor's mobs' health, all together. */
  get hp(): number {
    return this.pack.hp;
  }
  get maxHp(): number {
    return this.pack.maxHp;
  }
  get currentPhase(): Phase {
    return 1;
  }
  get dead(): boolean {
    return false;
  }
  get active(): readonly Telegraph[] {
    return this.pack.active;
  }
  get isCleared(): boolean {
    return this.cleared;
  }

  /** The floor as the wire carries it. */
  view(): TowerFloor {
    return {
      floor: this.floor,
      level: towerMob(this.floor).level,
      you: this.level,
      mobs: this.wireMobs(),
      cleared: this.cleared,
      enrageIn: Math.max(0, Math.round(this.pack.enrageAt - this.pack.now)),
    };
  }

  /** Whether the floor's mobs have enraged. */
  enragedAt(now: number): boolean {
    return !this.cleared && this.pack.enragedAt(now);
  }

  wireMobs(): TowerMob[] {
    return this.pack.wire();
  }

  /** Only the mobs that changed since the last call. */
  wireMobsChanged(): TowerMob[] {
    return this.pack.wireChanged();
  }

  noteSpawn(uid: string, now: number): void {
    this.safeUntil.set(uid, now + TUNING.spawnSafeMs);
  }

  forget(uid: string): void {
    this.casts.delete(uid);
    this.hands.forget(uid);
    this.safeUntil.delete(uid);
    this.buffs.delete(uid);
  }

  /** Mobs hate everyone the same: nothing to keep. */
  addThreat(_uid: string, _amount: number): void {}

  buff(uid: string, next: Buff, now?: number): Buff {
    const list = applyBuff(this.buffs.get(uid) ?? [], next, now);
    this.buffs.set(uid, list);
    return list.find((b) => b.id === next.id) as Buff;
  }

  /** `uid` loses its buff `id` now. Whether it had one. */
  clearBuff(uid: string, id: Buff["id"]): boolean {
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

  activeBuffs(now: number): { uid: string; buff: Buff }[] {
    const out: { uid: string; buff: Buff }[] = [];
    for (const [uid, list] of this.buffs)
      for (const buff of activeBuffs(list, now)) out.push({ uid, buff });
    return out;
  }

  // --- Floors.

  /** On to the next floor, if this one's cleared. */
  next(now: number): boolean {
    if (!this.cleared) return false;
    this.pack.floor++;
    this.cleared = false;
    this.pack.spawnFloor(now);
    return true;
  }

  // --- Your side: casts.

  /** A cast, like {@link BossEngine.cast}: it finds the nearest mob along
   * the aim (as the player saw them) and lands after its flight time; a
   * melee blow strikes every mob in front of it at once. */
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
    if (!this.spendCast(uid, now, stats.timing)) return "cooldown";
    const seen = now - SEEN_LAG_MS;
    if (attack === "melee") {
      const struck = this.pack.inReach(from, yaw, seen);
      const boost = this.damageMult(uid, now);
      for (const m of struck)
        this.pack.queue(uid, m, now, stats, melee * boost);
      return struck.length ? "hit" : "miss";
    }
    const disc = attack === "disc";
    const target = this.pack.along(
      from,
      aimDirection(yaw, pitch),
      seen,
      disc ? DISC_RANGE : undefined,
    );
    // Both discs out: see BossEngine.cast.
    if (
      disc &&
      !this.hands.take(
        uid,
        now,
        target?.dist ?? null,
        // As quick as the app flies it: Haste and Timing both.
        castSpeed(this.buffs.get(uid) ?? [], now) *
          (1 + timingAttackSpeed(stats.timing ?? 0)),
      )
    )
      return "miss";
    if (!target) return "miss";
    const flight = disc
      ? discLandsAfterMs(target.dist)
      : (target.dist / WAVE_SPEED) * 1000;
    const mult = (disc ? DISC_DAMAGE : 1) * this.damageMult(uid, now);
    this.pack.queue(uid, target.mob, now + flight, stats, mult);
    // Under a Shuffle, it bounces on through the pack.
    if (disc)
      this.pack.bounceOn(
        uid,
        target.mob,
        now + flight,
        seen,
        shuffleOn(this.buffs.get(uid) ?? [], now),
        stats,
        mult,
      );
    return "hit";
  }

  /** A Cymbrella: a dome of `by`'s at (x, z) from `now`, for `ms`. */
  addDome(by: string, x: number, z: number, now: number, ms: number): void {
    this.domes.push({ x, z, from: now, until: now + ms, by });
  }

  /** The domes standing at `now`. */
  domesAt(now: number): ShelterDome[] {
    return this.domes.filter((d) => d.from <= now && d.until > now);
  }

  /** Rimshot lands, like {@link BossEngine.rimshot}: every mob within
   * RIMSHOT.radius of `at`, each rolling its own stun. */
  rimshot(
    uid: string,
    at: { x: number; z: number },
    stats: HitStats,
    chance: number,
    now: number,
  ): { hit: number; stunned: number } {
    let hit = 0;
    let stunned = 0;
    for (const m of this.pack.within(at, RIMSHOT.radius, now - SEEN_LAG_MS)) {
      this.pack.queue(
        uid,
        m,
        now,
        stats,
        RIMSHOT.damage * STRIKE_DAMAGE * this.damageMult(uid, now),
        "rimshot",
      );
      hit++;
      if (this.rand() < chance && this.pack.stun(m, now, RIMSHOT.stunMs))
        stunned++;
    }
    return { hit, stunned };
  }

  /** Backspin: three discs fanned about the aim, each at `mult` of a
   * wave. */
  backspin(
    uid: string,
    from: { x: number; z: number },
    yaw: number,
    pitch: number,
    stats: HitStats,
    mult: number,
    now: number,
  ): number {
    let landed = 0;
    const half = (BACKSPIN_DISCS - 1) / 2;
    for (let i = 0; i < BACKSPIN_DISCS; i++) {
      const dir = aimDirection(yaw + (i - half) * BACKSPIN_SPREAD, pitch);
      // Discs: a disc's reach and flight, as they're drawn.
      const target = this.pack.along(from, dir, now - SEEN_LAG_MS, DISC_RANGE);
      if (!target) continue;
      this.pack.queue(
        uid,
        target.mob,
        now + discLandsAfterMs(target.dist),
        stats,
        mult * this.damageMult(uid, now),
        "backspin",
      );
      landed++;
    }
    return landed;
  }

  /** How much harder `uid` hits right now (an in-tune Record Slinger), as
   * in the boss's cave: in tune means the same everywhere. */
  private damageMult(uid: string, now: number): number {
    return buffMultiplier(this.buffs.get(uid) ?? [], "damage", now);
  }

  /** A cast's token (a heal bolt spends one too); see BossEngine's. */
  spendCast(uid: string, now: number, timing = 0): boolean {
    const bucket = this.casts.get(uid) ?? {
      tokens: TUNING.castBurst,
      at: now,
    };
    bucket.tokens = Math.min(
      TUNING.castBurst,
      bucket.tokens +
        (Math.max(0, now - bucket.at) / TUNING.castEveryMs) *
          castSpeed(this.buffs.get(uid) ?? [], now) *
          (1 + timingAttackSpeed(timing)),
    );
    bucket.at = now;
    this.casts.set(uid, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // --- Time passing.

  update(now: number, players: readonly BossPlayer[]): TowerEvent[] {
    this.domes = this.domes.filter((d) => d.until > now);
    const events: TowerEvent[] = this.pack.update(now, players, this.judge);
    if (!this.cleared && this.pack.size > 0 && !this.pack.alive.length) {
      this.cleared = true;
      this.pack.clearPending();
      events.push({ t: "cleared", floor: this.floor });
    }
    return events;
  }
}
