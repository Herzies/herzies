/**
 * The boss room's fight, minus the sockets: who's in it, their health, the
 * boss, and what to tell whom. `room.ts` feeds it frames and relays what it
 * returns, so everything here is tested without a Durable Object.
 *
 * A raid runs in three stages (specs/boss-fight.md):
 *  - lobby: the cave is open; the boss sleeps; anyone on their feet comes in.
 *  - fight: at the event's start the roster locks to whoever is standing in
 *    the room, the boss's health is set from its size, and the door shuts.
 *    Knocked out, you wait for a Bard's Resurrect or give up (forfeit, or
 *    gone longer than BOSS_OUT_GRACE_MS): out for good, no reward.
 *  - over: the boss fell, got away, or beat everyone (a wipe).
 *
 * The Tower reuses the same runtime with its own engine (no raid).
 */
import {
  BOSS_HP_PER_PLAYER,
  BOSS_OUT_GRACE_MS,
  bossMaxHp,
  IN_TUNE,
  inTuneBonus,
  MINION_FLOOR,
  minionFloorFor,
  minionPackSize,
  type RaidStage,
} from "@herzies/shared/boss-fight";
import {
  type BossLineKind,
  bossLine,
  bossLineMs,
} from "@herzies/shared/boss-lines";
import {
  type AttackStyle,
  basicAttack,
  hasInstrument,
  isHerzieClass,
} from "@herzies/shared/classes";
import {
  aimDirection,
  type Contribution,
  contributionOf,
  HEAL_BOLT,
  HEAL_LOCK_ANGLE,
  HEAL_LOCK_SLACK,
  type HitStats,
  healTarget,
  meleeDamage,
  WAVE_HAND_HEIGHT,
  WAVE_SPEED,
} from "@herzies/shared/combat";
import { CONSUMABLE_COOLDOWN_MS } from "@herzies/shared/medea";
import {
  buffMultiplier,
  isSkillId,
  SKILL_COOLDOWN_GRACE_MS,
  SKILL_DEFS,
  type SkillId,
  skillValue,
  skillXpFor,
} from "@herzies/shared/skills";
import { buffMult, healMult } from "@herzies/shared/stats";
import type {
  BossClaim,
  BossPlace,
  BossTelegraph,
  EatRefusal,
  FightState,
  LootDrop,
  RaidState,
  ServerMessage,
  SkillRefusal,
  TownLook,
  TownTicketPayload,
} from "@herzies/shared/town-net";
import {
  BossEngine,
  type BossEvent,
  type BossPlayer,
  rng,
  type Telegraph,
  TUNING,
} from "./boss";
import { PositionHistory } from "./history";
import { type TowerArena, TowerEngine, type TowerEvent } from "./tower";

/** The room holds eating to CONSUMABLE_COOLDOWN_MS less this, so a client
 * keeping to the full cooldown is never refused (or struck) for network
 * jitter. */
const EAT_COOLDOWN_GRACE_MS = 250;

/** How often HP and boss damage are reported while nothing urgent happens. */
export const REPORT_EVERY_MS = 2_000;
/** After the boss falls, how long the room stays open for a victory lap
 * and to pick up the loot. */
export const VICTORY_LINGER_MS = 45_000;
/** The share of their health the downed get back when the boss falls. */
export const VICTORY_RISE_SHARE = 0.3;
/** After the event ends with the boss alive, how long until the doors close. */
export const ESCAPE_LINGER_MS = 15_000;
/** After a wipe, how long until the doors close. */
export const WIPE_LINGER_MS = 15_000;
/** A resurrect is cancelled if its Bard moves further than this. */
export const CHANNEL_SLACK = 0.5;
/** The boss says something at least this often (a reminder of what it
 * hates), and no more often than `SAY_GAP_MS`. */
export const SAY_EVERY_MS = 45_000;
const SAY_GAP_MS = 6_000;
/** A line that must be said (a new phase, minions) waits for the one up
 * now to have been up this long, so two at once are both read. */
export const SAY_READ_MS = 2_500;
/** An in-tune buff is open-ended; it's taken off with `buffOff`. */
const OPEN_ENDED_MS = 6 * 3_600_000;
/** How often each fighter hears their own contribution and rank. */
const TALLY_EVERY_MS = 2_000;
/** How long a roster member who dropped stays "standing" for the wipe
 * check: long enough to ride out a reconnect, short enough that a raid
 * that's all down isn't kept waiting on someone who's gone. */
export const ABSENT_STANDING_MS = 15_000;
/** After a restart (or a roster from the database), how long a member
 * nobody has seen yet counts as standing: their app has to reconnect. */
export const UNSEEN_STANDING_MS = 60_000;
/** A lobby member whose connection dropped just before the start is still
 * on the roster if they were gone less than this. */
export const LOCK_GRACE_MS = 30_000;

export type Outbound = {
  /** Everyone in the room, or one player. */
  to: "all" | { uid: string };
  msg: ServerMessage;
};

export type FightPlayer = {
  uid: string;
  /** The herzie's name and look, from the ticket. */
  name: string;
  look: TownLook;
  /** The room's entity id for this socket. */
  id: number;
  hp: number;
  maxHp: number;
  down: boolean;
  stats: FightStats;
  present: boolean;
  /** Class skills from the ticket, and their levels (raised by `skillUps`). */
  skills: Map<SkillId, number>;
  /** When each skill is ready again (server ms). */
  ready: Map<SkillId, number>;
  /** Its basic attack, from its class and the instrument in its hand: a
   * wave, a thrown disc, or a blow (classes.ts basicAttack). */
  attack: AttackStyle;
  /** A melee blow's share of a wave: a stick, a punch or a body slam. */
  melee: number;
  /** Whether it holds its class's instrument: its class skills need it. */
  armed: boolean;
  /** Its class, for the in-tune bonus. */
  cls: string | null;
  /** Its level, for the minions' level gap. */
  level: number;
  /** Where it was when it left, so a downed herzie comes back where it
   * fell rather than wherever its app says. */
  leftAt?: { x: number; z: number };
};

/** What became of a skill. "early" is a cooldown refusal inside the grace
 * window: refused, but not held against the socket. "refused": the skill
 * can't do anything right now (no one to revive, not yet
 * in a fight): no cooldown spent, no strike. */
export type SkillResult =
  | "used"
  | "cooldown"
  | "early"
  | "unknown"
  | "ignored"
  | "refused";

/** What the room sends `town-vitals`: absolute HP for everyone present, and
 * the boss damage dealt since the last successful report. `batch` names the
 * damage, so a retry after a lost reply isn't counted twice.
 *
 * `heal` is the HP skills restored since the last report the database took:
 * how far it may raise the stored health toward `hp` (it otherwise only
 * lowers it). One absolute value plus that allowance, never a delta on top,
 * so damage and healing in the same window can't be counted twice. */
export type FightReport = {
  hp: { uid: string; hp: number; heal?: number }[];
  boss?: {
    event: string;
    batch: string;
    damage: BossRow[];
  };
  /** Skill XP earned since the last report, named by `batch` like the
   * boss damage. */
  skills?: {
    batch: string;
    xp: { uid: string; skill: string; xp: number }[];
  };
  /** The fight is over: the end screen's table, for these herzies. */
  results?: { event: string; uids: string[] };
  /** In the Tower: the kills since the last batch (each may drop an item
   * and pays a little XP) and the best floor cleared, named by `batch`
   * like the boss damage. */
  tower?: TowerBatch;
  /** The lobby locked: who's in (sent until the database took it; it
   * keeps the first lock it gets). `at` is unix ms. */
  lock?: {
    event: string;
    uids: string[];
    at: number;
    hpPerPlayer: number;
  };
  /** Herzies a Bard brought back, and with how much health, named by
   * `batch`. Processed before `hp`. */
  revived?: {
    event: string;
    batch: string;
    rows: { uid: string; hp: number }[];
  };
  /** Herzies out of the fight (forfeited, or gone too long). */
  out?: { event: string; uids: string[] };
  /** Everyone in fell: the boss won. */
  wipe?: { event: string };
  /** How the fight went, once, for tuning. */
  log?: FightLog;
};

/** What `town-vitals` answered about the raid. */
export type RaidReply = {
  /** The lock as the database holds it (its first, if it already had one). */
  lock?: { hp: number; maxHp: number; roster: string[]; at: number } | null;
  /** Revives the database refused: those herzies were already out. */
  refused?: string[];
  /** Everyone the database counts out, including those who respawned in
   * town from the app. */
  out?: string[];
};

/** One fight's numbers, for balancing. */
export type FightLog = {
  event: string;
  roster: number;
  outcome: "victory" | "escaped" | "wiped";
  lockedAt: number;
  endedAt: number;
  downs: number;
  revives: number;
  outs: number;
  /** Ms in tune, by class, summed over herzies. */
  inTuneMs: Record<string, number>;
  tauntMs: number;
  maxHp: number;
};

export type TowerBatch = {
  event: string;
  batch: string;
  uid: string;
  kills: { floor: number; x: number; z: number }[];
  /** The highest floor cleared in this batch, if any was. */
  cleared?: number;
};

/** What one herzie did for the fight since the last batch: damage dealt,
 * HP healed or blocked (support, 00111), and damage to the minions (adds,
 * 00122). Zero parts are left out. */
export type BossRow = {
  uid: string;
  damage: number;
  healing?: number;
  blocked?: number;
  adds?: number;
};

/** Until the end screen's table comes back, the fight reports this often. */
const RESULTS_RETRY_MS = 1_000;

type TowerClaim = NonNullable<TownTicketPayload["tower"]>;

/** Whether a herzie may come into the room now. */
export type JoinVerdict = "ok" | "locked" | "down" | "closed";

