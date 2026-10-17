/**
 * The Tower's floors: the mobs, what they do, and what hits them. Pure and
 * deterministic like `BossEngine` (a seeded RNG, an injected clock), and
 * shaped like it — the same casts, telegraphs and resolves — so
 * `FightRuntime` runs a floor just as it runs the boss: health, knock-outs,
 * skills, eating and reports all come for free.
 *
 * Mobs are always aggressive: each walks at the nearest herzie and, once in
 * reach, stops and winds up a swing whose shape is on the ground for
 * {@link MOB_SWING}.windupMs before it lands. A swing is judged like the
 * boss's slams (in the shape now *and* a moment ago, a breather after a hit,
 * never more than a share of your health), and its damage follows the
 * floor and the level gap.
 *
 * The client draws mobs a little behind where they are here, so a cast is
 * judged against where they stood {@link SEEN_LAG_MS} ago, and a little
 * wider than they are.
 */

import type { AttackStyle } from "@herzies/shared/classes";
import {
  aimDirection,
  type Body,
  bodyHitAt,
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
  BACKSPIN_DISCS,
  BACKSPIN_SPREAD,
  type Buff,
  mitigate,
} from "@herzies/shared/skills";
import { defReduction } from "@herzies/shared/stats";
import {
  FLOOR_OPENING_MS,
  levelGapMods,
  MOB,
  MOB_SWING,
  mobsOnFloor,
  towerMob,
} from "@herzies/shared/tower";
import type { TowerFloor, TowerMob } from "@herzies/shared/town-net";
import {
  type BossEvent,
  type BossPlayer,
  MAX_HIT_FRACTION,
  type Phase,
  rng,
  type Telegraph,
  TUNING,
} from "./boss";

/** How far behind the server the client draws mobs (its interpolation
 * delay, about), so casts are judged against what the player saw. */
export const SEEN_LAG_MS = 120;
/** Casts find a mob this much wider than its body: it moves, and the
 * client's picture of it is a moment old. */
const HIT_SLACK = 0.3;
/** How much of a mob's path is kept, for judging casts in the past. */
const TRAIL_MS = 600;

/** Where mobs may stand: inside the island, clear of its wooded edge. */
export type TowerArena = {
  /** The walkable radius (TOWN_MAPS). */
  radius: number;
  /** Where herzies arrive: mobs start well away from it. */
  entry: { x: number; z: number };
};

type MobState = "idle" | "chase" | "windup" | "recover";

type Mob = {
  id: number;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  state: MobState;
  /** When the current windup lands, or the recovery ends (server ms). */
  until: number;
  /** Where it was, newest last, for judging casts in the past. */
  trail: { t: number; x: number; z: number }[];
};

type PendingHit = {
  at: number;
  uid: string;
  mob: number;
  damage: number;
  crit: boolean;
  skill?: string;
};

/** The Tower's extra events, beside the boss's. */
export type TowerEvent =
  | BossEvent
  | { t: "mobDown"; mob: number; by: string; x: number; z: number }
  | { t: "cleared"; floor: number };

export class TowerEngine {
  floor: number;
  /** The herzie's level, against the floor's for the level gap. Kept up to
   * date from their tickets (they level up by listening meanwhile). */
  level: number;
  private mobs: Mob[] = [];
  private telegraphs: Telegraph[] = [];
  private pending: PendingHit[] = [];
  private nextId = 1;
  private nextMobId = 1;
  private wakeAt = 0;
  private cleared = false;
  private casts = new Map<string, { tokens: number; at: number }>();
  private invulnUntil = new Map<string, number>();
  private safeUntil = new Map<string, number>();
  private buffs = new Map<string, Buff[]>();
  private readonly rand: () => number;
  private lastAt: number;

  constructor(
    opts: {
      floor: number;
      level: number;
      seed: number;
      now: number;
    },
    private readonly arena: TowerArena,
  ) {
    this.floor = Math.max(1, Math.floor(opts.floor));
    this.level = Math.max(1, Math.floor(opts.level));
    this.rand = rng(opts.seed);
    this.lastAt = opts.now;
    this.spawn(opts.now);
  }

  // --- What FightRuntime reads off an engine.

