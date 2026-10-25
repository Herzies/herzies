/**
 * The Tower's floors: the mobs, what they do, and what hits them. Pure and
 * deterministic like `BossEngine` (a seeded RNG, an injected clock), and
 * shaped like it — the same casts, telegraphs and resolves — so
 * `FightRuntime` runs a floor just as it runs the boss: health, knock-outs,
 * skills, eating and reports all come for free.
 *
 * Mobs are always aggressive, and come in kinds (MOB_KINDS): brutes walk at
 * you and swing in front of them, lungers dash at you down a marked lane,
 * spitters hang back and lob at where you're heading. Only so many attack
 * at once (attackTokens); the rest circle you, waiting their turn. Every
 * attack's shape is on the ground before it lands, judged like the boss's
 * slams (in the shape now *and* a moment ago, a breather after a hit, never
 * more than a share of your health), and its damage follows the floor, the
 * kind and the level gap. Linger past a floor's par time and they enrage.
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
  attackTokens,
  ELITE,
  type EliteAffix,
  ENRAGE,
  FLANK_RANGE,
  FLOOR_OPENING_MS,
  floorKinds,
  floorParMs,
  isEliteFloor,
  isWardenFloor,
  levelGapMods,
  MIN_WINDUP_MS,
  MOB,
  MOB_KINDS,
  type MobKind,
  towerMob,
  WARDEN,
  windupScale,
} from "@herzies/shared/tower";
import type { TowerFloor, TowerMob } from "@herzies/shared/town-net";
import {
  type BossEvent,
  type BossPlayer,
  covers,
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
  kind: MobKind;
  /** 0 a plain mob, 1 an elite, 2 the Warden. */
  rank: 0 | 1 | 2;
  affix: EliteAffix | null;
  /** How much bigger than a plain mob it's drawn and judged. */
  scale: number;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  state: MobState;
  /** When the current windup lands, or the recovery ends (server ms). */
  until: number;
  /** Since when it's wanted to attack but had no token (null: it hasn't):
   * the longest waiting goes first. */
  waitSince: number | null;
  /** A lunger's dash: where it ends up when its windup lands. */
  dashTo: { x: number; z: number } | null;
  /** The Warden's next attack. */
  ring: boolean;
  /** Which way it circles you while it waits (1 or −1). */
  orbit: number;
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
  /** When the floor's mobs enrage (server ms). */
  private enrageAt = 0;
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
      enrageIn: Math.max(0, Math.round(this.enrageAt - this.lastAt)),
    };
  }

  /** Whether the floor's mobs have enraged. */
  enragedAt(now: number): boolean {
    return !this.cleared && now >= this.enrageAt;
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
        ...(m.kind !== "brute" ? { k: m.kind } : {}),
        ...(m.rank ? { e: m.rank } : {}),
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
    const base = towerMob(this.floor).hp;
    this.mobs = [];
    this.telegraphs = [];
    this.pending = [];
    this.cleared = false;
    this.wakeAt = now + FLOOR_OPENING_MS;
    this.enrageAt = this.wakeAt + floorParMs(this.floor);
    const kinds = shuffle(floorKinds(this.floor), this.rand);
    const n = kinds.length;
    // The Warden takes a brute's place; an elite floor's elite is anyone.
    const warden = isWardenFloor(this.floor)
      ? Math.max(0, kinds.indexOf("brute"))
      : -1;
    if (warden >= 0) kinds[warden] = "brute";
    const elite = isEliteFloor(this.floor) ? Math.floor(this.rand() * n) : -1;
    const { entry, radius } = this.arena;
    // Two packs, either side of the far middle, so they come at you from
    // two ways at once.
    const away = Math.atan2(-entry.x, -entry.z);
    // In the open meadow: the wooded rim (past about 13) is the client's
    // trees, which mobs here know nothing of.
    const r = Math.min(radius - 4, 12);
    for (let i = 0; i < n; i++) {
      const kind = kinds[i];
      const side = i % 2 === 0 ? 1 : -1;
      let x = 0;
      let z = 0;
      for (let tries = 0; tries < 20; tries++) {
        const a = away + side * (0.45 + this.rand() * 0.55);
        // Spitters start further back.
        const d =
          kind === "spitter"
            ? r * (0.75 + 0.25 * this.rand())
            : r * (0.4 + 0.6 * this.rand());
        x = Math.sin(a) * d;
        z = Math.cos(a) * d;
        if (this.mobs.every((m) => Math.hypot(m.x - x, m.z - z) > 2.2)) break;
      }
      const rank: 0 | 1 | 2 = i === warden ? 2 : i === elite ? 1 : 0;
      const k = MOB_KINDS[kind];
      const hp = Math.round(
        base * k.hp * (rank === 2 ? WARDEN.hp : rank === 1 ? ELITE.hp : 1),
      );
      const affix: EliteAffix | null =
        rank !== 1
          ? null
          : kind === "spitter"
            ? this.rand() < 0.6
              ? "volley"
              : "swift"
            : this.rand() < 0.5
              ? "frenzy"
              : "swift";
      this.mobs.push({
        id: this.nextMobId++,
        kind,
        rank,
        affix,
        scale: rank === 2 ? WARDEN.scale : rank === 1 ? ELITE.scale : 1,
        x,
        z,
        yaw: Math.atan2(entry.x - x, entry.z - z),
        hp,
        maxHp: hp,
        state: "idle",
        until: 0,
        waitSince: null,
        dashTo: null,
        ring: false,
        orbit: this.rand() < 0.5 ? 1 : -1,
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
            { x: at.x, z: at.z, radius: MOB.radius * m.scale + HIT_SLACK },
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
        radius: MOB.radius * m.scale + HIT_SLACK,
        chest: MOB.chest * m.scale,
        top: MOB.top * m.scale,
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
    const enraged = this.enragedAt(now);
    const alive = this.alive();
    // Who's attacking (winding up, or getting their breath back): each
    // holds one of the floor's tokens.
    let busy = alive.filter(
      (m) => m.state === "windup" || (m.state === "recover" && now < m.until),
    ).length;
    const wanting: { m: Mob; near: Target; d: number }[] = [];
    for (const m of alive) {
      if (m.state === "windup" || (m.state === "recover" && now < m.until))
        continue;
      let near: Target | null = null;
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
        m.waitSince = null;
        continue;
      }
      m.state = "chase";
      m.yaw = Math.atan2(near.at.x - m.x, near.at.z - m.z);
      const safe = (this.safeUntil.get(near.p.uid) ?? 0) > now;
      if (!safe && this.inRange(m, best)) {
        m.waitSince ??= now;
        wanting.push({ m, near, d: best });
      } else {
        m.waitSince = null;
        this.move(m, near.at, best, dt, false, enraged);
      }
    }
    // The longest waiting go first, while there are tokens; the rest
    // circle you.
    wanting.sort((a, b) => (a.m.waitSince ?? 0) - (b.m.waitSince ?? 0));
    const tokens = attackTokens(this.floor);
    for (const w of wanting) {
      if (busy < tokens) {
        busy++;
        w.m.waitSince = null;
        this.attack(w.m, w.near, now, enraged, events);
      } else {
        this.move(w.m, w.near.at, w.d, dt, true, enraged);
      }
    }
  }

  /** Close enough to attack from. */
  private inRange(m: Mob, d: number): boolean {
    if (m.rank === 2) return d <= WARDEN.slam.ahead + WARDEN.slam.radius;
    if (m.kind === "lunger") return d <= MOB_KINDS.lunger.lunge;
    if (m.kind === "spitter") return d <= MOB_KINDS.spitter.range;
    return d <= MOB.reach * m.scale;
  }

  private speedOf(m: Mob, enraged: boolean): number {
    const base = m.rank === 2 ? WARDEN.speed : MOB_KINDS[m.kind].speed;
    return (
      base * (m.affix === "swift" ? 1.3 : 1) * (enraged ? ENRAGE.speed : 1)
    );
  }

  /** How long its windup is on this floor. */
  private windupOf(m: Mob, enraged: boolean): number {
    const base = m.rank === 2 ? WARDEN.windupMs : MOB_KINDS[m.kind].windupMs;
    const ms = base * windupScale(this.floor) * (enraged ? ENRAGE.windup : 1);
    return Math.round(Math.max(m.rank === 2 ? 750 : MIN_WINDUP_MS, ms));
  }

  private recoverOf(m: Mob, enraged: boolean): number {
    const base = m.rank === 2 ? WARDEN.recoverMs : MOB_KINDS[m.kind].recoverMs;
    return Math.round(
      base * (m.affix === "frenzy" ? 0.35 : 1) * (enraged ? ENRAGE.windup : 1),
    );
  }

  /** Wind up an attack on `near`: its shapes go down now and land after
   * the windup. */
  private attack(
    m: Mob,
    near: Target,
    now: number,
    enraged: boolean,
    events: TowerEvent[],
  ) {
    const windup = this.windupOf(m, enraged);
    const hitAt = now + windup;
    const { taken } = levelGapMods(towerMob(this.floor).level - this.level);
    const mult =
      (m.rank === 2 ? WARDEN.damage : m.rank === 1 ? ELITE.damage : 1) *
      MOB_KINDS[m.kind].damage;
    const damage = Math.round(towerMob(this.floor).damage * mult * taken);
    m.state = "windup";
    m.until = hitAt;
    const you = near.at;
    m.yaw = Math.atan2(you.x - m.x, you.z - m.z);
    const fx = Math.sin(m.yaw);
    const fz = Math.cos(m.yaw);
    const shape = (
      x: number,
      z: number,
      r: number,
      inner = 0,
      kind: Telegraph["kind"] = "circle",
    ) => {
      const p = this.clampToArena(x, z, 0.5);
      const telegraph: Telegraph = {
        id: this.nextId++,
        kind,
        x: round(p.x),
        z: round(p.z),
        r,
        inner,
        at: now,
        hitAt,
        damage,
        mob: m.id,
      };
      this.telegraphs.push(telegraph);
      events.push({ t: "telegraph", telegraph });
    };

    if (m.rank === 2) {
      // The Warden: a wide slam in front, then a ring round itself (stand
      // in close), turn about.
      if (m.ring) shape(m.x, m.z, WARDEN.ring.outer, WARDEN.ring.inner, "ring");
      else
        shape(
          m.x + fx * WARDEN.slam.ahead,
          m.z + fz * WARDEN.slam.ahead,
          WARDEN.slam.radius,
        );
      m.ring = !m.ring;
      return;
    }

    if (m.kind === "spitter") {
      const k = MOB_KINDS.spitter;
      // Where you'll be when it lands if you keep on as you are (turning
      // as you're turning): change course and it misses.
      const ahead = predict(
        near.p,
        now,
        (windup - TUNING.rewindMs / 2) * k.lead,
      );
      shape(ahead.x, ahead.z, k.radius);
      if (m.affix === "volley") {
        // Two more: where you are now, and halfway.
        shape(you.x, you.z, k.radius);
        shape((you.x + ahead.x) / 2, (you.z + ahead.z) / 2, k.radius);
      }
      return;
    }

    const d = Math.hypot(you.x - m.x, you.z - m.z);
    if (m.kind === "lunger" && d > MOB.reach + 0.3) {
      // A lane of circles from it to just past where you're heading; it
      // dashes down it.
      const k = MOB_KINDS.lunger;
      const aim = predict(near.p, now, windup * 0.8);
      const ax = aim.x - m.x;
      const az = aim.z - m.z;
      const al = Math.hypot(ax, az) || 1;
      m.yaw = Math.atan2(ax, az);
      const end = this.clampToArena(
        aim.x + (ax / al) * k.overshoot,
        aim.z + (az / al) * k.overshoot,
        1,
      );
      const len = Math.hypot(end.x - m.x, end.z - m.z);
      const count = Math.min(5, Math.max(2, Math.ceil(len / (k.radius * 1.5))));
      for (let i = 0; i < count; i++) {
        const u = (i + 0.75) / count;
        shape(m.x + (end.x - m.x) * u, m.z + (end.z - m.z) * u, k.radius);
      }
      m.dashTo = end;
      return;
    }

    // A swing in front of it (a lunger's bite up close too).
    const k = m.kind === "lunger" ? MOB_KINDS.lunger : MOB_KINDS.brute;
    shape(
      m.x + fx * k.ahead * m.scale,
      m.z + fz * k.ahead * m.scale,
      k.radius * (m.rank === 1 ? 1.15 : 1),
    );
  }

  /** A step for a mob that isn't attacking: a spitter keeps its distance;
   * the rest come at you, or (`waiting` for a token) hold round you. */
  private move(
    m: Mob,
    you: { x: number; z: number },
    d: number,
    dt: number,
    waiting: boolean,
    enraged: boolean,
  ) {
    const speed = this.speedOf(m, enraged);
    if (m.kind === "spitter" && m.rank === 0) {
      const [near, far] = MOB_KINDS.spitter.keep;
      if (d < near) {
        // Back off, straight away from you.
        this.walk(m, { x: m.x * 2 - you.x, z: m.z * 2 - you.z }, dt, speed, 0);
      } else if (d > far) {
        this.walk(m, you, dt, speed, far - 0.5);
      } else {
        // In its band: drift round you, so it's never a still target.
        this.walk(m, this.orbitPoint(m, you, d), dt, speed * 0.45, 0);
      }
      return;
    }
    if (!waiting) {
      this.walk(m, you, dt, speed, MOB.reach * 0.8 * m.scale);
      return;
    }
    // Waiting its turn: hold a step outside your reach, working round you.
    this.walk(
      m,
      this.orbitPoint(m, you, FLANK_RANGE * Math.max(1, m.scale * 0.9)),
      dt,
      speed * 0.6,
      0,
    );
  }

  /** A point a little round from `m` on the circle `radius` about you. */
  private orbitPoint(
    m: Mob,
    you: { x: number; z: number },
    radius: number,
  ): { x: number; z: number } {
    const a = Math.atan2(m.x - you.x, m.z - you.z) + m.orbit * 0.35;
    return { x: you.x + Math.sin(a) * radius, z: you.z + Math.cos(a) * radius };
  }

  /** A step toward `to` at `speed`, stopping `stop` short of it, kept off
   * the others and on the island. */
  private walk(
    m: Mob,
    to: { x: number; z: number },
    dt: number,
    speed: number,
    stop: number,
  ) {
    let dx = to.x - m.x;
    let dz = to.z - m.z;
    const d = Math.hypot(dx, dz);
    // Close enough: hold here rather than push into you.
    if (d <= stop || d < 1e-6) return;
    dx /= d;
    dz /= d;
    // Make room for each other.
    for (const o of this.alive()) {
      if (o === m) continue;
      const ox = m.x - o.x;
      const oz = m.z - o.z;
      const od = Math.hypot(ox, oz);
      const room = MOB.spacing * Math.max(m.scale, o.scale);
      if (od > 0 && od < room) {
        dx += (ox / od) * (1 - od / room) * 1.5;
        dz += (oz / od) * (1 - od / room) * 1.5;
      }
    }
    const len = Math.hypot(dx, dz) || 1;
    const step = Math.min(speed * dt, d - stop);
    const p = this.clampToArena(
      m.x + (dx / len) * step,
      m.z + (dz / len) * step,
      1,
    );
    m.x = p.x;
    m.z = p.z;
  }

  /** (x, z) pulled back inside the island, `margin` from its edge. */
  private clampToArena(
    x: number,
    z: number,
    margin: number,
  ): { x: number; z: number } {
    const r = this.arena.radius - margin;
    const out = Math.hypot(x, z);
    return out > r ? { x: (x * r) / out, z: (z * r) / out } : { x, z };
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
          return !!pos && covers(tg, pos.x, pos.z);
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
      if (m && m.hp > 0 && m.state === "windup") {
        m.state = "recover";
        m.until = now + this.recoverOf(m, this.enragedAt(now));
        // A lunger's dash: it's at the far end of its lane now.
        if (m.dashTo) {
          m.x = m.dashTo.x;
          m.z = m.dashTo.z;
          m.dashTo = null;
        }
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

/**
 * Where `p` will be `ms` from `now` if they keep on as they are: their
 * speed and heading over the last quarter second, turning as fast as they
 * were turning over the quarter before (so a circle is followed round, not
 * cut across). Aiming one way and walking it is what gets you hit; a
 * change of course is the dodge.
 */
export function predict(
  p: Pick<BossPlayer, "posAt">,
  now: number,
  ms: number,
): { x: number; z: number } {
  const a = p.posAt(now);
  if (!a) return { x: 0, z: 0 };
  const b = p.posAt(now - 250) ?? a;
  const c = p.posAt(now - 500) ?? b;
  const v2x = (a.x - b.x) / 0.25;
  const v2z = (a.z - b.z) / 0.25;
  const speed = Math.hypot(v2x, v2z);
  if (speed < 0.3 || ms <= 0) return { x: a.x, z: a.z };
  const h2 = Math.atan2(v2x, v2z);
  const v1x = (b.x - c.x) / 0.25;
  const v1z = (b.z - c.z) / 0.25;
  let turn = 0;
  if (Math.hypot(v1x, v1z) > 0.3) {
    let dh = h2 - Math.atan2(v1x, v1z);
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    // Rad a second, no faster than a tight circle.
    turn = Math.max(-2, Math.min(2, dh / 0.25));
  }
  const steps = 6;
  const dt = ms / 1000 / steps;
  let x = a.x;
  let z = a.z;
  let h = h2;
  for (let i = 0; i < steps; i++) {
    h += turn * dt * 0.5;
    x += Math.sin(h) * speed * dt;
    z += Math.cos(h) * speed * dt;
    h += turn * dt * 0.5;
  }
  return { x, z };
}

/** A herzie a mob may go for, and where they are. */
type Target = { p: BossPlayer; at: { x: number; z: number } };

/** `list` in a seeded order (Fisher–Yates). */
function shuffle<T>(list: T[], rand: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
