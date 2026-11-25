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
 * A Warden's floor, cleared, leaves a chest (TOWER_CHEST) that opens when
 * the herzie presses E by it (openChestAt: "chest"); what's in it is
 * `town-vitals`' to roll, like a kill's drop. A climb's boons (picked by
 * FightRuntime) quicken, strengthen and toughen its herzie here.
 */

import type { AttackStyle } from "@herzies/shared/classes";
import {
  aimDirection,
  DISC_DAMAGE,
  DISC_RANGE,
  discLandsAfterMs,
  type HitStats,
  MELEE_CLEAVE,
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
  CYMBAL_TRAP,
  cymbalLandsAfterMs,
  MULTISPIN,
  RIMSHOT,
  SILENCIO,
  SKILL_DEFS,
  shuffleOn,
  skillValue,
} from "@herzies/shared/skills";
import {
  isChestFloor,
  TOWER_CHEST,
  type TowerBoonId,
  towerMob,
} from "@herzies/shared/tower";
import type { TowerFloor, TowerMob } from "@herzies/shared/town-net";
import { BLEED_SKILLS, type BleedSkill, Bleeds, bleedTag } from "./bleed";
import {
  type BossEvent,
  type BossPlayer,
  type Phase,
  quickness,
  rng,
  type ShelterDome,
  type Telegraph,
  TUNING,
} from "./boss";
import { CastBudget } from "./budgets";
import { DiscHands } from "./hands";
import { type MobJudge, MobPack, SEEN_LAG_MS, type TowerArena } from "./mobs";
import type { SpinBody } from "./spin";
import { LOOT_REACH_SLACK } from "./wilds-loot";

export { predict, SEEN_LAG_MS, type TowerArena } from "./mobs";

/** The Tower's extra events, beside the boss's. */
export type TowerEvent =
  | BossEvent
  | { t: "mobDown"; mob: number; by: string; x: number; z: number }
  | { t: "cleared"; floor: number }
  /** A cleared floor's chest opened, standing at (x, z). */
  | { t: "chest"; floor: number; x: number; z: number };