  /** The floor's mobs' health, all together. */
  get hp(): number {
    return this.mobs.reduce((n, m) => n + m.hp, 0);
  }
  get maxHp(): number {
    return Math.max(
      1,
      this.mobs.reduce((n, m) => n + m.maxHp, 0),
    );
  }
  get currentPhase(): Phase {
    return 1;
  }
  get dead(): boolean {
    return false;
  }
  get active(): readonly Telegraph[] {
    return this.telegraphs;
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
    };
  }

  wireMobs(): TowerMob[] {
    return this.mobs
      .filter((m) => m.hp > 0)
      .map((m) => ({
        id: m.id,
        x: round(m.x),
        z: round(m.z),
        yaw: round(m.yaw),
        hp: m.hp,
        maxHp: m.maxHp,
        s: m.state === "windup" ? 1 : 0,
      }));
  }

  noteSpawn(uid: string, now: number): void {
    this.safeUntil.set(uid, now + TUNING.spawnSafeMs);
  }

  forget(uid: string): void {
    this.casts.delete(uid);
    this.invulnUntil.delete(uid);
    this.safeUntil.delete(uid);
    this.buffs.delete(uid);
  }

  /** Mobs hate everyone the same: nothing to keep. */
  addThreat(_uid: string, _amount: number): void {}

  buff(uid: string, next: Buff): Buff {
    const list = applyBuff(this.buffs.get(uid) ?? [], next);
    this.buffs.set(uid, list);
    return list.find((b) => b.id === next.id) as Buff;
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
    this.floor++;
    this.spawn(now);
    return true;
  }

  private spawn(now: number) {
    const { hp } = towerMob(this.floor);
    const n = mobsOnFloor(this.floor);
    this.mobs = [];
    this.telegraphs = [];
    this.pending = [];
    this.cleared = false;
    this.wakeAt = now + FLOOR_OPENING_MS;
    const { entry, radius } = this.arena;
    // Far from the entry: on the far side of the middle, spread out.
    const away = Math.atan2(-entry.x, -entry.z);
    // In the open meadow: the wooded rim (past about 13) is the client's
    // trees, which mobs here know nothing of.
    const r = Math.min(radius - 4, 12);
    for (let i = 0; i < n; i++) {
      let x = 0;
      let z = 0;
      for (let tries = 0; tries < 20; tries++) {
        const a = away + (this.rand() - 0.5) * 1.6;
        const d = r * (0.3 + 0.7 * this.rand());
        x = Math.sin(a) * d;
        z = Math.cos(a) * d;
        if (this.mobs.every((m) => Math.hypot(m.x - x, m.z - z) > 2.2)) break;
      }
      this.mobs.push({
        id: this.nextMobId++,
        x,
        z,
        yaw: Math.atan2(entry.x - x, entry.z - z),
        hp,
        maxHp: hp,
        state: "idle",
        until: 0,
        trail: [{ t: now, x, z }],
      });
    }
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
    if (!this.takeCast(uid, now)) return "cooldown";
    const seen = now - SEEN_LAG_MS;
    if (attack === "melee") {
      let landed = false;
      for (const m of this.alive()) {
        const at = this.seenAt(m, seen);
        if (
          !meleeReaches(
            from,
            yaw,
            { x: at.x, z: at.z, radius: MOB.radius + HIT_SLACK },
            MELEE_REACH + TUNING.meleeSlack,
          )
        )
          continue;
        this.queue(uid, m, now, stats, melee);
        landed = true;
      }
      return landed ? "hit" : "miss";
    }
    const disc = attack === "disc";
    const target = this.along(
      from,
      aimDirection(yaw, pitch),
      seen,
      disc ? DISC_RANGE : undefined,
    );
    if (!target) return "miss";
    const flight = disc
      ? discLandsAfterMs(target.dist)
      : (target.dist / WAVE_SPEED) * 1000;
    this.queue(uid, target.mob, now + flight, stats, disc ? DISC_DAMAGE : 1);
    return "hit";
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
      const target = this.along(from, dir, now - SEEN_LAG_MS);
      if (!target) continue;
      this.queue(
        uid,
        target.mob,
        now + (target.dist / WAVE_SPEED) * 1000,
        stats,
        mult,
        "backspin",
      );
      landed++;
    }
    return landed;
  }

  private takeCast(uid: string, now: number): boolean {
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
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** The nearest mob a ray from (x, z) at hand height finds, as they stood
   * at `seen`. */
  private along(
    from: { x: number; z: number },
    dir: [number, number, number],
    seen: number,
    range?: number,
  ): { mob: Mob; dist: number } | null {
    let best: { mob: Mob; dist: number } | null = null;
    for (const m of this.alive()) {
      const at = this.seenAt(m, seen);
      const body: Body = {
        x: at.x,
        z: at.z,
        radius: MOB.radius + HIT_SLACK,
        chest: MOB.chest,
        top: MOB.top,
      };
      const dist = bodyHitAt(
        [from.x, WAVE_HAND_HEIGHT, from.z],
        dir,
        body,
        range,
      );
      if (dist !== null && (!best || dist < best.dist)) best = { mob: m, dist };
    }
    return best;
  }

  private queue(
    uid: string,
    mob: Mob,
    at: number,
    stats: HitStats,
    mult: number,
    skill?: string,
  ) {
    const { amount, crit } = hitDamage(stats, this.rand);
    const { dealt } = levelGapMods(towerMob(this.floor).level - this.level);
    this.pending.push({
      at,
      uid,
      mob: mob.id,
      damage: Math.max(1, Math.round(amount * mult * dealt)),
      crit,
      ...(skill ? { skill } : {}),
    });
  }

  // --- Time passing.

  update(now: number, players: readonly BossPlayer[]): TowerEvent[] {
    const events: TowerEvent[] = [];
    const dt = Math.min(0.25, Math.max(0, now - this.lastAt) / 1000);
    this.lastAt = now;
    this.land(now, events);
    this.resolveDue(now, players, events);
    if (now >= this.wakeAt) this.act(now, dt, players, events);
    for (const m of this.mobs) {
      m.trail.push({ t: now, x: m.x, z: m.z });
      while (m.trail.length > 2 && m.trail[1].t < now - TRAIL_MS)
        m.trail.shift();
    }
    return events;
  }

  private land(now: number, events: TowerEvent[]) {
    if (!this.pending.length) return;
    this.pending.sort((a, b) => a.at - b.at);
    while (this.pending.length && this.pending[0].at <= now) {
      const p = this.pending.shift() as PendingHit;
      const m = this.mobs.find((x) => x.id === p.mob);
      if (!m || m.hp <= 0) continue;
      m.hp = Math.max(0, m.hp - p.damage);
      events.push({
        t: "hit",
        uid: p.uid,
        damage: p.damage,
        crit: p.crit,
        hp: m.hp,
        mob: m.id,
        ...(p.skill ? { skill: p.skill } : {}),
      });
      // Hit while idle: it notices.
      if (m.state === "idle") m.state = "chase";
      if (m.hp > 0) continue;
      // Its swing dies with it: off the ground, landing on no one.
      for (const t of this.telegraphs)
        if (t.mob === m.id) events.push({ t: "resolve", id: t.id, hits: [] });
      this.telegraphs = this.telegraphs.filter((t) => t.mob !== m.id);
      events.push({ t: "mobDown", mob: m.id, by: p.uid, x: m.x, z: m.z });
      if (!this.cleared && this.alive().length === 0) {
        this.cleared = true;
        this.pending = [];
        events.push({ t: "cleared", floor: this.floor });
      }
    }
  }

  private act(
    now: number,
    dt: number,
    players: readonly BossPlayer[],
    events: TowerEvent[],
  ) {
    const targets = players.flatMap((p) => {
      if (!p.alive) return [];
      const at = p.posAt(now);
      return at ? [{ p, at }] : [];
    });
    const { damage } = towerMob(this.floor);
    const { taken } = levelGapMods(towerMob(this.floor).level - this.level);
    for (const m of this.alive()) {
      if (m.state === "windup" || (m.state === "recover" && now < m.until))
        continue;
      let near: (typeof targets)[number] | null = null;
      let best = Number.POSITIVE_INFINITY;
      for (const t of targets) {
        const d = Math.hypot(t.at.x - m.x, t.at.z - m.z);
        if (d < best) {
          best = d;
          near = t;
        }
      }
      if (!near) {
        m.state = "idle";
        continue;
      }
      m.state = "chase";
      m.yaw = Math.atan2(near.at.x - m.x, near.at.z - m.z);
      const safe = (this.safeUntil.get(near.p.uid) ?? 0) > now;
      if (best <= MOB.reach && !safe) {
        // Stop and wind up: the shape goes down in front of it.
        const hitAt = now + MOB_SWING.windupMs;
        m.state = "windup";
        m.until = hitAt;
        const telegraph: Telegraph = {
          id: this.nextId++,
          kind: "circle",
          x: m.x + Math.sin(m.yaw) * MOB_SWING.ahead,
          z: m.z + Math.cos(m.yaw) * MOB_SWING.ahead,
          r: MOB_SWING.radius,
          inner: 0,
          at: now,
          hitAt,
          damage: Math.round(damage * taken),
          mob: m.id,
        };
        this.telegraphs.push(telegraph);
        events.push({ t: "telegraph", telegraph });
        continue;
      }
      this.walk(m, near.at, dt);
    }
  }

  /** A step toward `to`, kept off the others and on the island. */
  private walk(m: Mob, to: { x: number; z: number }, dt: number) {
    let dx = to.x - m.x;
    let dz = to.z - m.z;
    const d = Math.hypot(dx, dz);
    // Close enough: hold here rather than push into you.
    if (d <= MOB.reach * 0.8) return;
    dx /= d;
    dz /= d;
    // Make room for each other.
    for (const o of this.alive()) {
      if (o === m) continue;
      const ox = m.x - o.x;
      const oz = m.z - o.z;
      const od = Math.hypot(ox, oz);
      if (od > 0 && od < MOB.spacing) {
        dx += (ox / od) * (1 - od / MOB.spacing) * 1.5;
        dz += (oz / od) * (1 - od / MOB.spacing) * 1.5;
      }
    }
    const len = Math.hypot(dx, dz) || 1;
    const step = Math.min(MOB.speed * dt, d - MOB.reach * 0.8);
    m.x += (dx / len) * step;
    m.z += (dz / len) * step;
    const r = this.arena.radius - 1;
    const out = Math.hypot(m.x, m.z);
    if (out > r) {
      m.x *= r / out;
      m.z *= r / out;
    }
  }

  private resolveDue(
    now: number,
    players: readonly BossPlayer[],
    events: TowerEvent[],
  ) {
    const due = this.telegraphs.filter((t) => t.hitAt <= now);
    if (!due.length) return;
    this.telegraphs = this.telegraphs.filter((t) => t.hitAt > now);
    for (const tg of due) {
      const hits: {
        uid: string;
        damage: number;
        absorbed: number;
        blocked: number;
      }[] = [];
      for (const p of players) {
        if (!p.alive) continue;
        if ((this.safeUntil.get(p.uid) ?? 0) > tg.hitAt) continue;
        if ((this.invulnUntil.get(p.uid) ?? 0) > tg.hitAt) continue;
        const inside = [tg.hitAt, tg.hitAt - TUNING.rewindMs].every((t) => {
          const pos = p.posAt(t);
          return !!pos && Math.hypot(pos.x - tg.x, pos.z - tg.z) <= tg.r;
        });
        if (!inside) continue;
        const raw = Math.min(tg.damage, MAX_HIT_FRACTION * p.maxHp);
        const reductions = [
          defReduction(p.def ?? 0),
          ...activeBuffs(this.buffs.get(p.uid) ?? [], tg.hitAt)
            .filter((b) => b.id === "cymbrella")
            .map((b) => b.value),
        ];
        const dealt = Math.max(1, Math.round(mitigate(raw, reductions)));
        const blocked = Math.max(
          0,
          Math.max(1, Math.round(mitigate(raw, reductions.slice(0, 1)))) -
            dealt,
        );
        hits.push({
          uid: p.uid,
          damage: dealt,
          absorbed: Math.max(0, Math.round(raw) - dealt),
          blocked,
        });
        this.invulnUntil.set(p.uid, tg.hitAt + TUNING.invulnMs);
      }
      events.push({ t: "resolve", id: tg.id, hits });
      const m = this.mobs.find((x) => x.id === tg.mob);
      if (m && m.hp > 0) {
        m.state = "recover";
        m.until = now + MOB_SWING.recoverMs;
      }
    }
  }

  private alive(): Mob[] {
    return this.mobs.filter((m) => m.hp > 0);
  }

  /** Where `m` stood at `t` (its oldest kept spot if before that). */
  private seenAt(m: Mob, t: number): { x: number; z: number } {
    const trail = m.trail;
    for (let i = trail.length - 1; i > 0; i--) {
      const a = trail[i - 1];
      const b = trail[i];
      if (a.t <= t && t <= b.t) {
        const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
        return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return t < trail[0].t ? trail[0] : { x: m.x, z: m.z };
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