type TuneState = {
  playing: boolean;
  /** Since when music has been playing (or stopped) in the fight. */
  since: number;
  matching: boolean;
  on: boolean;
  onSince: number;
};

type Channel = {
  target: string;
  until: number;
  x: number;
  z: number;
  level: number;
};

export class FightRuntime {
  readonly engine: BossEngine | TowerEngine;
  readonly eventId: string;
  /** Unix ms when the boss escapes. */
  readonly until: number;
  /** When the room shuts (server ms), once something has ended the fight. */
  closesAt: number | null = null;
  closeWhy: "victory" | "escaped" | "wiped" | null = null;

  private history = new PositionHistory();
  /** Everyone who has been in this fight, so leaving and rejoining can't
   * refill health. */
  private players = new Map<string, FightPlayer>();
  /** What each herzie did since the last batch: damage, and support. */
  private pending = new Map<string, Contribution>();
  private inflight: {
    batch: string;
    damage: BossRow[];
  } | null = null;
  /** Players who left since their health was last reported. */
  private leftUnreported = new Set<string>();
  /** Players whose knock-out the database has been told about. They are
   * left out of every later report: a herzie that has since respawned in
   * town mustn't be knocked out again by a stale 0 (the database only
   * lowers health). */
  private downAcked = new Set<string>();
  private bossDirty = false;
  private reportNow = false;
  private nextReportAt: number;
  private batchSeq = 0;
  /** The rewards have been handed out; they only ever drop once. */
  private looted = false;
  /** The end screen went out (or there's no one to show it to). */
  private resultsSent = false;
  /** The dev boss is never reported: what each herzie did against it,
   * for its end screen. */
  private devDealt = new Map<string, Contribution>();
  /** Everyone's contribution this fight, for their own live line. */
  private dealt = new Map<string, Contribution>();
  private nextTallyAt = 0;
  /** HP skills (and eaten candy) restored, by player, not yet taken by the
   * database. */
  private healed = new Map<string, number>();
  /** When each player last started eating (server ms). */
  private ate = new Map<string, number>();
  /** Skill XP not yet reported, by `uid|skill` (fractions carry over). */
  private pendingXp = new Map<string, number>();
  private xpInflight: {
    batch: string;
    xp: { uid: string; skill: string; xp: number }[];
  } | null = null;
  /** The Tower's kills and clears not yet in a batch, and the batch in
   * flight. */
  private towerKills: TowerBatch["kills"] = [];
  private towerCleared = 0;
  private towerInflight: TowerBatch | null = null;
  /** The Tower's one herzie (a room of their own). */
  private towerUid = "";

  // --- The raid (boss room only).

  /** lobby, fight or over. A Tower floor (and a boss from an older ticket
   * server, without a lobby) is "fight" from the start. */
  stage: RaidStage = "fight";
  /** When the lobby locks (server ms). */
  private startsAt: number;
  private lockedAt: number | null = null;
  /** Who's in the fight and who's out, once it locks. Null: no roster (a
   * boss from an older ticket server, or the Tower): anyone may come. */
  private roster: Map<string, "in" | "out"> | null = null;
  /** When each roster member left the room (server ms). */
  private absentSince = new Map<string, number>();
  private readonly hpPerPlayer: number;
  /** How strong its minions are, as a Tower floor (null: from the raid's
   * average level, see minionFloorFor). */
  private readonly minionFloor: number | null;
  /** Resurrects being played, by their Bard. */
  private channels = new Map<string, Channel>();
  /** Bards whose lute is in its heal stance (user ids). */
  private healers = new Set<string>();
  /** Heal bolts in flight: who sent each, at whom, and when it lands. */
  private bolts: { by: string; target: string; at: number }[] = [];
  private tunes = new Map<string, TuneState>();
  /** Report queues for the raid, re-sent until taken. */
  private lockReq: FightReport["lock"] | null = null;
  private revivedQueue: { uid: string; hp: number }[] = [];
  private revivedInflight: FightReport["revived"] | null = null;
  private outQueue = new Set<string>();
  private wipePending = false;
  private logPending: FightLog | null = null;
  private raidDirty = false;
  /** Who the boss was after at the last tick (its focus): a change is
   * news. */
  private lastFocus: string | null = null;
  private say: { text: string; until: number } | null = null;
  /** Lines waiting their turn (see SAY_READ_MS), oldest first. */
  private sayQueue: string[] = [];
  private lastSayAt = Number.NEGATIVE_INFINITY;
  private readonly rand: () => number;
  private log: {
    downs: number;
    revives: number;
    outs: number;
    inTuneMs: Record<string, number>;
    tauntMs: number;
    lastAt: number;
  } = { downs: 0, revives: 0, outs: 0, inTuneMs: {}, tauntMs: 0, lastAt: 0 };

  constructor(claim: BossClaim, now: number, seed = now, engine?: TowerEngine) {
    this.eventId = claim.event;
    this.until = claim.until * 1000;
    this.hpPerPlayer =
      Number.isFinite(claim.hpPerPlayer) && (claim.hpPerPlayer as number) > 0
        ? (claim.hpPerPlayer as number)
        : BOSS_HP_PER_PLAYER;
    this.minionFloor =
      Number.isFinite(claim.minionFloor) && (claim.minionFloor as number) >= 1
        ? Math.floor(claim.minionFloor as number)
        : null;
    this.rand = rng(seed ^ 0x5eed);
    this.startsAt = claim.starts ? claim.starts * 1000 : now;
    this.nextReportAt = now + REPORT_EVERY_MS;
    if (engine) {
      this.engine = engine;
      // The Tower has no end screen.
      this.resultsSent = true;
      return;
    }
    const locked = claim.locked;
    if (locked) {
      // A room that restarted mid-fight: pick it up where it was.
      this.stage = "fight";
      this.lockedAt = locked.at * 1000;
      this.roster = new Map(locked.roster.map((uid) => [uid, "in" as const]));
      // Nobody is back yet: each has the grace to reconnect (and stands
      // until then), so the first downed herzie back can't trip a wipe and
      // anyone who never returns is out in time.
      for (const uid of locked.roster) this.absentSince.set(uid, now);
    } else if (claim.starts) {
      this.stage = "lobby";
    }
    this.engine = new BossEngine({
      hp: claim.hp,
      maxHp: claim.maxHp,
      seed,
      now,
      dormant: this.stage === "lobby",
      lockedAt: this.lockedAt ?? now,
    });
    this.log.lastAt = now;
  }

  /** A Tower floor for `uid`, from their ticket's claim. */
  static tower(
    claim: TowerClaim,
    uid: string,
    level: number,
    arena: TowerArena,
    now: number,
    seed = now,
  ): FightRuntime {
    const engine = new TowerEngine(
      { floor: claim.floor, level, seed, now },
      arena,
    );
    const f = new FightRuntime(
      { event: claim.event, until: claim.until, hp: 1, maxHp: 1 },
      now,
      seed,
      engine,
    );
    f.towerUid = uid;
    return f;
  }

  /** The Tower's floors, if this is the Tower. */
  get tower(): TowerEngine | null {
    return this.engine instanceof TowerEngine ? this.engine : null;
  }

  /** The boss, if this is the cave. */
  get boss(): BossEngine | null {
    return this.engine instanceof BossEngine ? this.engine : null;
  }

  /** On to the next floor, if this one's cleared. */
  next(uid: string, now: number): Outbound[] {
    const tower = this.tower;
    const p = this.players.get(uid);
    if (!tower || !p?.present || p.down || !this.open) return [];
    if (!tower.next(now)) return [];
    // A breather on arrival, as on joining.
    tower.noteSpawn(uid, now);
    this.history.forget(uid);
    return [{ to: "all", msg: { t: "floor", ...tower.view() } }];
  }

  get open(): boolean {
    return this.closesAt === null;
  }

  /** A raid that's under way (locked, not over): the room keeps time for
   * it even with nobody connected. */
  get running(): boolean {
    return !!this.boss && this.stage === "fight" && this.open;
  }

  /** Whether `uid` may come in now: anyone on their feet in the lobby;
   * after the lock, only the roster (a downed member too, to wait for a
   * Bard); nobody once it's over. */
  mayJoin(uid: string, down: boolean, now: number): JoinVerdict {
    if (!this.open || this.stage === "over") return "closed";
    if (this.stage === "lobby") {
      // Past its start, a lobby that hasn't locked yet (an empty room
      // waiting on its next tick, or one just rebuilt) is shut: the
      // roster is whoever was already inside.
      if (now >= this.startsAt) return "locked";
      return down ? "down" : "ok";
    }
    if (!this.roster) return down ? "down" : "ok";
    const since = this.absentSince.get(uid);
    if (since !== undefined && now - since >= BOSS_OUT_GRACE_MS)
      return "locked";
    return this.roster.get(uid) === "in" ? "ok" : "locked";
  }

  /** Whether `uid` is fighting (on the roster and not out; anyone, without
   * a roster). */
  private fighting(uid: string): boolean {
    return !this.roster || this.roster.get(uid) === "in";
  }

