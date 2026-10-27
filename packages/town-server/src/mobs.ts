/**
 * A pack of Thornlings: what they do and what hits them. The Tower runs
 * one per floor; the boss calls one at low health. Pure and deterministic
 * (the host's seeded RNG and an injected clock).
 *
 * Mobs are always aggressive, and come in kinds (MOB_KINDS): brutes walk at
 * you and swing in front of them, lungers dash at you down a marked lane,
 * spitters hang back and lob at where you're heading. Only so many attack
 * at once (attackTokens); the rest circle you, waiting their turn. Every
 * attack's shape is on the ground before it lands, judged like the boss's
 * slams (in the shape now *and* a moment ago, a breather after a hit, never
 * more than a share of your health) by the host's {@link MobJudge}, so a
 * herzie hit by the boss is safe from a Thornling for the same breather,
 * and its Def and buffs count the same. Its damage follows the floor, the
 * kind and the level gap.
 *
 * The client draws mobs a little behind where they are here, so a cast is
 * judged against where they stood {@link SEEN_LAG_MS} ago, and a little
 * wider than they are.
 */
import {
  type Body,
  bodyHitAt,
  type HitStats,
  hitDamage,
  MELEE_REACH,
  meleeReaches,
  WAVE_HAND_HEIGHT,
} from "@herzies/shared/combat";
import type { Buff } from "@herzies/shared/skills";
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
import type { TowerMob } from "@herzies/shared/town-net";
import {
  type BossEvent,
  type BossHit,
  type BossPlayer,
  covers,
  mitigatedHit,
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

/** Where mobs may stand. */
export type TowerArena = {
  /** The walkable radius (TOWN_MAPS). */
  radius: number;
  /** Where herzies arrive: mobs start well away from it. */
  entry: { x: number; z: number };
};

/** What the host knows about each herzie that a mob's hit is judged by:
 * whether they're in a breather (just arrived, just hit), and their buffs. */
export type MobJudge = {
  /** Just arrived or got back up: no hit lands at `t`. */
  safe(uid: string, t: number): boolean;
  /** Just hit: no hit lands at `t`. */
  invuln(uid: string, t: number): boolean;
  /** Hit at `t`: the breather starts. */
  hitAt(uid: string, t: number): void;
  buffs(uid: string): readonly Buff[];
};

type MobState = "idle" | "chase" | "windup" | "recover";

export type Mob = {
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
  /** Not before this (server ms): a minion just called stands a beat. */
  wakeAt?: number;
};

type PendingHit = {
  at: number;
  uid: string;
  mob: number;
  damage: number;
  crit: boolean;
  skill?: string;
};

/** What a pack says happened, beside the boss's kinds of event. */
export type MobEvent =
  | BossEvent
  | { t: "mobDown"; mob: number; by: string; x: number; z: number };

/** A herzie a mob may go for, and where they are. */
type Target = { p: BossPlayer; at: { x: number; z: number } };

export class MobPack {
  /** The floor its mobs are as strong as. */
  floor: number;
  /** The herzie's (or the raid's average) level, against the floor's for
   * the level gap. */
  level: number;
  private mobs: Mob[] = [];
  private telegraphs: Telegraph[] = [];
  private pending: PendingHit[] = [];
  private nextMobId = 1;
  /** When the mobs wake, and when they enrage (server ms). */
  wakeAt = 0;
  enrageAt = Number.POSITIVE_INFINITY;
  private lastAt: number;

  constructor(
    opts: {
      floor: number;
      level: number;
      now: number;
      rand: () => number;
      nextId: () => number;
    },
    private readonly arena: TowerArena,
    /** Something mobs walk round (the boss), if any. */
    private readonly obstacle?: () => {
      x: number;
      z: number;
      r: number;
    } | null,
  ) {
    this.floor = Math.max(1, Math.floor(opts.floor));
    this.level = Math.max(1, Math.floor(opts.level));
    this.rand = opts.rand;
    this.nextId = opts.nextId;
    this.lastAt = opts.now;
  }

  private readonly rand: () => number;
  private readonly nextId: () => number;

  /** The mobs still standing. */
  get alive(): Mob[] {
    return this.mobs.filter((m) => m.hp > 0);
  }

  /** How many there were (standing or not). */
  get size(): number {
    return this.mobs.length;
  }

  get hp(): number {
    return this.mobs.reduce((n, m) => n + m.hp, 0);
  }

  get maxHp(): number {
    return Math.max(
      1,
      this.mobs.reduce((n, m) => n + m.maxHp, 0),
    );
  }

  get active(): readonly Telegraph[] {
    return this.telegraphs;
  }

  /** The boss's rules, for its minions: no tell shorter than its own, a
   * share of the floor's shapes, and its taunt pulls them too. */
  minWindupMs: number = MIN_WINDUP_MS;
  maxShapes = Number.POSITIVE_INFINITY;
  taunter: (() => string | null) | null = null;

  /** When the last update ran (server ms). */
  get now(): number {
    return this.lastAt;
  }

  enragedAt(now: number): boolean {
    return now >= this.enrageAt;
  }

  /** What each mob last looked like on the wire, by id. */
  private sent = new Map<number, string>();

  /** Only the mobs that changed since the last call (moved, turned, hurt,
   * winding up): a pack standing still sends nothing. */
  wireChanged(): TowerMob[] {
    const out: TowerMob[] = [];
    for (const w of this.wire()) {
      const key = `${w.x},${w.z},${w.yaw},${w.hp},${w.s}`;
      if (this.sent.get(w.id) === key) continue;
      this.sent.set(w.id, key);
      out.push(w);
    }
    return out;
  }

  wire(): TowerMob[] {
    return this.alive.map((m) => ({
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

  /** Every mob still standing falls at once (the boss is down): their
   * shapes come off the floor. Returns those that fell. */
  dismiss(): Mob[] {
    const gone = this.alive;
    for (const m of gone) m.hp = 0;
    this.telegraphs = [];
    this.pending = [];
    return gone;
  }

  /** Nothing in flight lands any more (the floor's cleared). */
  clearPending(): void {
    this.pending = [];
  }

  // --- Spawning.

  /** A Tower floor: two packs either side of the far middle, an elite or
   * the Warden on their floors, waking after the opening, enraging past
   * par. */
  spawnFloor(now: number): void {
    const base = towerMob(this.floor).hp;
    this.mobs = [];
    this.telegraphs = [];
    this.pending = [];
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
      this.add(
        kind,
        rank,
        x,
        z,
        Math.atan2(entry.x - x, entry.z - z),
        base,
        now,
      );
    }
  }

  /**
   * The boss's call: `count` plain Thornlings (a quarter spitters, a
   * quarter lungers) along the room's edge, on the far side from the boss
   * and clear of every herzie, awake after a short beat. Adds to any still
   * standing.
   */
  spawnPack(
    now: number,
    count: number,
    boss: { x: number; z: number },
    herzies: readonly { x: number; z: number }[],
  ): number[] {
    const base = towerMob(this.floor).hp;
    const kinds: MobKind[] = [];
    const spitters = count >= 3 ? Math.floor(count / 4) || 1 : 0;
    const lungers = count >= 4 ? Math.floor(count / 4) || 1 : 0;
    for (let i = 0; i < spitters; i++) kinds.push("spitter");
    for (let i = 0; i < lungers; i++) kinds.push("lunger");
    while (kinds.length < count) kinds.push("brute");
    const order = shuffle(kinds, this.rand);
    const away = Math.atan2(-boss.x, -boss.z);
    const r = this.arena.radius - 1.5;
    const ids: number[] = [];
    // Each new one stands a beat; those already up carry on.
    const wake = now + FLOOR_OPENING_MS / 2;
    for (const kind of order) {
      let x = 0;
      let z = 0;
      // The first clear spot; failing that, the one furthest from anyone
      // (never on top of a herzie).
      let bestRoom = Number.NEGATIVE_INFINITY;
      for (let tries = 0; tries < 30; tries++) {
        const a = away + (this.rand() * 2 - 1) * (tries < 20 ? 1.6 : Math.PI);
        const cx = Math.sin(a) * r;
        const cz = Math.cos(a) * r;
        let room = Number.POSITIVE_INFINITY;
        for (const h of herzies)
          room = Math.min(room, Math.hypot(h.x - cx, h.z - cz) - 3);
        for (const m of this.mobs)
          if (m.hp > 0)
            room = Math.min(room, Math.hypot(m.x - cx, m.z - cz) - 1.8);
        if (room > bestRoom) {
          bestRoom = room;
          x = cx;
          z = cz;
        }
        if (room > 0) break;
      }
      const id = this.add(kind, 0, x, z, Math.atan2(-x, -z), base, now);
      const mob = this.mobs.find((m) => m.id === id);
      if (mob) mob.wakeAt = wake;
      ids.push(id);
    }
    return ids;
  }

  private add(
    kind: MobKind,
    rank: 0 | 1 | 2,
    x: number,
    z: number,
    yaw: number,
    base: number,
    now: number,
  ): number {
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
    const id = this.nextMobId++;
    this.mobs.push({
      id,
      kind,
      rank,
      affix,
      scale: rank === 2 ? WARDEN.scale : rank === 1 ? ELITE.scale : 1,
      x,
      z,
      yaw,
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
    return id;
  }

  // --- Hits on them.

  /** The nearest mob a ray from (x, z) at hand height finds, as they stood
   * at `seen`. */
  along(
    from: { x: number; z: number },
    dir: readonly [number, number, number],
    seen: number,
    range?: number,
  ): { mob: Mob; dist: number } | null {
    let best: { mob: Mob; dist: number } | null = null;
    for (const m of this.alive) {
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

  /** Every mob a melee blow from `from`, facing `yaw`, reaches (as they
   * stood at `seen`). */
  inReach(from: { x: number; z: number }, yaw: number, seen: number): Mob[] {
    return this.alive.filter((m) => {
      const at = this.seenAt(m, seen);
      return meleeReaches(
        from,
        yaw,
        { x: at.x, z: at.z, radius: MOB.radius * m.scale + HIT_SLACK },
        MELEE_REACH + TUNING.meleeSlack,
      );
    });
  }

  /** A hit on `mob` from `uid`, landing at `at`: a cast's damage times
   * `mult`, and the level gap. */
  queue(
    uid: string,
    mob: Mob,
    at: number,
    stats: HitStats,
    mult: number,
    skill?: string,
  ): void {
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

  update(
    now: number,
    players: readonly BossPlayer[],
    judge: MobJudge,
  ): MobEvent[] {
    const events: MobEvent[] = [];
    const dt = Math.min(0.25, Math.max(0, now - this.lastAt) / 1000);
    this.lastAt = now;
    this.land(now, events);
    this.resolveDue(now, players, judge, events);
    if (now >= this.wakeAt) this.act(now, dt, players, judge, events);
    for (const m of this.mobs) {
      if (m.hp <= 0) continue;
      m.trail.push({ t: now, x: m.x, z: m.z });
      while (m.trail.length > 2 && m.trail[1].t < now - TRAIL_MS)
        m.trail.shift();
    }
    return events;
  }

  private land(now: number, events: MobEvent[]) {
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
      // Once every mob is down, nothing more lands.
      if (!this.alive.length) this.pending = [];
    }
  }

  private act(
    now: number,
    dt: number,
    players: readonly BossPlayer[],
    judge: MobJudge,
    events: MobEvent[],
  ) {
    const targets = players.flatMap((p) => {
      if (!p.alive) return [];
      const at = p.posAt(now);
      return at ? [{ p, at }] : [];
    });
    const enraged = this.enragedAt(now);
    const alive = this.alive;
    // Who's attacking (winding up, or getting their breath back): each
    // holds one of the pack's tokens.
    let busy = alive.filter(
      (m) => m.state === "windup" || (m.state === "recover" && now < m.until),
    ).length;
    const wanting: { m: Mob; near: Target; d: number }[] = [];
    const taunter = this.taunter?.() ?? null;
    const taunted = taunter
      ? targets.find((t) => t.p.uid === taunter)
      : undefined;
    for (const m of alive) {
      if (m.state === "windup" || (m.state === "recover" && now < m.until))
        continue;
      if (m.wakeAt !== undefined && now < m.wakeAt) continue;
      let near: Target | null = null;
      let best = Number.POSITIVE_INFINITY;
      if (taunted) {
        near = taunted;
        best = Math.hypot(taunted.at.x - m.x, taunted.at.z - m.z);
      } else
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
      const safe = judge.safe(near.p.uid, now);
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
    let shapes = 0;
    for (const t of this.telegraphs) if (t.hitAt > now) shapes++;
    for (const w of wanting) {
      if (busy < tokens && shapes < this.maxShapes) {
        shapes++;
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
    return Math.round(
      Math.max(m.rank === 2 ? 750 : MIN_WINDUP_MS, this.minWindupMs, ms),
    );
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
    events: MobEvent[],
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
        id: this.nextId(),
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
   * the others (and the boss) and inside the arena. */
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
    for (const o of this.mobs) {
      if (o === m || o.hp <= 0) continue;
      const ox = m.x - o.x;
      const oz = m.z - o.z;
      const od = Math.hypot(ox, oz);
      const room = MOB.spacing * Math.max(m.scale, o.scale);
      if (od > 0 && od < room) {
        dx += (ox / od) * (1 - od / room) * 1.5;
        dz += (oz / od) * (1 - od / room) * 1.5;
      }
    }
    // And round the boss, never through it.
    const big = this.obstacle?.();
    if (big) {
      const ox = m.x - big.x;
      const oz = m.z - big.z;
      const od = Math.hypot(ox, oz);
      const room = big.r + MOB.radius * m.scale + 0.4;
      if (od > 0 && od < room + 1) {
        const push = Math.min(2, (room + 1 - od) / 1);
        dx += (ox / od) * push;
        dz += (oz / od) * push;
      }
    }
    const len = Math.hypot(dx, dz) || 1;
    const step = Math.min(speed * dt, d - stop);
    let p = this.clampToArena(
      m.x + (dx / len) * step,
      m.z + (dz / len) * step,
      1,
    );
    if (big) {
      const ox = p.x - big.x;
      const oz = p.z - big.z;
      const od = Math.hypot(ox, oz);
      const room = big.r + MOB.radius * m.scale;
      if (od < room && od > 0)
        p = { x: big.x + (ox / od) * room, z: big.z + (oz / od) * room };
    }
    m.x = p.x;
    m.z = p.z;
  }

  /** (x, z) pulled back inside the arena, `margin` from its edge. */
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
    judge: MobJudge,
    events: MobEvent[],
  ) {
    const due = this.telegraphs.filter((t) => t.hitAt <= now);
    if (!due.length) return;
    this.telegraphs = this.telegraphs.filter((t) => t.hitAt > now);
    for (const tg of due) {
      const hits: BossHit[] = [];
      for (const p of players) {
        if (!p.alive) continue;
        if (judge.safe(p.uid, tg.hitAt)) continue;
        if (judge.invuln(p.uid, tg.hitAt)) continue;
        const inside = [tg.hitAt, tg.hitAt - TUNING.rewindMs].every((t) => {
          const pos = p.posAt(t);
          return !!pos && covers(tg, pos.x, pos.z);
        });
        if (!inside) continue;
        const { aimed: _aimed, ...hit } = mitigatedHit(
          p,
          tg,
          judge.buffs(p.uid),
        );
        hits.push(hit);
        judge.hitAt(p.uid, tg.hitAt);
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

/** `list` in a seeded order (Fisher–Yates). */
function shuffle<T>(list: T[], rand: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