export class TowerEngine {
  private readonly pack: MobPack;
  private cleared = false;
  /** The cleared floor's chest, while it stands shut, and from when it
   * may open (TOWER_CHEST.settleMs after it lands). */
  private chest: { x: number; z: number } | null = null;
  private chestFrom = 0;
  private casts = new CastBudget(TUNING.castEveryMs, TUNING.castBurst);
  /** A Slinger's discs: a hand throws once its disc is back. */
  private hands = new DiscHands();
  private safeUntil = new Map<string, number>();
  private buffs = new Map<string, Buff[]>();
  /** Cymbrella domes standing (or about to). */
  private domes: ShelterDome[] = [];
  /** Bleeds by mob id: Forbidden Frequency's discs and bleeds (a minute
   * each), and Silencio's (one stack each). */
  private bleeds: Record<BleedSkill, Bleeds> = {
    "forbidden-frequency": new Bleeds(
      SKILL_DEFS["forbidden-frequency"].durationMs ?? 0,
    ),
    silencio: new Bleeds(SKILL_DEFS.silencio.durationMs ?? 0, 1),
  };
  /** Each herzie's climb's boons, added up (towerBoonTotals). */
  private boons = new Map<string, Record<TowerBoonId, number>>();
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
    // A climb's executioner boons: harder on a mob under a third of its
    // health. Its thorns: a mob that hits the herzie takes a share back.
    this.pack.landBoost = (uid, m) =>
      m.hp < m.maxHp / 3 ? 1 + (this.boons.get(uid)?.executioner ?? 0) : 1;
    this.pack.struck = (uid, m, damage, at) => {
      const thorns = this.boons.get(uid)?.thorns ?? 0;
      if (thorns > 0 && m.hp > 0) this.pack.strike(uid, m, at, damage * thorns);
    };
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
      ...(this.chest ? { chest: this.chest } : {}),
    };
  }

  /** Opens the floor's chest if one stands shut (the herzie going on
   * without it): what it was, or null. */
  openChest(): Extract<TowerEvent, { t: "chest" }> | null {
    const at = this.chest;
    if (!at) return null;
    this.chest = null;
    return { t: "chest", floor: this.floor, x: at.x, z: at.z };
  }

  /** E pressed at `at`: the chest opens if it's landed (settleMs) and
   * within TOWER_CHEST.reach, give or take the room's slack. */
  openChestAt(
    at: { x: number; z: number },
    now: number,
  ): Extract<TowerEvent, { t: "chest" }> | null {
    const chest = this.chest;
    if (!chest || now < this.chestFrom) return null;
    if (
      Math.hypot(at.x - chest.x, at.z - chest.z) >
      TOWER_CHEST.reach + LOOT_REACH_SLACK
    )
      return null;
    return this.openChest();
  }

  /** `uid`'s climb's boons, added up (towerBoonTotals): its attacks
   * quicker and harder here, executioner and thorns (its Def, crit and
   * cooldowns are FightRuntime's). */
  setBoons(uid: string, totals: Record<TowerBoonId, number>): void {
    this.boons.set(uid, totals);
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
    this.casts.forget(uid);
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

  /** On to the next floor, if this one's cleared. A chest still shut is
   * left behind: open it first (FightRuntime.next does). */
  next(now: number): boolean {
    if (!this.cleared) return false;
    this.pack.floor++;
    this.cleared = false;
    this.chest = null;
    for (const skill of BLEED_SKILLS) this.bleeds[skill].clear();
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
      // The nearest in full, the rest of the cleave a share (MELEE_CLEAVE).
      for (const [i, m] of struck.entries())
        this.pack.queue(
          uid,
          m,
          now,
          stats,
          melee * boost * (i === 0 ? 1 : MELEE_CLEAVE),
        );
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
        this.quickness(uid, now, stats.timing),
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

  /** Cymbal Trap, like {@link BossEngine.cymbalTrap}: the first mob along
   * the aim within CYMBAL_TRAP.range takes the blow when it gets there,
   * and is held where it stands for `holdMs` (MobPack.root). */
  cymbalTrap(
    uid: string,
    from: { x: number; z: number },
    yaw: number,
    pitch: number,
    stats: HitStats,
    holdMs: number,
    now: number,
  ): boolean {
    const target = this.pack.along(
      from,
      aimDirection(yaw, pitch),
      now - SEEN_LAG_MS,
      CYMBAL_TRAP.range,
    );
    if (!target) return false;
    this.pack.queue(
      uid,
      target.mob,
      now + cymbalLandsAfterMs(target.dist),
      stats,
      CYMBAL_TRAP.damage * STRIKE_DAMAGE * this.damageMult(uid, now),
      "cymbal-trap",
      holdMs,
    );
    return true;
  }

  /** What a Multispin's records may touch now: every mob's body, as
   * {@link BossEngine.spinBodies}. */
  spinBodies(now: number): SpinBody[] {
    return this.pack.bodies(now - SEEN_LAG_MS);
  }

  /** A Multispin's record touched mob `key`: MULTISPIN.damage of a wave,
   * now. */
  spinHit(uid: string, key: string, stats: HitStats, now: number): void {
    const mob = this.pack.byId(Number(key));
    if (!mob) return;
    this.pack.queue(
      uid,
      mob,
      now,
      stats,
      MULTISPIN.damage * this.damageMult(uid, now),
      "multispin",
    );
  }

  /** Forbidden Frequency, like {@link BossEngine.forbiddenFrequency}: a
   * disc to the first mob along the aim; a bleed takes hold where it
   * lands. */
  forbiddenFrequency(
    uid: string,
    from: { x: number; z: number },
    yaw: number,
    pitch: number,
    stats: HitStats,
    level: number,
    now: number,
  ): boolean {
    const target = this.pack.along(
      from,
      aimDirection(yaw, pitch),
      now - SEEN_LAG_MS,
      DISC_RANGE,
    );
    if (!target) return false;
    this.bleeds["forbidden-frequency"].throw({
      at: now + discLandsAfterMs(target.dist),
      by: uid,
      key: String(target.mob.id),
      level,
      stats,
    });
    return true;
  }

  /** Silencio bursts at `at`, like {@link BossEngine.silencio}: every mob
   * whose body is within SILENCIO.radius bleeds, and is shoved out before
   * its wave. How many it caught. */
  silencio(
    uid: string,
    at: { x: number; z: number },
    stats: HitStats,
    level: number,
    now: number,
  ): number {
    const caught = this.pack.within(at, SILENCIO.radius, now - SEEN_LAG_MS);
    for (const m of caught)
      this.bleeds.silencio.throw({
        at: now,
        by: uid,
        key: String(m.id),
        level,
        stats,
      });
    this.pack.wave(at, now);
    return caught.length;
  }

  /** Bleeds that arrived take hold on mobs still standing, and bleeds
   * tick (see BossEngine's). */
  private stepBleeds(now: number, events: TowerEvent[]) {
    for (const skill of BLEED_SKILLS) {
      const bleeds = this.bleeds[skill];
      for (const d of bleeds.landed(now)) {
        if (!this.pack.byId(Number(d.key))) continue;
        const b = bleeds.stack(d, now);
        events.push({
          t: "bleed",
          uid: b.by,
          mob: Number(d.key),
          ...bleedTag(skill),
          stacks: b.stacks,
          until: b.until,
        });
      }
      for (const { key, bleed: b } of bleeds.ticks(now)) {
        const mob = this.pack.byId(Number(key));
        if (!mob) continue;
        this.pack.queue(
          b.by,
          mob,
          now,
          { ...b.stats, critChance: 0 },
          skillValue(skill, b.level) * this.damageMult(b.by, now),
          skill,
        );
      }
    }
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

  /** How much harder `uid` hits right now: an in-tune Record Slinger, a
   * Rage (as in the boss's cave), and its climb's damage boons. */
  private damageMult(uid: string, now: number): number {
    return (
      buffMultiplier(this.buffs.get(uid) ?? [], "damage", now) *
      (1 + (this.boons.get(uid)?.damage ?? 0))
    );
  }

  /** How quick `uid`'s attacks are now (quickness), its climb's speed
   * boons on top. */
  private quickness(uid: string, now: number, timing = 0): number {
    return (
      quickness(this.buffs.get(uid) ?? [], now, timing) *
      (1 + (this.boons.get(uid)?.speed ?? 0))
    );
  }

  /** A cast's token (a heal bolt spends one too); see BossEngine's. */
  spendCast(uid: string, now: number, timing = 0): boolean {
    return this.casts.spend(uid, now, this.quickness(uid, now, timing));
  }

  // --- Time passing.

  update(now: number, players: readonly BossPlayer[]): TowerEvent[] {
    this.domes = this.domes.filter((d) => d.until > now);
    const events: TowerEvent[] = [];
    // Bleeds tick first, so their hits land this update.
    this.stepBleeds(now, events);
    for (const ev of this.pack.update(now, players, this.judge)) {
      events.push(ev);
      if (ev.t !== "mobDown") continue;
      for (const skill of BLEED_SKILLS) {
        const b = this.bleeds[skill].end(String(ev.mob));
        if (b)
          events.push({
            t: "bleed",
            uid: b.by,
            mob: ev.mob,
            ...bleedTag(skill),
            stacks: 0,
            until: now,
          });
      }
    }
    if (!this.cleared && this.pack.size > 0 && !this.pack.alive.length) {
      this.cleared = true;
      this.pack.clearPending();
      if (isChestFloor(this.floor)) {
        this.chest = TOWER_CHEST.at;
        this.chestFrom = now + TOWER_CHEST.settleMs;
      }
      events.push({ t: "cleared", floor: this.floor });
    }
    return events;
  }
}