  /** Someone arrives. Health is the lower of what their ticket says and what
   * this fight remembers, so a quick leave and rejoin heals nothing. */
  join(
    uid: string,
    id: number,
    ticket: TownTicketPayload,
    at: { x: number; z: number },
    now: number,
  ): FightPlayer {
    const maxHp = ticket.hp?.maxHp ?? 105;
    const fromTicket = ticket.hp?.down ? 0 : (ticket.hp?.hp ?? maxHp);
    // The ticket is the database's word (the room insists it's fresh). The
    // one time it can be behind is a leave whose report hasn't landed yet:
    // then what this fight remembers is truer, and rejoining mustn't heal.
    const known = this.players.get(uid);
    const behind = !!known && this.leftUnreported.has(uid);
    // A revive the database hasn't taken yet: the fight's word stands.
    const revivedHere =
      !!known && !known.down && this.revivedQueue.some((r) => r.uid === uid);
    const hp = revivedHere
      ? known.hp
      : behind
        ? Math.min(known.hp, fromTicket)
        : fromTicket;
    const down =
      !revivedHere && (ticket.hp?.down || hp <= 0 || (behind && known.down));
    if (!down) this.downAcked.delete(uid);
    const p: FightPlayer = {
      uid,
      name: ticket.name,
      look: ticket.look,
      id,
      hp,
      maxHp,
      down: !!down,
      stats: statsOf(ticket.st),
      present: true,
      skills: skillsOf(ticket),
      ...armsOf(ticket),
      cls: isHerzieClass(ticket.cls) ? ticket.cls : null,
      level: Math.max(1, Math.floor(ticket.lv ?? 1)),
      // A rejoin doesn't reset cooldowns.
      ready: known?.ready ?? new Map(),
    };
    this.players.set(uid, p);
    this.absentSince.delete(uid);
    this.history.record(uid, now, at.x, at.z);
    this.engine.noteSpawn(uid, now);
    // The Tower's room outlives a visit: the level is today's, not the
    // one it was made with.
    if (this.tower && ticket.lv) this.tower.level = Math.max(1, ticket.lv);
    this.raidDirty = true;
    return p;
  }

  /** Where a downed roster member who left comes back: where it fell. */
  rejoinAt(uid: string): { x: number; z: number } | null {
    const p = this.players.get(uid);
    if (!p || p.present || !p.down || !this.fighting(uid)) return null;
    return p.leftAt ?? null;
  }

  /** Someone left (or lost their connection). Their health stays on record;
   * a roster member who stays gone too long is out. */
  leave(uid: string, now: number = Date.now()): void {
    const p = this.players.get(uid);
    if (!p) return;
    p.present = false;
    p.leftAt = this.history.at(uid, now) ?? p.leftAt;
    this.history.forget(uid);
    // Its threat, buffs (in tune too) and taunt go with it; a rejoin starts
    // the music over.
    this.engine.forget(uid);
    this.tunes.delete(uid);
    // The stance goes too: it's sent again on the way back in.
    this.healers.delete(uid);
    this.leftUnreported.add(uid);
    this.absentSince.set(uid, now);
    this.reportNow = true;
    this.raidDirty = true;
  }

  /** A player's ticket was renewed: stats, class (a class chosen mid-fight
   * changes how they attack) and, in the Tower, level may change; health
   * never comes back up from a ticket mid-fight, and max HP stays as it
   * joined. Returns what to tell whom (the Tower's floor, if the level gap
   * moved). */
  renew(uid: string, ticket: TownTicketPayload): Outbound[] {
    const p = this.players.get(uid);
    if (!p) return [];
    // Skill levels only go up: a ticket issued before a level-up this fight
    // reported mustn't take it back.
    for (const [skill, level] of skillsOf(ticket))
      p.skills.set(skill, Math.max(level, p.skills.get(skill) ?? 0));
    // Gear may have changed too (an instrument put on or taken off).
    p.look = ticket.look;
    Object.assign(p, armsOf(ticket));
    // Its lute put away: no more heal stance.
    const unhealed: Outbound[] = [];
    if (this.healers.has(uid) && !(p.armed && p.attack === "wave")) {
      this.healers.delete(uid);
      unhealed.push({ to: "all", msg: { t: "stance", id: p.id, heal: false } });
    }
    p.cls = isHerzieClass(ticket.cls) ? ticket.cls : null;
    if (ticket.lv) p.level = Math.max(1, Math.floor(ticket.lv));
    if (ticket.st) p.stats = statsOf(ticket.st);
    const tower = this.tower;
    if (tower && ticket.lv && ticket.lv !== tower.level) {
      tower.level = Math.max(1, ticket.lv);
      return [...unhealed, { to: "all", msg: { t: "floor", ...tower.view() } }];
    }
    return unhealed;
  }

  player(uid: string): FightPlayer | undefined {
    return this.players.get(uid);
  }

  /** Whether `uid`'s herzie lies where it fell: knocked out in the cave.
   * The room ignores its moves, so every client and the server agree on
   * where a Bard must go. */
  frozen(uid: string): boolean {
    const p = this.players.get(uid);
    return !!this.boss && !!p?.present && p.down;
  }

  onState(uid: string, x: number, z: number, now: number): void {
    const p = this.players.get(uid);
    // A downed herzie stays where it fell, so a Bard can find it.
    if (p?.present && !p.down) this.history.record(uid, now, x, z);
  }

  /** A cast. Ignored once knocked out, out of the fight, or when the fight
   * is over. */
  cast(
    uid: string,
    yaw: number,
    pitch: number,
    now: number,
  ): "hit" | "miss" | "cooldown" | "dead" | "ignored" {
    const p = this.players.get(uid);
    if (!p?.present || p.down || !this.open || !this.fighting(uid))
      return "ignored";
    const pos = this.history.at(uid, now);
    if (!pos) return "ignored";
    if (this.healers.has(uid) && p.attack === "wave")
      return this.healBolt(p, pos, yaw, pitch, now);
    return this.engine.cast(
      uid,
      pos,
      yaw,
      pitch,
      p.stats,
      now,
      p.attack,
      p.melee,
    );
  }

  /**
   * A Bard switched its lute's stance. Only a Bard with its lute can heal;
   * anyone else asking is just told they attack. Returns the word for the
   * room (no word if nothing changed).
   */
  stance(uid: string, heal: boolean): Outbound[] {
    const p = this.players.get(uid);
    if (!p) return [];
    const can = heal && p.cls === "bard" && p.armed && p.attack === "wave";
    if (can === this.healers.has(uid)) return [];
    if (can) this.healers.add(uid);
    else this.healers.delete(uid);
    return [{ to: "all", msg: { t: "stance", id: p.id, heal: can } }];
  }

  /** A heal bolt: at the ally nearest the aim (never yourself, never the
   * knocked out, who need a Resurrect), as the room saw them a moment ago.
   * It spends a cast like a wave does, and lands after a wave's flight. */
  private healBolt(
    p: FightPlayer,
    pos: { x: number; z: number },
    yaw: number,
    pitch: number,
    now: number,
  ): "hit" | "miss" | "cooldown" {
    if (!this.engine.spendCast(p.uid, now)) return "cooldown";
    const allies: { uid: string; x: number; z: number }[] = [];
    for (const o of this.players.values()) {
      if (o === p || !o.present || o.down || !this.fighting(o.uid)) continue;
      const at =
        this.history.at(o.uid, now - TUNING.seenLagMs) ??
        this.history.at(o.uid, now);
      if (at) allies.push({ uid: o.uid, x: at.x, z: at.z });
    }
    const hit = healTarget(
      [pos.x, WAVE_HAND_HEIGHT, pos.z],
      aimDirection(yaw, pitch),
      allies,
      HEAL_LOCK_ANGLE + HEAL_LOCK_SLACK,
    );
    if (!hit) return "miss";
    this.bolts.push({
      by: p.uid,
      target: hit.ally.uid,
      at: now + (hit.dist / WAVE_SPEED) * 1000,
    });
    return "hit";
  }

  /** Heal bolts that have arrived: what each restores, up to full. */
  private landBolts(now: number, out: Outbound[]) {
    if (!this.bolts.length) return;
    const due = this.bolts.filter((b) => b.at <= now);
    if (!due.length) return;
    this.bolts = this.bolts.filter((b) => b.at > now);
    for (const b of due) {
      const bard = this.players.get(b.by);
      const o = this.players.get(b.target);
      if (!bard || !o?.present || o.down) continue;
      const heal = Math.min(
        o.maxHp - o.hp,
        HEAL_BOLT *
          healMult(bard.stats.euphony) *
          this.healBoost(b.by, now) *
          o.maxHp,
      );
      if (!(heal > 0)) continue;
      o.hp += heal;
      this.healed.set(o.uid, (this.healed.get(o.uid) ?? 0) + heal);
      out.push({
        to: "all",
        msg: { t: "hp", id: o.id, hp: o.hp, maxHp: o.maxHp },
      });
      this.credit(b.by, "healing", heal);
      this.engine.addThreat(b.by, heal * TUNING.threat.perHeal);
      this.reportNow = true;
    }
  }

  /**
   * A class skill. The fight decides everything: whether this herzie has
   * the skill, whether it's ready, and what it does. Returns what became of
   * it, plus what to tell whom.
   */
  skill(
    uid: string,
    skillId: string,
    yaw: number,
    pitch: number,
    now: number,
  ): {
    result: SkillResult;
    readyAt: number;
    reason?: SkillRefusal;
    out: Outbound[];
  } {
    const out: Outbound[] = [];
    const p = this.players.get(uid);
    if (!p?.present || p.down || !this.open || !this.fighting(uid))
      return { result: "ignored", readyAt: 0, out };
    if (!isSkillId(skillId) || !p.skills.has(skillId))
      return { result: "unknown", readyAt: 0, out };
    // A class skill is played on the class's instrument.
    if (!p.armed)
      return { result: "refused", readyAt: 0, reason: "instrument", out };
    const pos = this.history.at(uid, now);
    if (!pos) return { result: "ignored", readyAt: 0, out };
    const readyAt = p.ready.get(skillId) ?? 0;
    if (now < readyAt) {
      const early = readyAt - now <= SKILL_COOLDOWN_GRACE_MS;
      return { result: early ? "early" : "cooldown", readyAt, out };
    }
    const def = SKILL_DEFS[skillId];
    const level = p.skills.get(skillId) ?? 1;
    const value = skillValue(skillId, level);
    const boss = this.boss;

    // A revive and a taunt only mean something in a fight.
    if (
      (skillId === "resurrect" || skillId === "taunt") &&
      (!boss || this.stage !== "fight")
    )
      return { result: "refused", readyAt: 0, reason: "not-yet", out };

    if (skillId === "resurrect") {
      if (this.channels.has(uid)) return { result: "ignored", readyAt: 0, out };
      const target = this.nearestDowned(pos, def.radius ?? 0, now);
      if (!target)
        return { result: "refused", readyAt: 0, reason: "no-target", out };
      const until = now + (def.channelMs ?? 0);
      this.channels.set(uid, { target: target.uid, until, ...pos, level });
      // Pressing it again mid-channel does nothing; the cooldown proper
      // starts when it lands, and a cancelled one costs none.
      p.ready.set(skillId, until);
      out.push(this.skillCast(p, skillId, level, pos, yaw));
      out.push({
        to: "all",
        msg: { t: "channel", by: p.id, target: target.id, until },
      });
      return { result: "used", readyAt: until, out };
    }

    p.ready.set(skillId, now + def.cooldownMs);
    out.push(this.skillCast(p, skillId, level, pos, yaw));

    if (skillId === "soothing-drones") {
      let restored = 0;
      const mult = healMult(p.stats.euphony) * this.healBoost(uid, now);
      for (const o of this.players.values()) {
        if (!o.present || o.down) continue;
        const at = this.history.at(o.uid, now);
        if (!at) continue;
        if (Math.hypot(at.x - pos.x, at.z - pos.z) > (def.radius ?? 0))
          continue;
        const heal = Math.min(o.maxHp - o.hp, value * mult * o.maxHp);
        if (heal <= 0) continue;
        o.hp += heal;
        restored += heal;
        this.healed.set(o.uid, (this.healed.get(o.uid) ?? 0) + heal);
        out.push({
          to: "all",
          msg: { t: "hp", id: o.id, hp: o.hp, maxHp: o.maxHp },
        });
        this.reportNow = true;
      }
      // Overheal earns nothing: only what was really restored.
      this.earn(uid, skillId, skillXpFor(skillId, restored));
      this.credit(uid, "healing", restored);
      this.engine.addThreat(uid, restored * TUNING.threat.perHeal);
    } else if (skillId === "cymbrella") {
      const buff = this.engine.buff(uid, {
        id: "cymbrella",
        value: value * buffMult(p.stats.euphony),
        until: now + (def.durationMs ?? 0),
      });
      this.engine.addThreat(uid, TUNING.threat.cymbrella);
      out.push(this.buffMsg(p.id, buff));
    } else if (skillId === "haste") {
      // Everyone standing near (the Bard too), for its length. Euphony
      // strengthens it like any buff, to a ceiling.
      const strength = Math.min(HASTE_MAX, value * buffMult(p.stats.euphony));
      const until = now + (def.durationMs ?? 0);
      for (const o of this.players.values()) {
        if (!o.present || o.down) continue;
        const at = this.history.at(o.uid, now);
        if (!at) continue;
        if (Math.hypot(at.x - pos.x, at.z - pos.z) > (def.radius ?? 0))
          continue;
        const buff = this.engine.buff(o.uid, {
          id: "haste",
          value: strength,
          until,
          by: uid,
        });
        out.push(this.buffMsg(o.id, buff));
      }
    } else if (skillId === "backspin") {
      this.engine.backspin(uid, pos, yaw, pitch, p.stats, value, now);
    } else if (skillId === "taunt" && boss) {
      const until = now + (def.durationMs ?? 0);
      const before = boss.setTaunt(uid, until, now);
      if (before) out.push(...this.untaunt(before));
      const buff = boss.buff(uid, { id: "taunt", value: 1, until });
      // Top of its list when the taunt runs out, so it doesn't snap back
      // at once to whoever it hated before.
      boss.tauntThreat(uid);
      out.push(this.buffMsg(p.id, buff));
      this.raidDirty = true;
    }
    return { result: "used", readyAt: now + def.cooldownMs, out };
  }

  private skillCast(
    p: FightPlayer,
    skill: SkillId,
    level: number,
    pos: { x: number; z: number },
    yaw: number,
  ): Outbound {
    return {
      to: "all",
      msg: {
        t: "skill",
        by: p.id,
        skill,
        level,
        x: round(pos.x),
        z: round(pos.z),
        yaw: round(yaw),
      },
    };
  }

  private buffMsg(
    id: number,
    buff: { id: string; value: number; until: number; kind?: string },
  ): Outbound {
    return {
      to: "all",
      msg: {
        t: "buff",
        id,
        buff: buff.id,
        value: buff.value,
        until: buff.until,
        ...(buff.kind ? { kind: buff.kind } : {}),
      },
    };
  }

  /** How much stronger `uid`'s heals are right now (an in-tune Bard). */
  private healBoost(uid: string, now: number): number {
    return buffMultiplier(this.engine.buffsOf(uid, now), "heal", now);
  }

  /** The downed fighter nearest to `pos` within `radius`, if any. */
  private nearestDowned(
    pos: { x: number; z: number },
    radius: number,
    now: number,
  ): FightPlayer | null {
    let best: FightPlayer | null = null;
    let bestD = radius;
    for (const o of this.players.values()) {
      if (!o.present || !o.down || !this.fighting(o.uid)) continue;
      if ([...this.channels.values()].some((c) => c.target === o.uid)) continue;
      const at = this.history.at(o.uid, now);
      if (!at) continue;
      const d = Math.hypot(at.x - pos.x, at.z - pos.z);
      if (d <= bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  /** Whether a herzie is playing music (the boss hates it, any of it). The
   * room rate-limits these. */
  tune(uid: string, playing: boolean, now: number): void {
    const prev = this.tunes.get(uid);
    if (prev && prev.playing === playing) return;
    this.tunes.set(uid, {
      playing,
      since: now,
      matching: false,
      on: prev?.on ?? false,
      onSince: prev?.onSince ?? now,
    });
  }

  /** Knocked out and giving up: out of the fight for good. */
  forfeit(uid: string, now: number): Outbound[] {
    const p = this.players.get(uid);
    if (!p || !this.roster || this.roster.get(uid) !== "in" || !p.down)
      return [];
    return this.markOut(uid, now);
  }

  private markOut(uid: string, now: number): Outbound[] {
    if (!this.roster || this.roster.get(uid) !== "in") return [];
    this.roster.set(uid, "out");
    this.outQueue.add(uid);
    this.log.outs++;
    this.reportNow = true;
    this.raidDirty = true;
    const out: Outbound[] = [...this.stopChannels(uid), ...this.untaunt(uid)];
    out.push(...this.setInTune(uid, false, now));
    if (this.players.get(uid)?.present)
      out.push({ to: { uid }, msg: { t: "out" } });
    return out;
  }

  /** Cancel any resurrect `uid` is playing or is the target of. */
  private stopChannels(uid: string): Outbound[] {
    const out: Outbound[] = [];
    for (const [by, c] of this.channels) {
      if (by !== uid && c.target !== uid) continue;
      this.channels.delete(by);
      const bard = this.players.get(by);
      if (bard) {
        bard.ready.delete("resurrect");
        out.push({
          to: "all",
          msg: { t: "channel", by: bard.id, target: null, until: 0 },
        });
      }
    }
    return out;
  }

  /** `uid` no longer holds the boss. */
  private untaunt(uid: string): Outbound[] {
    const boss = this.boss;
    if (!boss) return [];
    boss.dropTaunt(uid);
    this.raidDirty = true;
    if (!boss.clearBuff(uid, "taunt")) return [];
    const p = this.players.get(uid);
    return p
      ? [{ to: "all", msg: { t: "buffOff", id: p.id, buff: "taunt" } }]
      : [];
  }

  /**
   * Whether `uid` may eat now: present, standing, hurt, and past the
   * cooldown. Claims the cooldown when it says yes, so a second `eat` sent
   * while the first is still being used up in the database is refused.
   */
  tryEat(uid: string, now: number): EatRefusal | null {
    const p = this.players.get(uid);
    if (!p?.present || !this.open) return "not-here";
    if (p.down) return "down";
    if (p.hp >= p.maxHp) return "full";
    const since = now - (this.ate.get(uid) ?? Number.NEGATIVE_INFINITY);
    if (since < CONSUMABLE_COOLDOWN_MS - EAT_COOLDOWN_GRACE_MS)
      return "cooldown";
    this.ate.set(uid, now);
    return null;
  }

  /** What `uid` ate heals them, capped at their max; reported to the
   * database through `healed`, like a skill's heal. Nothing if they were
   * knocked out or left while it was being used up. */
  eat(uid: string, amount: number): Outbound[] {
    const p = this.players.get(uid);
    if (!p?.present || p.down || amount <= 0) return [];
    const heal = Math.min(p.maxHp - p.hp, amount);
    if (heal <= 0) return [];
    p.hp += heal;
    this.healed.set(uid, (this.healed.get(uid) ?? 0) + heal);
    this.reportNow = true;
    return [
      { to: "all", msg: { t: "hp", id: p.id, hp: p.hp, maxHp: p.maxHp } },
    ];
  }

  /** Skill XP for `uid`, toward the next report. */
  private earn(uid: string, skill: SkillId, xp: number) {
    // The local-dev boss is never reported: nothing to earn toward.
    if (!(xp > 0) || this.eventId === DEV_EVENT) return;
    const key = `${uid}|${skill}`;
    this.pendingXp.set(key, (this.pendingXp.get(key) ?? 0) + xp);
  }

  /** `town-vitals` says these skills now stand at these levels: use them,
   * and tell each owner about the ones that went up. */
  skillUps(
    levels: { uid: string; skill: string; level: number }[],
  ): Outbound[] {
    const out: Outbound[] = [];
    for (const l of levels) {
      const p = this.players.get(l.uid);
      if (!p || !isSkillId(l.skill)) continue;
      const was = p.skills.get(l.skill) ?? 0;
      if (l.level <= was) continue;
      p.skills.set(l.skill, l.level);
      if (p.present)
        out.push({
          to: { uid: l.uid },
          msg: { t: "skillUp", skill: l.skill, level: l.level },
        });
    }
    return out;
  }

  /** The raid as everyone sees it (without `you`). */
  private raid(now: number): RaidState | undefined {
    const boss = this.boss;
    if (!boss) return undefined;
    const members = this.roster
      ? [...this.roster].filter(([, s]) => s === "in").map(([uid]) => uid)
      : [...this.players.values()].filter((p) => p.present).map((p) => p.uid);
    const standing = members.filter((uid) => {
      const p = this.players.get(uid);
      return p?.present && !p.down;
    }).length;
    const focus = boss.focus
      ? (this.players.get(boss.focus)?.id ?? null)
      : null;
    return {
      stage: this.stage,
      startsAt: this.startsAt,
      ...(this.lockedAt !== null
        ? {
            lockedAt: this.lockedAt,
            enrageAt: boss.enrageAt,
            hardAt: boss.hardAt,
          }
        : {}),
      roster: members.length,
      standing,
      focus: this.stage === "fight" ? focus : null,
      taunted: this.stage === "fight" && !!boss.taunter(now),
    };
  }

  private you(uid: string): RaidState["you"] {
    if (!this.roster) return "in";
    const s = this.roster.get(uid);
    return s === "in" ? "in" : s === "out" ? "out" : "watching";
  }

  /** What a newcomer needs to see the fight as it stands. */
  state(now: number, uid?: string): FightState {
    const boss = this.boss;
    const raid = this.raid(now);
    return {
      event: this.eventId,
      hp: this.engine.hp,
      maxHp: this.engine.maxHp,
      phase: this.engine.currentPhase,
      telegraphs: this.engine.active.map((t) => this.wire(t)),
      health: [...this.players.values()]
        .filter((p) => p.present)
        .map((p) => ({ id: p.id, hp: p.hp, maxHp: p.maxHp })),
      ...(this.tower ? { tower: this.tower.view() } : {}),
      buffs: this.engine.activeBuffs(now).flatMap(({ uid, buff }) => {
        const p = this.players.get(uid);
        return p?.present
          ? [
              {
                id: p.id,
                buff: buff.id,
                value: buff.value,
                until: buff.until,
                ...(buff.kind ? { kind: buff.kind } : {}),
              },
            ]
          : [];
      }),
      now,
      ...(raid
        ? { raid: { ...raid, you: uid ? this.you(uid) : undefined } }
        : {}),
      ...(boss
        ? {
            bossAt: {
              x: round(boss.position.x),
              z: round(boss.position.z),
              yaw: round(boss.position.yaw),
            },
          }
        : {}),
      ...(this.say && this.say.until > now ? { say: this.say } : {}),
      ...(this.healers.size
        ? {
            healers: [...this.healers].flatMap((u) => {
              const h = this.players.get(u);
              return h?.present ? [h.id] : [];
            }),
          }
        : {}),
      ...(boss?.minionsUp ? { mobs: boss.wireMobs() } : {}),
      ...(this.channels.size
        ? {
            channels: [...this.channels].flatMap(([by, c]) => {
              const bard = this.players.get(by);
              const target = this.players.get(c.target);
              return bard && target
                ? [{ by: bard.id, target: target.id, until: c.until }]
                : [];
            }),
          }
        : {}),
    };
  }

  /** Advance the fight to `now`. */
  step(now: number): Outbound[] {
    const out: Outbound[] = [];
    const boss = this.boss;
    if (boss && this.open) this.stepRaid(now, out);
    const alive: BossPlayer[] = [];
    for (const p of this.players.values()) {
      if (!p.present || !this.fighting(p.uid)) continue;
      alive.push({
        uid: p.uid,
        alive: !p.down,
        maxHp: p.maxHp,
        def: p.stats.def,
        posAt: (t) => this.history.at(p.uid, t),
      });
    }
    if (this.open) {
      for (const ev of this.engine.update(now, alive)) this.apply(ev, out, now);
      this.landBolts(now, out);
      const tower = this.tower;
      if (tower) {
        this.bossDirty = false;
        const mobs = tower.wireMobsChanged();
        if (mobs.length)
          out.push({ to: "all", msg: { t: "mobs", mobs, at: now } });
      }
      if (boss?.minionsUp) {
        const mobs = boss.wireMobsChanged();
        if (mobs.length)
          out.push({ to: "all", msg: { t: "mobs", mobs, at: now } });
      }
      if (this.bossDirty) {
        this.bossDirty = false;
        out.push({
          to: "all",
          msg: {
            t: "boss",
            hp: this.engine.hp,
            maxHp: this.engine.maxHp,
            phase: this.engine.currentPhase,
          },
        });
      }
      if (boss?.takeMoved()) {
        const at = boss.position;
        out.push({
          to: "all",
          msg: {
            t: "bossAt",
            at: now,
            x: round(at.x),
            z: round(at.z),
            yaw: round(at.yaw),
          },
        });
      }
      if (this.open && now >= this.until) {
        this.close("escaped", now, now + ESCAPE_LINGER_MS, out);
      }
    }
    if (boss) {
      this.sayQueued(now, out);
      this.tick(now, out);
    }
    // The dev boss's end screen comes from the room itself, at once.
    if (this.closeWhy && this.eventId === DEV_EVENT && !this.resultsSent)
      out.push(...this.results(this.devTable()));
    return out;
  }

  /** The raid's own clock: the lock, who's out, resurrects, the music, the
   * boss's lines, a wipe. */
  private stepRaid(now: number, out: Outbound[]) {
    const boss = this.boss as BossEngine;
    // The boss sleeps through the lobby: not a word until it wakes.
    if (this.stage === "lobby" && now >= this.startsAt) this.lock(now, out);
    if (this.stage === "fight" && this.roster) {
      // Gone too long: out.
      for (const [uid, since] of this.absentSince) {
        if (this.roster.get(uid) === "in" && now - since >= BOSS_OUT_GRACE_MS)
          out.push(...this.markOut(uid, now));
      }
      this.stepChannels(now, out);
      // Everyone in is down or gone for good: the boss won. Someone away
      // (inside the grace, or not back since a restart) still counts as
      // standing unless they went down.
      const hard = now >= boss.hardAt;
      const standing = [...this.roster].some(([uid, s]) => {
        if (s !== "in") return false;
        const p = this.players.get(uid);
        if (p?.present) return !p.down;
        // Away: standing for a little while, never through the hard enrage
        // (it would be the one way to dodge its pulse).
        if (hard || p?.down) return false;
        const since = this.absentSince.get(uid) ?? now;
        return now - since < (p ? ABSENT_STANDING_MS : UNSEEN_STANDING_MS);
      });
      if (!standing) {
        this.close("wiped", now, now + WIPE_LINGER_MS, out);
        return;
      }
      if (boss.taunter(now)) this.log.tauntMs += now - this.log.lastAt;
    }
    this.stepTunes(now, out);
    if (this.stage === "fight" && now >= this.nextTallyAt) {
      this.nextTallyAt = now + TALLY_EVERY_MS;
      out.push(...this.tallies());
    }
    if (this.stage === "fight" && now - this.lastSayAt >= SAY_EVERY_MS)
      this.speak("remind", now, out);
    this.log.lastAt = now;
  }

  /** Each fighter's own contribution and where it ranks, to them alone. */
  private tallies(): Outbound[] {
    const scores = [...this.dealt].map(
      ([uid, c]) => [uid, contributionOf(c)] as const,
    );
    if (!scores.length) return [];
    scores.sort((a, b) => b[1] - a[1]);
    const of = this.roster?.size ?? scores.length;
    const out: Outbound[] = [];
    scores.forEach(([uid, score], i) => {
      if (!this.players.get(uid)?.present) return;
      out.push({
        to: { uid },
        msg: { t: "tally", score: Math.round(score), rank: i + 1, of },
      });
    });
    return out;
  }

  /** The lobby locks: whoever stands in the room is in, the boss wakes at a
   * health sized to them, and the door shuts. Nobody here: no fight. */
  private lock(now: number, out: Outbound[]) {
    const boss = this.boss as BossEngine;
    const uids = [...this.players.values()]
      .filter(
        (p) =>
          !p.down &&
          (p.present ||
            now - (this.absentSince.get(p.uid) ?? -Infinity) < LOCK_GRACE_MS),
      )
      .map((p) => p.uid);
    this.lockedAt = now;
    this.roster = new Map(uids.map((uid) => [uid, "in" as const]));
    this.lockReq = {
      event: this.eventId,
      uids,
      at: now,
      hpPerPlayer: this.hpPerPlayer,
    };
    this.reportNow = true;
    this.raidDirty = true;
    if (!uids.length) {
      this.close("escaped", now, now + ESCAPE_LINGER_MS, out);
      return;
    }
    this.stage = "fight";
    const maxHp = bossMaxHp(uids.length, this.hpPerPlayer);
    boss.wake(now, maxHp, maxHp);
    this.bossDirty = true;
    // Anyone who came in down (they can't, but a stale ticket might say
    // so) or left during the lobby isn't in.
    for (const p of this.players.values()) {
      if (!this.roster.has(p.uid) && p.present)
        out.push({ to: { uid: p.uid }, msg: { t: "out" } });
    }
    this.speak("start", now, out);
  }

  private stepChannels(now: number, out: Outbound[]) {
    for (const [by, c] of [...this.channels]) {
      const bard = this.players.get(by);
      const target = this.players.get(c.target);
      const at = bard ? this.history.at(by, now) : null;
      const ok =
        bard?.present &&
        !bard.down &&
        at &&
        Math.hypot(at.x - c.x, at.z - c.z) <= CHANNEL_SLACK &&
        target?.present &&
        target.down &&
        this.fighting(target.uid);
      if (!ok) {
        out.push(...this.stopChannels(by));
        continue;
      }
      if (now < c.until) continue;
      this.channels.delete(by);
      this.revive(bard, target, c.level, now, out);
    }
  }

  /** Everyone in the fight who's down stands up with a share of their
   * health, told to the database like a resurrect. `by` -1: nobody's
   * doing (the boss fell). */
  private riseAll(now: number): Outbound[] {
    const out: Outbound[] = [];
    for (const p of this.players.values()) {
      if (!p.down || !this.fighting(p.uid)) continue;
      const hp = Math.max(1, Math.round(p.maxHp * VICTORY_RISE_SHARE));
      p.down = false;
      p.hp = hp;
      this.downAcked.delete(p.uid);
      this.healed.delete(p.uid);
      this.revivedQueue = [
        ...this.revivedQueue.filter((r) => r.uid !== p.uid),
        { uid: p.uid, hp },
      ];
      out.push(
        { to: "all", msg: { t: "revived", id: p.id, by: -1 } },
        { to: "all", msg: { t: "hp", id: p.id, hp, maxHp: p.maxHp } },
      );
    }
    if (out.length) this.reportNow = true;
    return out;
  }

  /** `bard` brings `target` back to its feet. */
  private revive(
    bard: FightPlayer,
    target: FightPlayer,
    level: number,
    now: number,
    out: Outbound[],
  ) {
    const def = SKILL_DEFS.resurrect;
    const share =
      skillValue("resurrect", level) *
      healMult(bard.stats.euphony) *
      this.healBoost(bard.uid, now);
    const hp = Math.max(
      1,
      Math.min(target.maxHp, Math.round(target.maxHp * share)),
    );
    target.down = false;
    target.hp = hp;
    this.downAcked.delete(target.uid);
    this.healed.delete(target.uid);
    this.engine.noteSpawn(target.uid, now);
    this.log.revives++;
    this.revivedQueue = [
      ...this.revivedQueue.filter((r) => r.uid !== target.uid),
      { uid: target.uid, hp },
    ];
    bard.ready.set("resurrect", now + def.cooldownMs);
    this.earn(bard.uid, "resurrect", skillXpFor("resurrect", hp));
    this.credit(bard.uid, "healing", hp);
    this.engine.addThreat(bard.uid, hp * TUNING.threat.perHeal);
    this.reportNow = true;
    this.raidDirty = true;
    out.push(
      { to: "all", msg: { t: "channel", by: bard.id, target: null, until: 0 } },
      { to: "all", msg: { t: "revived", id: target.id, by: bard.id } },
      {
        to: "all",
        msg: { t: "hp", id: target.id, hp: target.hp, maxHp: target.maxHp },
      },
    );
  }

  /** In tune or not: whether each classed fighter is playing music, with
   * the settle and linger times. */
  private stepTunes(now: number, out: Outbound[]) {
    for (const p of this.players.values()) {
      if (!p.present) continue;
      const bonus = inTuneBonus(p.cls);
      const t = this.tunes.get(p.uid);
      if (!bonus || !t) continue;
      const matching =
        t.playing && this.fighting(p.uid) && this.stage !== "over";
      if (matching !== t.matching) {
        t.matching = matching;
        t.since = now;
      }
      if (!t.on && matching && now - t.since >= IN_TUNE.settleMs)
        out.push(...this.setInTune(p.uid, true, now));
      else if (t.on && !matching && now - t.since >= IN_TUNE.lingerMs)
        out.push(...this.setInTune(p.uid, false, now));
    }
  }

  private setInTune(uid: string, on: boolean, now: number): Outbound[] {
    const p = this.players.get(uid);
    const t = this.tunes.get(uid);
    if (!p || !t || t.on === on) return [];
    t.on = on;
    if (!on) {
      // Only the fight counts: time in tune in the lobby isn't play.
      if (this.lockedAt !== null) {
        const cls = p.cls ?? "none";
        const ms = Math.max(0, now - Math.max(t.onSince, this.lockedAt));
        this.log.inTuneMs[cls] = (this.log.inTuneMs[cls] ?? 0) + ms;
      }
      this.engine.clearBuff(uid, "in_tune");
      return [{ to: "all", msg: { t: "buffOff", id: p.id, buff: "in_tune" } }];
    }
    t.onSince = now;
    const bonus = inTuneBonus(p.cls);
    if (!bonus) return [];
    const buff = this.engine.buff(uid, {
      id: "in_tune",
      kind: bonus.kind,
      value: bonus.value,
      until: now + OPEN_ENDED_MS,
    });
    return [this.buffMsg(p.id, buff)];
  }

  /** The boss calls a pack of Thornlings: about one per two herzies in the
   * fight, a little below the raid's average level (or the event's floor). */
  private summon(now: number, out: Outbound[]) {
    const boss = this.boss;
    if (!boss) return;
    const fighters = [...this.players.values()].filter(
      (p) => p.present && this.fighting(p.uid),
    );
    const roster = this.roster
      ? [...this.roster.values()].filter((s) => s === "in").length
      : fighters.length;
    const level = fighters.length
      ? fighters.reduce((n, p) => n + p.level, 0) / fighters.length
      : MINION_FLOOR;
    const herzies = fighters.flatMap((p) => {
      const at = this.history.at(p.uid, now);
      return at ? [at] : [];
    });
    boss.summon(
      now,
      minionPackSize(Math.max(1, roster), this.rand),
      this.minionFloor ?? minionFloorFor(level),
      Math.round(level),
      herzies,
    );
    this.speak("minions", now, out, true);
  }

  /** The boss says a line of `kind`, if it has one. A reminder waits for
   * a quiet moment (or is dropped); a line that matters (`force`) waits
   * its turn behind one that's only just gone up. */
  private speak(
    kind: BossLineKind,
    now: number,
    out: Outbound[],
    force = false,
  ) {
    if (!force && now - this.lastSayAt < SAY_GAP_MS) return;
    const text = bossLine(kind, this.rand);
    if (force && (this.sayQueue.length || now - this.lastSayAt < SAY_READ_MS)) {
      this.sayQueue = [...this.sayQueue, text].slice(-2);
      return;
    }
    this.sayNow(text, now, out);
  }

  private sayNow(text: string, now: number, out: Outbound[]) {
    this.lastSayAt = now;
    this.say = { text, until: now + bossLineMs(text) };
    out.push({ to: "all", msg: { t: "say", ...this.say } });
  }

  /** The next queued line, once the one up has been read. */
  private sayQueued(now: number, out: Outbound[]) {
    if (!this.sayQueue.length || now - this.lastSayAt < SAY_READ_MS) return;
    const [next, ...rest] = this.sayQueue;
    this.sayQueue = rest;
    this.sayNow(next, now, out);
  }

  /** Ends the fight: the room shuts at `closesAt`. */
  private close(
    why: "victory" | "escaped" | "wiped",
    now: number,
    closesAt: number,
    out: Outbound[],
  ) {
    if (this.closeWhy) return;
    this.closesAt = closesAt;
    this.closeWhy = why;
    this.reportNow = true;
    this.raidDirty = true;
    const boss = this.boss;
    if (boss) {
      this.stage = "over";
      for (const by of [...this.channels.keys()])
        out.push(...this.stopChannels(by));
      for (const uid of this.tunes.keys())
        out.push(...this.setInTune(uid, false, now));
      if (why === "wiped") {
        this.wipePending = this.eventId !== DEV_EVENT;
        this.speak("wipe", now, out, true);
      }
      // It fell: whoever's still in and down gets up, to walk to their
      // loot (nobody can be played back up once the fight's over).
      if (why === "victory") out.push(...this.riseAll(now));
      if (this.lockedAt !== null && this.roster && this.eventId !== DEV_EVENT)
        this.logPending = {
          event: this.eventId,
          roster: this.roster.size,
          outcome: why,
          lockedAt: this.lockedAt,
          endedAt: now,
          downs: this.log.downs,
          revives: this.log.revives,
          outs: this.log.outs,
          inTuneMs: this.log.inTuneMs,
          tauntMs: Math.round(this.log.tauntMs),
          maxHp: this.engine.maxHp,
        };
    }
    if (why !== "victory")
      out.push({ to: "all", msg: { t: "closing", why, closesAt } });
  }

  /** Raid news everyone needs once per tick at most. */
  private tick(now: number, out: Outbound[]) {
    const focus = this.boss?.focus ?? null;
    if (focus !== this.lastFocus) {
      this.lastFocus = focus;
      this.raidDirty = true;
    }
    if (!this.raidDirty) return;
    this.raidDirty = false;
    const raid = this.raid(now);
    if (raid) out.push({ to: "all", msg: { t: "raid", ...raid } });
  }

  private apply(ev: BossEvent | TowerEvent, out: Outbound[], now: number) {
    switch (ev.t) {
      case "mobDown":
        if (this.tower)
          this.towerKills.push({
            floor: this.tower.floor,
            x: round(ev.x),
            z: round(ev.z),
          });
        out.push({
          to: "all",
          msg: { t: "mobDown", mob: ev.mob, x: round(ev.x), z: round(ev.z) },
        });
        break;
      case "cleared":
        this.towerCleared = Math.max(this.towerCleared, ev.floor);
        this.reportNow = true;
        if (this.tower)
          out.push({ to: "all", msg: { t: "floor", ...this.tower.view() } });
        break;
      case "telegraph":
        out.push({
          to: "all",
          msg: { t: "telegraph", ...this.wire(ev.telegraph) },
        });
        break;
      case "resolve": {
        const hit: number[] = [];
        const taunter = this.boss?.taunter(now);
        for (const h of ev.hits) {
          const p = this.players.get(h.uid);
          if (!p || p.down) continue;
          p.hp = Math.max(0, p.hp - h.damage);
          hit.push(p.id);
          // The Cymbrella is a self buff: what it took off (on top of Def)
          // pays its wearer, and counts as their support.
          if (h.blocked > 0) {
            this.earn(p.uid, "cymbrella", skillXpFor("cymbrella", h.blocked));
            this.credit(p.uid, "blocked", h.blocked);
          }
          // A taunt pays for the hits it drew.
          if (h.aimed && taunter === p.uid && p.skills.has("taunt"))
            this.earn(
              p.uid,
              "taunt",
              skillXpFor("taunt", h.damage + h.absorbed),
            );
          out.push({
            to: "all",
            msg: { t: "hp", id: p.id, hp: p.hp, maxHp: p.maxHp },
          });
          if (p.hp <= 0) {
            p.down = true;
            this.log.downs++;
            // Knocked out: nothing left to raise the stored health toward.
            this.healed.delete(p.uid);
            out.push(...this.stopChannels(p.uid));
            out.push({ to: { uid: p.uid }, msg: { t: "down" } });
            // Where it fell is where it lies: put the client there.
            const at = this.history.at(p.uid, now);
            if (at && this.boss)
              out.push({
                to: { uid: p.uid },
                msg: { t: "correct", x: round(at.x), z: round(at.z) },
              });
            this.raidDirty = true;
          }
          this.reportNow = true;
        }
        out.push({ to: "all", msg: { t: "resolve", id: ev.id, hits: hit } });
        break;
      }
      case "hit": {
        this.bossDirty = true;
        this.credit(
          ev.uid,
          ev.mob !== undefined && !this.tower ? "adds" : "damage",
          ev.damage,
        );
        if (ev.skill && isSkillId(ev.skill))
          this.earn(ev.uid, ev.skill, skillXpFor(ev.skill, ev.damage));
        // A hasted hit: the Bard who hasted them earns for the share of
        // their damage the haste added.
        {
          const haste = this.engine
            .buffsOf(ev.uid, now)
            .find((b) => b.id === "haste");
          if (haste?.by && ev.damage > 0)
            this.earn(
              haste.by,
              "haste",
              skillXpFor(
                "haste",
                (ev.damage * haste.value) / (1 + haste.value),
              ),
            );
        }
        out.push({
          to: { uid: ev.uid },
          msg: {
            t: "hit",
            damage: ev.damage,
            crit: ev.crit,
            ...(ev.mob !== undefined ? { mob: ev.mob } : {}),
          },
        });
        break;
      }
      case "phase":
        this.bossDirty = true;
        this.raidDirty = true;
        this.speak("phase", now, out, true);
        break;
      case "enrage":
        this.speak("enrage", now, out, true);
        break;
      case "pulse":
        this.speak("pulse", now, out, true);
        break;
      case "untaunt":
        out.push(...this.untaunt(ev.uid));
        break;
      case "rattled": {
        const p = this.players.get(ev.uid);
        if (p)
          out.push(
            this.buffMsg(p.id, {
              id: "rattled",
              value: ev.stacks,
              until: ev.until,
            }),
          );
        break;
      }
      case "minions":
        this.summon(now, out);
        break;
      case "killed": {
        const by = this.players.get(ev.by)?.id ?? 0;
        this.close("victory", now, now + VICTORY_LINGER_MS, out);
        if (this.boss) this.speak("victory", now, out, true);
        out.push({
          to: "all",
          msg: { t: "victory", by, closesAt: this.closesAt ?? now },
        });
        // The local-dev boss is never reported, so nothing would ever say
        // what dropped: give everyone here a CD to look at (no real drop
        // behind it, so picking it up collects nothing).
        if (this.eventId === DEV_EVENT) {
          const loot: Record<string, LootDrop[]> = {};
          for (const p of this.players.values())
            if (this.fighting(p.uid)) loot[p.uid] = [{ id: "", item: "cd" }];
          out.push(...this.loot(loot));
        }
        break;
      }
    }
  }

  /** The next report for `town-vitals`, if one is due (or `force`), else
   * null. The boss damage in it stays "in flight" and is re-sent unchanged
   * until {@link reported} says it landed. */
  report(now: number, force = false): FightReport | null {
    if (!force && !this.reportNow && now < this.nextReportAt) return null;
    this.nextReportAt = now + REPORT_EVERY_MS;
    this.reportNow = false;
    const dev = this.eventId === DEV_EVENT;
    // Someone who left already knocked out and told has nothing more to say.
    for (const uid of [...this.leftUnreported]) {
      const p = this.players.get(uid);
      if (p && !p.present && p.down && this.downAcked.has(uid))
        this.leftUnreported.delete(uid);
    }
    if (!this.inflight && this.pending.size) {
      this.inflight = {
        batch: `${this.eventId}:${now}:${++this.batchSeq}:${crypto.randomUUID()}`,
        damage: [...this.pending].map(([uid, c]) => {
          const row: BossRow = { uid, damage: c.damage };
          const healing = tenths(c.healing);
          const blocked = tenths(c.blocked);
          const adds = Math.round(c.adds ?? 0);
          if (healing > 0) row.healing = healing;
          if (blocked > 0) row.blocked = blocked;
          if (adds > 0) row.adds = adds;
          return row;
        }),
      };
      this.pending.clear();
    }
    if (!this.xpInflight) {
      const xp: { uid: string; skill: string; xp: number }[] = [];
      for (const [key, amount] of this.pendingXp) {
        const whole = Math.floor(amount);
        if (whole < 1) continue;
        const [uid, skill] = key.split("|");
        xp.push({ uid, skill, xp: whole });
        // Fractions carry over to the next report.
        this.pendingXp.set(key, amount - whole);
      }
      if (xp.length)
        this.xpInflight = {
          batch: `${this.eventId}:xp:${now}:${++this.batchSeq}:${crypto.randomUUID()}`,
          xp,
        };
    }
    if (!this.revivedInflight && this.revivedQueue.length && !dev) {
      this.revivedInflight = {
        event: this.eventId,
        batch: `${this.eventId}:rez:${now}:${++this.batchSeq}:${crypto.randomUUID()}`,
        rows: this.revivedQueue,
      };
      this.revivedQueue = [];
    }
    if (
      !this.towerInflight &&
      (this.towerKills.length || this.towerCleared) &&
      !dev
    ) {
      this.towerInflight = {
        event: this.eventId,
        batch: `${this.eventId}:tower:${now}:${++this.batchSeq}:${crypto.randomUUID()}`,
        uid: this.towerUid,
        kills: this.towerKills,
        ...(this.towerCleared ? { cleared: this.towerCleared } : {}),
      };
      this.towerKills = [];
      this.towerCleared = 0;
    }
    // Over: ask for the end screen's table, but only on a report whose
    // batch carries every hit there was (one re-sent from before would
    // leave the last of them out). Until it's back, report again soon.
    let results: FightReport["results"];
    if (this.closeWhy && !this.resultsSent && !dev) {
      if (!this.pending.size)
        results = {
          event: this.eventId,
          uids: [...this.players.values()]
            .filter((p) => p.present)
            .map((p) => p.uid),
        };
      this.nextReportAt = Math.min(this.nextReportAt, now + RESULTS_RETRY_MS);
    }
    const out = this.outQueue.size && !dev ? [...this.outQueue] : [];
    return {
      results,
      hp: [...this.players.values()]
        .filter((p) => p.present || this.leftUnreported.has(p.uid))
        .filter((p) => !(p.down && this.downAcked.has(p.uid)))
        // Out of the fight: the app respawns them; nothing more to say.
        .filter((p) => this.roster?.get(p.uid) !== "out")
        .map((p) => {
          const heal = Math.round(this.healed.get(p.uid) ?? 0);
          return heal > 0
            ? { uid: p.uid, hp: p.hp, heal }
            : { uid: p.uid, hp: p.hp };
        }),
      boss:
        this.inflight && !dev
          ? { event: this.eventId, ...this.inflight }
          : undefined,
      skills: this.xpInflight && !dev ? this.xpInflight : undefined,
      tower: this.towerInflight ?? undefined,
      ...(this.lockReq && !dev ? { lock: this.lockReq } : {}),
      ...(this.revivedInflight ? { revived: this.revivedInflight } : {}),
      ...(out.length ? { out: { event: this.eventId, uids: out } } : {}),
      ...(this.wipePending ? { wipe: { event: this.eventId } } : {}),
      ...(this.logPending && results ? { log: this.logPending } : {}),
    };
  }

  /** `town-vitals` took the report: what it carried needn't be re-sent. */
  reported(
    report: FightReport,
    raid?: RaidReply | null,
    now: number = Date.now(),
  ): Outbound[] {
    const out: Outbound[] = [];
    // Revives first: a revived herzie's 0 must not count as "told".
    if (report.revived && this.revivedInflight?.batch === report.revived.batch)
      this.revivedInflight = null;
    for (const r of report.hp) {
      if (!this.players.get(r.uid)?.present) this.leftUnreported.delete(r.uid);
      if (r.hp <= 0 && this.players.get(r.uid)?.down) this.downAcked.add(r.uid);
      // The database may now rise as far as that heal: it's spent.
      if (r.heal) {
        const left = (this.healed.get(r.uid) ?? 0) - r.heal;
        if (left > 0.5) this.healed.set(r.uid, left);
        else this.healed.delete(r.uid);
      }
    }
    if (report.boss && this.inflight?.batch === report.boss.batch) {
      this.inflight = null;
    }
    if (report.skills && this.xpInflight?.batch === report.skills.batch) {
      this.xpInflight = null;
    }
    if (report.tower && this.towerInflight?.batch === report.tower.batch) {
      this.towerInflight = null;
    }
    if (report.lock) this.lockReq = null;
    if (report.out)
      for (const uid of report.out.uids) this.outQueue.delete(uid);
    if (report.wipe) this.wipePending = false;
    if (report.log) this.logPending = null;
    if (raid) out.push(...this.adoptRaid(raid, now));
    return out;
  }

  /** The database's word on the raid: its lock (if it locked first, with
   * another roster, that one stands), refused revives and who's out. */
  private adoptRaid(raid: RaidReply, now: number): Outbound[] {
    const out: Outbound[] = [];
    const boss = this.boss;
    if (raid.lock && boss && this.stage === "fight") {
      const mine = [...(this.roster?.keys() ?? [])].sort().join();
      const theirs = [...raid.lock.roster].sort().join();
      if (mine !== theirs) {
        const prev = this.roster ?? new Map();
        this.roster = new Map(
          raid.lock.roster.map((uid) => [
            uid,
            prev.get(uid) ?? ("in" as const),
          ]),
        );
        for (const p of this.players.values())
          if (p.present && !this.roster.has(p.uid))
            out.push({ to: { uid: p.uid }, msg: { t: "out" } });
        // Members only the database knew of get the grace to show up, like
        // anyone away: otherwise one who never comes stands forever.
        for (const uid of this.roster.keys())
          if (!prev.has(uid) && !this.players.get(uid)?.present)
            this.absentSince.set(uid, this.absentSince.get(uid) ?? now);
        this.raidDirty = true;
      }
      if (
        raid.lock.maxHp !== boss.maxHp ||
        Math.abs(raid.lock.hp - boss.hp) > 0.5
      ) {
        boss.setHealth(Math.min(boss.hp, raid.lock.hp), raid.lock.maxHp);
        this.bossDirty = true;
      }
    }
    for (const uid of [...(raid.refused ?? []), ...(raid.out ?? [])])
      if (this.roster?.get(uid) === "in") {
        out.push(...this.markOut(uid, now));
        // Already out in the database: nothing to tell it.
        this.outQueue.delete(uid);
      }
    return out;
  }

  /** What a Tower batch's kills dropped (`town-vitals`' word): to the
   * herzie, to land where the last of those mobs fell. */
  towerLoot(drops: LootDrop[], batch: TowerBatch): Outbound[] {
    const p = this.players.get(batch.uid);
    if (!drops.length || !p?.present) return [];
    const last = batch.kills[batch.kills.length - 1];
    return [
      {
        to: { uid: batch.uid },
        msg: {
          t: "loot",
          drops,
          ...(last ? { at: { x: last.x, z: last.z } } : {}),
        },
      },
    ];
  }

  /** The boss fell and its loot is on the ground: tell each herzie still
   * here which drops are theirs, once, for the cave to drop them. `loot` is
   * `town-vitals`' word, by user id. Anyone who already left finds theirs
   * on their Home ground. */
  loot(loot: Record<string, LootDrop[]>): Outbound[] {
    if (this.looted || this.closeWhy !== "victory") return [];
    this.looted = true;
    const out: Outbound[] = [];
    for (const p of this.players.values()) {
      const drops = loot[p.uid];
      if (!p.present || !drops?.length) continue;
      out.push({ to: { uid: p.uid }, msg: { t: "loot", drops } });
    }
    return out;
  }

  /**
   * The fight is over and `town-vitals` sent its table: the end screen, once,
   * to each herzie still here, with the top three and their own place.
   * Victory if the boss fell, defeat if it got away or won.
   */
  results(table: {
    top: BossPlace[];
    you: Record<string, BossPlace>;
  }): Outbound[] {
    if (this.resultsSent || !this.closeWhy) return [];
    this.resultsSent = true;
    const outcome = this.closeWhy === "victory" ? "victory" : "defeat";
    const out: Outbound[] = [];
    for (const p of this.players.values()) {
      if (!p.present) continue;
      out.push({
        to: { uid: p.uid },
        msg: {
          t: "results",
          outcome,
          top: table.top.slice(0, 3),
          you: table.you[p.uid] ?? null,
        },
      });
    }
    return out;
  }

  /** The dev boss's table, from what the room saw land (it's never
   * reported). */
  private devTable(): { top: BossPlace[]; you: Record<string, BossPlace> } {
    const ranked = [...this.devDealt]
      .map(([uid, c]) => ({ uid, c, score: contributionOf(c) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || (a.uid < b.uid ? -1 : 1))
      .map(({ uid, c }, i) => ({
        uid,
        place: {
          rank: i + 1,
          name: this.players.get(uid)?.name ?? "?",
          damage: Math.round(c.damage + (c.adds ?? 0)),
          heal: Math.round(c.healing + c.blocked),
        },
      }));
    return {
      top: ranked.slice(0, 3).map((r) => ({
        ...r.place,
        look: this.players.get(r.uid)?.look,
      })),
      you: Object.fromEntries(ranked.map((r) => [r.uid, r.place])),
    };
  }

  /** A telegraph as the wire carries it: a buster's target as an entity id. */
  private wire(t: Telegraph): BossTelegraph {
    const target = t.target ? this.players.get(t.target)?.id : undefined;
    return {
      id: t.id,
      kind: t.kind,
      x: round(t.x),
      z: round(t.z),
      r: round(t.r),
      inner: t.inner,
      at: t.at,
      hitAt: t.hitAt,
      ...(target !== undefined ? { target } : {}),
      ...(t.lethal ? { lethal: 1 as const } : {}),
      ...(t.mob !== undefined ? { mob: t.mob } : {}),
      ...(t.kind === "lane"
        ? { yaw: round(t.yaw ?? 0), len: round(t.len ?? 0) }
        : {}),
    };
  }

  /** `uid` did `amount` of `kind` for the fight: into the next batch (and
   * the dev boss's own tally). */
  private credit(uid: string, kind: keyof Contribution, amount: number) {
    // The Tower has no boss to tally against.
    if (!(amount > 0) || this.tower) return;
    for (const tally of this.eventId === DEV_EVENT
      ? [this.pending, this.devDealt, this.dealt]
      : [this.pending, this.dealt]) {
      const c = tally.get(uid) ?? {
        damage: 0,
        healing: 0,
        blocked: 0,
        adds: 0,
      };
      c[kind] = (c[kind] ?? 0) + amount;
      tally.set(uid, c);
    }
  }

  /** Whether anything still needs reporting. */
  /** Whether this fight reports to the database at all (the local-dev
   * boss doesn't). */
  get reportable(): boolean {
    return this.eventId !== DEV_EVENT;
  }

  get unreported(): boolean {
    return (
      this.inflight !== null ||
      this.towerInflight !== null ||
      this.towerKills.length > 0 ||
      this.towerCleared > 0 ||
      this.pending.size > 0 ||
      this.leftUnreported.size > 0 ||
      this.xpInflight !== null ||
      this.healed.size > 0 ||
      this.lockReq !== null ||
      this.revivedInflight !== null ||
      this.revivedQueue.length > 0 ||
      this.outQueue.size > 0 ||
      this.wipePending
    );
  }
}

/** The event id used by the local-dev bypass; never reported. */
export const DEV_EVENT = "dev";

/** What a fight reads off a player's stats: a cast's damage, their Def, and
 * what Euphony does to their skills. */
export type FightStats = HitStats & { def: number; euphony: number };

/** Stats from a ticket's `st`; a ticket from before stat points has no Def
 * or Euphony, and one from before stats has nothing. */
/** The most attack speed a Haste can give, however much Euphony is behind
 * it (+50%). */
const HASTE_MAX = 0.5;

/** How a ticket's herzie fights: its basic attack, a blow's strength, and
 * whether it holds its class's instrument. */
function armsOf(
  ticket: TownTicketPayload,
): Pick<FightPlayer, "attack" | "melee" | "armed"> {
  const cls = isHerzieClass(ticket.cls) ? ticket.cls : null;
  const mainHand = ticket.look.equipped?.main_hand ?? null;
  const a = basicAttack({ cls, stage: ticket.look.stage, mainHand });
  return {
    attack: a.style,
    melee: meleeDamage(a.blow),
    armed: hasInstrument(cls, mainHand),
  };
}

export function statsOf(st: TownTicketPayload["st"]): FightStats {
  const n = (v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const [sonicPower, , critChance, critDamage, , def, euphony] = st ?? [];
  return {
    sonicPower: n(sonicPower),
    critChance: n(critChance),
    critDamage: n(critDamage),
    def: n(def),
    euphony: n(euphony),
  };
}

/** The skills a ticket says this herzie has, at their levels. */
function skillsOf(ticket: TownTicketPayload): Map<SkillId, number> {
  const out = new Map<SkillId, number>();
  for (const entry of ticket.sk ?? []) {
    if (!Array.isArray(entry)) continue;
    const [skill, level] = entry;
    if (isSkillId(skill) && Number.isFinite(level))
      out.set(skill, Math.max(1, Math.floor(level)));
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** To a tenth: healing comes in fractions of an HP. */
function tenths(n: number): number {
  return Math.round(n * 10) / 10;
}
