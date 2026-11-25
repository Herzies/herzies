/**
 * Duels in a peaceful room (see shared duel.ts): the challenges, the fights
 * the room judges, and what to tell whom. Pure like FightRuntime (an
 * injected roster, clock and RNG): `room.ts` feeds it frames, ops and the
 * time, and relays what it returns, so every rule here is tested without a
 * Durable Object.
 *
 * Duel health is the room's alone: it starts full, none of it reaches the
 * database, and losing never knocks a herzie out. Only the two duelists
 * can touch each other; nobody else in the room can hurt, heal or buff
 * either of them, or be touched by them.
 */
import {
  aimDirection,
  DISC_RANGE,
  discLandsAfterMs,
  HERZIE_BODY,
  hitDamage,
  STRIKE_DAMAGE,
} from "@herzies/shared/combat";
import {
  DUEL,
  DUEL_MAPS,
  duelAttackShare,
  duelCountdownMs,
  duelCredited,
  duelDamage,
  duelMarks,
  duelRing,
  inDuelRing,
  suddenDeath,
} from "@herzies/shared/duel";
import {
  activeBuffs,
  applyBuff,
  BACKSPIN_DISCS,
  BACKSPIN_SPREAD,
  type Buff,
  buffMultiplier,
  buffReductions,
  CYMBAL_TRAP,
  cymbalLandsAfterMs,
  FORBIDDEN_FREQUENCY,
  isSkillId,
  MULTISPIN,
  multispinRecords,
  RIMSHOT,
  SKILL_COOLDOWN_GRACE_MS,
  SKILL_DEFS,
  type SkillId,
  shuffleBounces,
  skillValue,
} from "@herzies/shared/skills";
import { buffMult, healMult } from "@herzies/shared/stats";
import {
  type DuelEndReason,
  type DuelRefusal,
  type DuelState,
  type ServerMessage,
  type SkillRefusal,
  TOWN_MAPS,
  type TownMapId,
} from "@herzies/shared/town-net";
import { Bleeds } from "./bleed";
import {
  focused,
  quickness,
  type ShelterDome,
  shelterOf,
  TUNING,
} from "./boss";
import { BARD_BUFF_MAX, CastBudget, StunReturns } from "./budgets";
import type { Outbound, SkillResult } from "./fight";
import { DiscHands } from "./hands";
import { PositionHistory } from "./history";
import {
  all,
  buffMsg,
  castMeets,
  firstAlong,
  type PvpKit,
  type PvpTicket,
  pvpKit,
  round,
  seenAt,
  to,
} from "./pvp";
import { Spin } from "./spin";

/** Casts and skills from a herzie whose duel just ended are still on their
 * way for this long: dropped, never held against its socket. */
export const DUEL_AFTERCAST_MS = 2_000;
/** A herzie held where it stands (on its mark for the countdown, stunned,
 * or caught by a Cymbal Trap) is put right only if its frames stray this
 * far from the spot, no sooner than `HOLD_EASE_MS` after it was put there
 * (its app eases it over meanwhile, and frames from before are still on
 * their way), and at most once every `HOLD_CORRECT_EVERY_MS`. */
export const HOLD_SLACK = 0.5;
export const HOLD_EASE_MS = 500;
export const HOLD_CORRECT_EVERY_MS = 250;

/** A herzie in the room as challenges see it: where the room has it, and
 * whether it can be asked. */
export type DuelPeer = {
  uid: string;
  id: number;
  x: number;
  z: number;
  /** AFK, or knocked out (its ticket says so): not to be challenged. */
  away: boolean;
  /** How it fights, from its newest ticket: taken when a duel is
   * accepted, and kept for the duel (a renewed ticket changes nothing). */
  combat: PvpTicket;
};

/** Who's in the room now (on a socket: not a duelist waiting to come
 * back). */
export type DuelRoster = {
  byUid(uid: string): DuelPeer | null;
  byId(id: number): DuelPeer | null;
};

/** A finished duel, as `town-vitals` is told it (user ids throughout). */
export type DuelResult = {
  /** Unique per duel: the room, when it was accepted, and its number. */
  id: string;
  a: string;
  b: string;
  winner: string | null;
  why: DuelEndReason;
  /** How long the fight ran (from "FIGHT!"), ms. */
  ms: number;
  /** Duel HP each took off the other. */
  damage: Record<string, number>;
  maxHp: Record<string, number>;
  level: Record<string, number>;
  /** Whether the win counts towards titles (duelCredited). */
  credited: boolean;
};

/** What a call into the runtime means for the room: what to tell whom,
 * duelists to stand on their marks (the room moves them there, resets
 * their move guard and tells them), and duels to report. */
export type DuelEffects = {
  out: Outbound[];
  place: { uid: string; x: number; z: number }[];
  results: DuelResult[];
};

/** A duelist: its kit (health from its level, its ticket's stats, Def,
 * attack and skills) and how its duel goes. */
type Fighter = PvpKit & {
  uid: string;
  id: number;
  hp: number;
  ready: Map<SkillId, number>;
  /** Only its own (Haste, Shuffle, its Cymbrella's): nobody else's reach
   * it in a duel. */
  buffs: Buff[];
  mark: { x: number; z: number };
  /** Stunned from `stunFrom` until `stunUntil`, held at `stunAt`. */
  stunFrom: number;
  stunUntil: number;
  stunAt: { x: number; z: number };
  stuns: StunReturns;
  /** Held by a Cymbal Trap from `rootFrom` until `rootUntil`, at `rootAt`:
   * it can't walk, but casts and uses its skills. Its holds' returns are
   * its own, apart from its stuns'. */
  rootFrom: number;
  rootUntil: number;
  rootAt: { x: number; z: number };
  roots: StunReturns;
  /** A Rimshot winding up: it lands at `until` where it began. */
  slam: { until: number; x: number; z: number; level: number } | null;
  /** Its Multispin's records, while they spin. */
  spin: Spin | null;
  /** Outside the ring: it yields at `outUntil`; while stunned (or held)
   * the timer stops with `outLeft` ms to go. */
  outUntil: number | null;
  outLeft: number | null;
  /** Its connection dropped: it has until then to come back. */
  awayUntil: number | null;
  /** Duel HP it took off its opponent, and its hits that landed. */
  dealt: number;
  hits: number;
  /** When it was last put right while held. */
  correctedAt: number;
};

type Duel = {
  id: number;
  a: Fighter;
  b: Fighter;
  centre: { x: number; z: number };
  intro: boolean;
  at: number;
  startsAt: number;
  suddenAt: number;
  endsAt: number;
  phase: "countdown" | "fight";
  /** The room has been told sudden death began. */
  suddenSaid: boolean;
  /** Hits in flight: rolled at the cast, judged as they land. */
  pending: PendingHit[];
  domes: ShelterDome[];
  /** Forbidden Frequency's discs and bleeds, by the bleeding duelist's
   * uid. */
  bleeds: Bleeds;
};

type PendingHit = {
  at: number;
  by: string;
  to: string;
  amount: number;
  crit: boolean;
  /** The attack's share of a wave. */
  mult: number;
  /** A Cymbal Trap's: how long it holds its victim (ms, before the
   * returns). */
  hold?: number;
  /** One of a Forbidden Frequency's bleed hits (said so to its thrower). */
  bleed?: true;
};

type Ask = {
  from: string;
  fromId: number;
  to: string;
  toId: number;
  until: number;
};

type Rematch = {
  a: string;
  aId: number;
  b: string;
  bId: number;
  until: number;
  asked: Set<string>;
};

export class DuelRuntime {
  /** Each running duel, under both its duelists' user ids. */
  private duels = new Map<string, Duel>();
  /** Challenges waiting on an answer, by challenger. */
  private asks = new Map<string, Ask>();
  private lastAskAt = new Map<string, number>();
  /** When each challenged herzie declined (or let run out) a challenger's
   * asks lately, by `challenger target`. */
  private declines = new Map<string, number[]>();
  /** The rematch each pair may still ask for, under both user ids. */
  private rematches = new Map<string, Rematch>();
  private endedAt = new Map<string, number>();
  private casts = new CastBudget(TUNING.castEveryMs, TUNING.castBurst);
  private hands = new DiscHands();
  private history = new PositionHistory();
  private seq = 0;

  constructor(
    private readonly map: TownMapId,
    /** Names the room in a result's id. */
    private readonly roomName: string,
    private readonly roster: DuelRoster,
    private readonly rand: () => number = Math.random,
  ) {}

  /** Something to keep the room ticking for: a duel, or a challenge that
   * may run out. */
  get live(): boolean {
    return this.duels.size > 0 || this.asks.size > 0;
  }

  /** Whether `uid` is in a duel (its countdown too). */
  dueling(uid: string): boolean {
    return this.duels.has(uid);
  }

  /** Whether `uid`'s duel ended a moment ago: what it sends now was meant
   * for the duel. */
  justEnded(uid: string, now: number): boolean {
    return (
      now - (this.endedAt.get(uid) ?? Number.NEGATIVE_INFINITY) <
      DUEL_AFTERCAST_MS
    );
  }

  /** Whether `uid` lost its connection mid-fight and may still come back:
   * the room keeps its herzie standing meanwhile. */
  holds(uid: string): boolean {
    const d = this.duels.get(uid);
    return !!d && this.pair(d, uid)[0].awayUntil !== null;
  }

  /** The duels running, for a newcomer's welcome. */
  states(): DuelState[] {
    return [...new Set(this.duels.values())].map((d) => this.state(d));
  }

  // --- Challenges.

  /** `fromUid` challenges the herzie with entity id `toId`. */
  ask(fromUid: string, toId: number, now: number): DuelEffects {
    const e = effects();
    const from = this.roster.byUid(fromUid);
    if (!from) return e;
    this.prune(now);
    const no = (why: DuelRefusal, retryIn?: number) => {
      e.out.push(
        to(from.uid, {
          t: "duelNo",
          with: toId,
          why,
          ...(retryIn !== undefined ? { retryIn: Math.ceil(retryIn) } : {}),
        }),
      );
      return e;
    };
    if (!DUEL_MAPS.has(this.map)) return no("here");
    if (toId === from.id) return no("self");
    const target = this.roster.byId(toId);
    if (!target) return no("gone");
    if (apart(from, target) > DUEL.challengeRange + DUEL.rangeSlack)
      return no("far");
    if (this.duels.has(from.uid) || this.duels.has(target.uid))
      return no("busy");
    // It challenged you first: asking back is saying yes.
    const theirs = this.asks.get(target.uid);
    if (theirs?.to === from.uid) return this.accept(theirs, now, e);
    if (
      [...this.asks.values()].some(
        (a) => a.to === target.uid && a.from !== from.uid,
      ) ||
      from.away
    )
      return no("busy");
    if (target.away) return no("away");
    const gap =
      (this.lastAskAt.get(from.uid) ?? Number.NEGATIVE_INFINITY) +
      DUEL.askGapMs -
      now;
    if (gap > 0) return no("cooldown", gap);
    const wait = this.declineWait(from.uid, target.uid, now);
    if (wait > 0) return no("cooldown", wait);
    if (!duelRing(from, target, TOWN_MAPS[this.map].radius)) return no("here");

    // One challenge out at a time: a new one takes the last one's place.
    const old = this.asks.get(from.uid);
    if (old) {
      this.asks.delete(from.uid);
      e.out.push(to(old.to, { t: "duelAskGone", from: from.id }));
    }
    this.asks.set(from.uid, {
      from: from.uid,
      fromId: from.id,
      to: target.uid,
      toId: target.id,
      until: now + DUEL.askTtlMs,
    });
    this.lastAskAt.set(from.uid, now);
    const { lv, cls } = from.combat;
    e.out.push(
      to(target.uid, {
        t: "duelAsk",
        from: from.id,
        ...(typeof lv === "number" ? { lv } : {}),
        ...(cls ? { cls } : {}),
        ttl: DUEL.askTtlMs,
      }),
      to(from.uid, { t: "duelAsked", to: target.id, ttl: DUEL.askTtlMs }),
    );
    return e;
  }

  /** `byUid` answers the challenge from entity `fromId`. */
  answer(
    byUid: string,
    fromId: number,
    yes: boolean,
    auto: boolean,
    now: number,
  ): DuelEffects {
    const e = effects();
    const ask = [...this.asks.values()].find(
      (a) => a.to === byUid && a.fromId === fromId,
    );
    if (!ask) return e;
    if (yes) return this.accept(ask, now, e);
    this.asks.delete(ask.from);
    this.noteDecline(ask.from, ask.to, now);
    e.out.push(
      to(ask.from, {
        t: "duelNo",
        with: ask.toId,
        why: auto ? "auto" : "declined",
      }),
    );
    return e;
  }

  /** `uid` withdraws its challenge. */
  cancel(uid: string): DuelEffects {
    const e = effects();
    const ask = this.asks.get(uid);
    if (!ask) return e;
    this.asks.delete(uid);
    e.out.push(to(ask.to, { t: "duelAskGone", from: ask.fromId }));
    return e;
  }

  /** `uid` gives up its duel. Before the fight, that calls it off. */
  yield(uid: string, now: number): DuelEffects {
    const e = effects();
    const d = this.duels.get(uid);
    if (!d) return e;
    if (d.phase === "countdown") this.end(d, "cancelled", null, now, e);
    else this.end(d, "yield", this.pair(d, uid)[0], now, e);
    return e;
  }

  /** `uid` asks its last opponent for a rematch (or agrees to one). Once
   * both have, it starts, straight into the 3-2-1. */
  rematch(uid: string, now: number): DuelEffects {
    const e = effects();
    const r = this.rematches.get(uid);
    if (!r || this.duels.has(uid) || r.asked.has(uid)) return e;
    const [otherUid, otherId, myId] =
      r.a === uid ? [r.b, r.bId, r.aId] : [r.a, r.aId, r.bId];
    if (now > r.until) {
      this.forgetRematch(r);
      e.out.push(to(uid, { t: "duelNo", with: otherId, why: "expired" }));
      return e;
    }
    r.asked.add(uid);
    if (r.asked.size < 2) {
      e.out.push(to(otherUid, { t: "duelRematch", by: myId }));
      return e;
    }
    this.forgetRematch(r);
    const a = this.roster.byUid(r.a);
    const b = this.roster.byUid(r.b);
    const why = a && b ? this.unfit(a, b) : "gone";
    if (!a || !b || why) {
      e.out.push(
        to(r.a, { t: "duelNo", with: r.bId, why: why ?? "gone" }),
        to(r.b, { t: "duelNo", with: r.aId, why: why ?? "gone" }),
      );
      return e;
    }
    this.start(a, b, false, now, e);
    return e;
  }

  // --- Connections.

  /** `uid` left the room, or its socket closed. Its challenges go; in a
   * countdown the duel is called off; in a fight it has
   * DUEL.reconnectMs to come back (see holds) before it's lost. */
  gone(uid: string, now: number): DuelEffects {
    const e = effects();
    this.dropAsks(uid, "gone", e);
    const r = this.rematches.get(uid);
    if (r) {
      this.forgetRematch(r);
      const [other, myId] = r.a === uid ? [r.b, r.aId] : [r.a, r.bId];
      if (r.asked.has(other))
        e.out.push(to(other, { t: "duelNo", with: myId, why: "gone" }));
    }
    const d = this.duels.get(uid);
    if (!d) return e;
    if (d.phase === "countdown") {
      this.end(d, "cancelled", null, now, e);
      return e;
    }
    const [f, o] = this.pair(d, uid);
    if (f.awayUntil !== null) return e;
    // Both gone: nobody won.
    if (o.awayUntil !== null) {
      this.end(d, "draw", null, now, e);
      return e;
    }
    f.awayUntil = now + DUEL.reconnectMs;
    this.dropSlam(f, e);
    this.dropSpin(f, now, e);
    f.outUntil = null;
    f.outLeft = null;
    e.out.push(all({ t: "duelAway", id: f.id, until: f.awayUntil }));
    return e;
  }

  /** `uid` came back to the duel it dropped out of: it carries on, and is
   * told its buffs again. */
  back(uid: string, now: number): DuelEffects {
    const e = effects();
    const d = this.duels.get(uid);
    if (!d) return e;
    const f = this.pair(d, uid)[0];
    if (f.awayUntil === null) return e;
    f.awayUntil = null;
    e.out.push(all({ t: "duelAway", id: f.id, until: null }));
    for (const g of [d.a, d.b])
      for (const b of activeBuffs(g.buffs, now))
        e.out.push(to(uid, buffMsg(g.id, b)));
    if (now < f.stunUntil)
      e.out.push(to(uid, { t: "duelStun", id: f.id, until: f.stunUntil }));
    if (now < f.rootUntil)
      e.out.push(
        to(uid, {
          t: "trap",
          by: this.pair(d, uid)[1].id,
          target: f.id,
          until: f.rootUntil,
        }),
      );
    return e;
  }

  // --- The fight.

  /** Where the room has a duelist now (fed from its moves). */
  onState(uid: string, x: number, z: number, now: number): void {
    const d = this.duels.get(uid);
    if (d && this.pair(d, uid)[0].awayUntil === null)
      this.history.record(uid, now, x, z);
  }

  /**
   * Where a duelist's move to (x, z) is held, if it is: on its mark until
   * the fight starts, where it was stunned while it is, and where a Cymbal
   * Trap caught it while that holds. `correct`: tell
   * it (it strayed past HOLD_SLACK, after the ease, at most every
   * HOLD_CORRECT_EVERY_MS). Null: it moves freely.
   */
  hold(
    uid: string,
    x: number,
    z: number,
    now: number,
  ): { x: number; z: number; correct: boolean } | null {
    const d = this.duels.get(uid);
    if (!d) return null;
    const f = this.pair(d, uid)[0];
    let at: { x: number; z: number };
    let since: number;
    if (d.phase === "countdown") {
      at = f.mark;
      since = d.at;
    } else if (now < f.stunUntil) {
      at = f.stunAt;
      since = f.stunFrom;
    } else if (now < f.rootUntil) {
      at = f.rootAt;
      since = f.rootFrom;
    } else return null;
    const correct =
      Math.hypot(x - at.x, z - at.z) > HOLD_SLACK &&
      now - since >= HOLD_EASE_MS &&
      now - f.correctedAt >= HOLD_CORRECT_EVERY_MS;
    if (correct) f.correctedAt = now;
    return { x: at.x, z: at.z, correct };
  }

  /**
   * A duelist's basic cast, judged like a cast at the boss: its cast
   * budget, its aim (with the same assist) at the opponent as its client
   * saw it, and the flight time. A melee blow lands at once, a wave or a
   * disc when it gets there. From outside the ring it does nothing.
   * "ignored": not now (the countdown, stunned, a Rimshot winding up).
   */
  cast(
    uid: string,
    yaw: number,
    pitch: number,
    now: number,
  ): "hit" | "miss" | "cooldown" | "ignored" {
    const d = this.duels.get(uid);
    if (!d || d.phase !== "fight") return "ignored";
    const [f, o] = this.pair(d, uid);
    if (f.awayUntil !== null || now < f.stunUntil || f.slam) return "ignored";
    const pos = this.history.at(uid, now);
    if (!pos) return "ignored";
    const quick = quickness(f.buffs, now, f.stats.timing);
    if (!this.casts.spend(uid, now, quick)) return "cooldown";
    const inside = inDuelRing(d.centre, pos);
    const seen = seenAt(this.history, o.uid, now);
    const hit = seen
      ? castMeets(f, pos, yaw, pitch, [{ uid: o.uid, ...seen }])
      : null;
    // Both discs out: see BossEngine.cast.
    if (
      f.attack === "disc" &&
      !this.hands.take(uid, now, hit?.dist ?? null, quick)
    )
      return "miss";
    if (!hit || !inside) return "miss";
    this.queue(d, f, o, now, now + hit.flightMs, hit.mult);
    return "hit";
  }

  /**
   * A duelist's class skill, as in a fight but for one: its attacks hit
   * only the opponent, its heals and buffs only itself. Taunt and Resurrect
   * mean nothing here (refused, "duel"). Returns what became of it, as
   * FightRuntime.skill does.
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
    const d = this.duels.get(uid);
    if (!d || d.phase !== "fight")
      return { result: "ignored", readyAt: 0, out };
    const [f, o] = this.pair(d, uid);
    if (f.awayUntil !== null || now < f.stunUntil)
      return { result: "ignored", readyAt: 0, out };
    if (!isSkillId(skillId) || !f.skills.has(skillId))
      return { result: "unknown", readyAt: 0, out };
    if (skillId === "taunt" || skillId === "resurrect")
      return { result: "refused", readyAt: 0, reason: "duel", out };
    if (!f.armed)
      return { result: "refused", readyAt: 0, reason: "instrument", out };
    const pos = this.history.at(uid, now);
    if (!pos) return { result: "ignored", readyAt: 0, out };
    const readyAt = f.ready.get(skillId) ?? 0;
    if (now < readyAt) {
      const early = readyAt - now <= SKILL_COOLDOWN_GRACE_MS;
      return { result: early ? "early" : "cooldown", readyAt, out };
    }
    const def = SKILL_DEFS[skillId];
    const level = f.skills.get(skillId) ?? 1;
    const value = skillValue(skillId, level);
    f.ready.set(skillId, now + def.cooldownMs);
    out.push(
      all({
        t: "skill",
        by: f.id,
        skill: skillId,
        level,
        x: round(pos.x),
        z: round(pos.z),
        yaw: round(yaw),
      }),
    );

    if (skillId === "soothing-drones") {
      // Its own health only, and less of it in sudden death.
      const heal = Math.min(
        f.maxHp - f.hp,
        Math.round(
          value *
            healMult(f.stats.euphony) *
            f.maxHp *
            suddenDeath(now - d.startsAt).heal,
        ),
      );
      if (heal > 0) {
        f.hp += heal;
        out.push(all({ t: "duelHp", id: f.id, hp: f.hp, maxHp: f.maxHp }));
      }
    } else if (skillId === "cymbrella") {
      // A dome where it stands: the opponent's hits on it there are
      // blocked (see land).
      const ms = Math.round(value * 1000);
      d.domes.push({ x: pos.x, z: pos.z, from: now, until: now + ms, by: uid });
      out.push(
        all(
          buffMsg(
            f.id,
            this.buff(f, { id: "cymbrella", value: 1, until: now + ms }, now),
          ),
        ),
      );
    } else if (
      skillId === "haste" ||
      skillId === "rage" ||
      skillId === "focus"
    ) {
      // Its own only: nobody else's reach it in a duel.
      const strength = Math.min(
        BARD_BUFF_MAX[skillId],
        value * buffMult(f.stats.euphony),
      );
      const until = now + (def.durationMs ?? 0);
      out.push(
        all(
          buffMsg(
            f.id,
            this.buff(f, { id: skillId, value: strength, until, by: uid }, now),
          ),
        ),
      );
    } else if (skillId === "multispin") {
      // Records round it for its length: the opponent takes a hit from
      // each it touches (stepSpins). The app draws them from the buff.
      const records = multispinRecords(level);
      const until = now + (def.durationMs ?? 0);
      f.spin = new Spin(now, until, records);
      out.push(
        all(
          buffMsg(
            f.id,
            this.buff(f, { id: "multispin", value: records, until }, now),
          ),
        ),
      );
    } else if (skillId === "shuffle") {
      // Nothing near the opponent to bounce on to: a buff, for the HUD.
      const until = now + (def.durationMs ?? 0);
      const bounces = shuffleBounces(level);
      out.push(
        all(
          buffMsg(
            f.id,
            this.buff(f, { id: "shuffle", value: bounces, until }, now),
          ),
        ),
      );
    } else if (skillId === "backspin") {
      const seen = seenAt(this.history, o.uid, now);
      if (seen && inDuelRing(d.centre, pos)) {
        // Each a disc: `value` of a wave, at a disc's share in a duel.
        const mult = value * DUEL.discShare;
        const half = (BACKSPIN_DISCS - 1) / 2;
        for (let i = 0; i < BACKSPIN_DISCS; i++) {
          const dir = aimDirection(yaw + (i - half) * BACKSPIN_SPREAD, pitch);
          const hit = firstAlong(
            pos,
            dir,
            [{ uid: o.uid, ...seen }],
            DISC_RANGE,
          );
          if (hit)
            this.queue(d, f, o, now, now + discLandsAfterMs(hit.dist), mult);
        }
      }
    } else if (skillId === "forbidden-frequency") {
      // A disc that bleeds the opponent where it lands (stepBleeds).
      const seen = seenAt(this.history, o.uid, now);
      const hit =
        seen && inDuelRing(d.centre, pos)
          ? firstAlong(
              pos,
              aimDirection(yaw, pitch),
              [{ uid: o.uid, ...seen }],
              DISC_RANGE,
            )
          : null;
      if (hit)
        d.bleeds.throw({
          at: now + discLandsAfterMs(hit.dist),
          by: uid,
          key: o.uid,
          level,
          stats: focused(f.stats, f.buffs, now),
        });
    } else if (skillId === "cymbal-trap") {
      // Thrown: a stick's blow when it gets there, and a hold (see land).
      const seen = seenAt(this.history, o.uid, now);
      const hit =
        seen && inDuelRing(d.centre, pos)
          ? firstAlong(
              pos,
              aimDirection(yaw, pitch),
              [{ uid: o.uid, ...seen }],
              CYMBAL_TRAP.range,
            )
          : null;
      if (hit)
        this.queue(
          d,
          f,
          o,
          now,
          now + cymbalLandsAfterMs(hit.dist),
          CYMBAL_TRAP.damage * duelAttackShare("melee", STRIKE_DAMAGE),
          Math.round(value * 1000),
        );
    } else if (skillId === "rimshot") {
      // The wind-up: it lands where it began, when it's done (stepSlams).
      f.slam = {
        until: now + (def.castMs ?? 0),
        x: pos.x,
        z: pos.z,
        level,
      };
    }
    return { result: "used", readyAt: now + def.cooldownMs, out };
  }

  /** Advance to `now`: challenges run out, countdowns end, hits land,
   * Rimshots slam, the ring's edge and the clock are judged. */
  step(now: number): DuelEffects {
    const e = effects();
    for (const ask of [...this.asks.values()]) {
      if (now < ask.until) continue;
      this.asks.delete(ask.from);
      this.noteDecline(ask.from, ask.to, now);
      e.out.push(
        to(ask.from, { t: "duelNo", with: ask.toId, why: "expired" }),
        to(ask.to, { t: "duelAskGone", from: ask.fromId }),
      );
    }
    for (const d of new Set(this.duels.values())) this.stepDuel(d, now, e);
    this.prune(now);
    return e;
  }

  private stepDuel(d: Duel, now: number, e: DuelEffects) {
    if (d.phase === "countdown") {
      if (now < d.startsAt) return;
      d.phase = "fight";
      e.out.push(all(this.stateMsg(d)));
    }
    for (const f of [d.a, d.b]) {
      if (f.awayUntil !== null && now >= f.awayUntil) {
        this.end(d, "left", f, now, e);
        return;
      }
    }
    this.stepSlams(d, now, e);
    this.stepSpins(d, now);
    this.stepBleeds(d, now, e);
    if (this.land(d, now, e)) return;
    if (this.stepBounds(d, now, e)) return;
    if (!d.suddenSaid && now >= d.suddenAt) {
      d.suddenSaid = true;
      e.out.push(all(this.stateMsg(d)));
    }
    if (now >= d.endsAt) {
      // Time: the higher share of health wins.
      const share = d.a.hp / d.a.maxHp - d.b.hp / d.b.maxHp;
      if (Math.abs(share) < 1e-9) this.end(d, "draw", null, now, e);
      else this.end(d, "time", share < 0 ? d.a : d.b, now, e);
      return;
    }
    d.domes = d.domes.filter((x) => x.until > now);
  }

  /** Rimshots whose wind-up is done slam: the opponent, if within reach
   * of where it began, takes the blow and rolls for a stun. */
  private stepSlams(d: Duel, now: number, e: DuelEffects) {
    for (const [f, o] of [
      [d.a, d.b],
      [d.b, d.a],
    ] as const) {
      const s = f.slam;
      if (!s || now < s.until) continue;
      f.slam = null;
      if (!inDuelRing(d.centre, s)) continue;
      const seen = seenAt(this.history, o.uid, now);
      if (
        !seen ||
        Math.hypot(seen.x - s.x, seen.z - s.z) >
          RIMSHOT.radius + HERZIE_BODY.radius
      )
        continue;
      // Two blows of a stick.
      this.queue(
        d,
        f,
        o,
        now,
        now,
        RIMSHOT.damage * duelAttackShare("melee", STRIKE_DAMAGE),
      );
      if (this.rand() < skillValue("rimshot", s.level) && now >= o.stunUntil)
        this.stun(o, now, e);
    }
  }

  /** Forbidden Frequency discs that arrived take hold (unless a dome took
   * them), and bleeds tick: stacks × its share of a wave at a disc's share
   * (as Backspin's), from its thrower's stats without a crit and as hard
   * as its Rage makes it, landing as a hit at once (so Def and domes have
   * their say in land). */
  private stepBleeds(d: Duel, now: number, e: DuelEffects) {
    for (const disc of d.bleeds.landed(now)) {
      const [victim, by] = this.pair(d, disc.key);
      const dome = shelterOf(
        d.domes.filter((x) => x.by === victim.uid),
        {
          uid: victim.uid,
          alive: true,
          maxHp: victim.maxHp,
          posAt: (t) => this.history.at(victim.uid, t),
        },
        disc.at,
      );
      if (dome) continue;
      const b = d.bleeds.stack(disc, now);
      e.out.push(
        all({
          t: "bleed",
          by: by.id,
          target: victim.id,
          stacks: b.stacks,
          until: b.until,
        }),
      );
    }
    for (const { key, bleed: b } of d.bleeds.ticks(now)) {
      const [victim, by] = this.pair(d, key);
      const { amount } = hitDamage({ ...b.stats, critChance: 0 }, this.rand);
      d.pending.push({
        at: now,
        by: by.uid,
        to: victim.uid,
        amount,
        crit: false,
        mult:
          skillValue("forbidden-frequency", b.level) *
          DUEL.discShare *
          buffMultiplier(by.buffs, "damage", now),
        bleed: true,
      });
    }
  }

  /** Multispins' records touch the opponent, round wherever their
   * Slinger stands: a hit of MULTISPIN.damage of a wave at a disc's share
   * (as Backspin's), landing at once. From outside the ring they touch
   * nothing. */
  private stepSpins(d: Duel, now: number) {
    for (const [f, o] of [
      [d.a, d.b],
      [d.b, d.a],
    ] as const) {
      const s = f.spin;
      if (!s) continue;
      const pos = this.history.at(f.uid, now);
      const seen = seenAt(this.history, o.uid, now);
      const bodies =
        pos && seen && inDuelRing(d.centre, pos)
          ? [{ key: o.uid, ...seen, r: HERZIE_BODY.radius }]
          : [];
      for (const _ of s.touches(now, (t) => this.history.at(f.uid, t), bodies))
        this.queue(d, f, o, now, now, MULTISPIN.damage * DUEL.discShare);
      if (s.over(now)) f.spin = null;
    }
  }

  /** Stunned by a Rimshot: held where it stands, its own Rimshot (if
   * winding up) lost, for a mob's stun scaled for a herzie with its
   * diminishing returns. */
  private stun(f: Fighter, now: number, e: DuelEffects) {
    const ms = f.stuns.take(now, RIMSHOT.stunMs * DUEL.stunScale);
    f.stunFrom = now;
    f.stunUntil = now + ms;
    f.stunAt = this.history.at(f.uid, now) ?? f.mark;
    this.dropSlam(f, e);
    e.out.push(all({ t: "duelStun", id: f.id, until: f.stunUntil }));
  }

  /** Caught by a Cymbal Trap thrown by `by`: held where it stands (it may
   * turn, cast and use its skills, a Rimshot winding up included), for
   * `base` with its holds' diminishing returns. Not while it already is. */
  private root(
    f: Fighter,
    by: Fighter,
    now: number,
    base: number,
    e: DuelEffects,
  ) {
    if (now < f.rootUntil) return;
    const ms = f.roots.take(now, base);
    f.rootFrom = now;
    f.rootUntil = now + ms;
    f.rootAt = this.history.at(f.uid, now) ?? f.mark;
    e.out.push(all({ t: "trap", by: by.id, target: f.id, until: f.rootUntil }));
  }

  /** Hits that have arrived land (or a dome takes them). True if one
   * ended the duel. */
  private land(d: Duel, now: number, e: DuelEffects): boolean {
    if (!d.pending.length) return false;
    const due = d.pending
      .filter((h) => h.at <= now)
      .sort((x, y) => x.at - y.at);
    if (!due.length) return false;
    d.pending = d.pending.filter((h) => h.at > now);
    for (const h of due) {
      const [by, victim] = this.pair(d, h.by);
      const dome = shelterOf(
        d.domes.filter((x) => x.by === victim.uid),
        {
          uid: victim.uid,
          alive: true,
          maxHp: victim.maxHp,
          posAt: (t) => this.history.at(victim.uid, t),
        },
        h.at,
      );
      if (dome) {
        e.out.push(
          to(by.uid, {
            t: "duelHit",
            target: victim.id,
            damage: 0,
            crit: h.crit,
            blocked: true,
            ...(h.bleed ? { bleed: true as const } : {}),
          }),
        );
        continue;
      }
      const damage = duelDamage({
        amount: h.amount,
        mult: h.mult,
        def: victim.def,
        reductions: buffReductions(victim.buffs, h.at),
        fightMs: now - d.startsAt,
        maxHp: victim.maxHp,
      });
      const taken = Math.min(victim.hp, damage);
      victim.hp -= taken;
      by.dealt += taken;
      by.hits++;
      e.out.push(
        to(by.uid, {
          t: "duelHit",
          target: victim.id,
          damage,
          crit: h.crit,
          ...(h.bleed ? { bleed: true as const } : {}),
        }),
        all({
          t: "duelHp",
          id: victim.id,
          hp: victim.hp,
          maxHp: victim.maxHp,
        }),
      );
      if (victim.hp <= 0) {
        this.end(d, "defeat", victim, now, e);
        return true;
      }
      if (h.hold) this.root(victim, by, now, h.hold, e);
    }
    return false;
  }

  /** The ring's edge: outside it a duelist's timer runs (stopped while
   * it's stunned or held: knocked about isn't running away), and runs out
   * into a loss. Back inside, it starts over. True if one ran out. */
  private stepBounds(d: Duel, now: number, e: DuelEffects): boolean {
    for (const f of [d.a, d.b]) {
      if (f.awayUntil !== null) continue;
      const pos = this.history.at(f.uid, now);
      if (!pos) continue;
      if (inDuelRing(d.centre, pos)) {
        if (f.outUntil !== null)
          e.out.push(to(f.uid, { t: "duelOut", until: null }));
        f.outUntil = null;
        f.outLeft = null;
        continue;
      }
      if (now < f.stunUntil || now < f.rootUntil) {
        if (f.outUntil !== null) {
          f.outLeft = f.outUntil - now;
          f.outUntil = null;
          e.out.push(to(f.uid, { t: "duelOut", until: null }));
        }
        continue;
      }
      if (f.outUntil === null) {
        f.outUntil = now + (f.outLeft ?? DUEL.outOfBoundsMs);
        f.outLeft = null;
        e.out.push(to(f.uid, { t: "duelOut", until: f.outUntil }));
      } else if (now >= f.outUntil) {
        this.end(d, "bounds", f, now, e);
        return true;
      }
    }
    return false;
  }

  // --- Starting and ending.

  /** Accept `ask`: if the two are still free and near enough, the duel
   * starts. */
  private accept(ask: Ask, now: number, e: DuelEffects): DuelEffects {
    this.asks.delete(ask.from);
    const a = this.roster.byUid(ask.from);
    const b = this.roster.byUid(ask.to);
    if (!a || !b) {
      if (b)
        e.out.push(to(b.uid, { t: "duelNo", with: ask.fromId, why: "gone" }));
      return e;
    }
    const why = this.unfit(a, b);
    if (why) {
      e.out.push(
        to(a.uid, { t: "duelNo", with: b.id, why }),
        to(b.uid, { t: "duelNo", with: a.id, why }),
      );
      return e;
    }
    this.start(a, b, true, now, e);
    return e;
  }

  /** Why `a` and `b` can't start a duel now, if they can't. */
  private unfit(a: DuelPeer, b: DuelPeer): DuelRefusal | null {
    if (this.duels.has(a.uid) || this.duels.has(b.uid)) return "busy";
    if (apart(a, b) > DUEL.acceptRange + DUEL.rangeSlack) return "far";
    if (!duelRing(a, b, TOWN_MAPS[this.map].radius)) return "here";
    return null;
  }

  private start(
    a: DuelPeer,
    b: DuelPeer,
    intro: boolean,
    now: number,
    e: DuelEffects,
  ) {
    const centre = duelRing(a, b, TOWN_MAPS[this.map].radius) ?? {
      x: (a.x + b.x) / 2,
      z: (a.z + b.z) / 2,
    };
    const marks = duelMarks(centre, a, b);
    for (const p of [a, b]) {
      this.dropAsks(p.uid, "busy", e);
      // A rematch the last opponent was waiting on won't happen now.
      const r = this.rematches.get(p.uid);
      if (!r) continue;
      this.forgetRematch(r);
      const [other, myId] = r.a === p.uid ? [r.b, r.aId] : [r.a, r.bId];
      if (r.asked.has(other) && other !== a.uid && other !== b.uid)
        e.out.push(to(other, { t: "duelNo", with: myId, why: "busy" }));
    }
    const startsAt = now + duelCountdownMs(intro);
    const d: Duel = {
      id: ++this.seq,
      a: fighter(a, marks.a),
      b: fighter(b, marks.b),
      centre,
      intro,
      at: now,
      startsAt,
      suddenAt: startsAt + DUEL.regulationMs,
      endsAt: startsAt + DUEL.hardCapMs,
      phase: "countdown",
      suddenSaid: false,
      pending: [],
      domes: [],
      bleeds: new Bleeds(FORBIDDEN_FREQUENCY.herzieMs),
    };
    e.out.push(all(this.stateMsg(d)));
    for (const f of [d.a, d.b]) {
      this.duels.set(f.uid, d);
      // A fresh start: a full cast budget, both discs in hand.
      this.casts.forget(f.uid);
      this.hands.forget(f.uid);
      this.history.forget(f.uid);
      this.history.record(f.uid, now, f.mark.x, f.mark.z);
      this.endedAt.delete(f.uid);
      e.place.push({ uid: f.uid, x: f.mark.x, z: f.mark.z });
    }
  }

  /** The duel is over: `loser` lost it (null: nobody did). Everything in
   * flight between the two is dropped, their duel buffs come off, and
   * after a real fight they may ask for a rematch. */
  private end(
    d: Duel,
    why: DuelEndReason,
    loser: Fighter | null,
    now: number,
    e: DuelEffects,
  ) {
    const winner = loser ? this.pair(d, loser.uid)[1] : null;
    d.pending = [];
    d.domes = [];
    for (const f of [d.a, d.b]) {
      this.duels.delete(f.uid);
      this.endedAt.set(f.uid, now);
      this.history.forget(f.uid);
      f.slam = null;
      f.spin = null;
      for (const b of activeBuffs(f.buffs, now))
        e.out.push(all({ t: "buffOff", id: f.id, buff: b.id }));
    }
    const ms =
      d.phase === "fight"
        ? Math.max(0, Math.min(now, d.endsAt) - d.startsAt)
        : 0;
    const rematch =
      why !== "cancelled" &&
      why !== "left" &&
      d.a.awayUntil === null &&
      d.b.awayUntil === null;
    const rematchUntil = now + DUEL.rematchMs;
    e.out.push(
      all({
        t: "duelEnd",
        id: d.id,
        a: d.a.id,
        b: d.b.id,
        winner: winner?.id ?? null,
        loser: loser?.id ?? null,
        why,
        ms,
        tally: [d.a, d.b].map((f) => ({
          id: f.id,
          damage: f.dealt,
          hits: f.hits,
        })),
        ...(rematch ? { rematchUntil } : {}),
      }),
    );
    if (rematch) {
      const r: Rematch = {
        a: d.a.uid,
        aId: d.a.id,
        b: d.b.uid,
        bId: d.b.id,
        until: rematchUntil,
        asked: new Set(),
      };
      this.rematches.set(r.a, r);
      this.rematches.set(r.b, r);
    }
    if (why === "cancelled") return;
    e.results.push({
      id: `${this.roomName}:${d.at}:${d.id}`,
      a: d.a.uid,
      b: d.b.uid,
      winner: winner?.uid ?? null,
      why,
      ms,
      damage: { [d.a.uid]: d.a.dealt, [d.b.uid]: d.b.dealt },
      maxHp: { [d.a.uid]: d.a.maxHp, [d.b.uid]: d.b.maxHp },
      level: { [d.a.uid]: d.a.level, [d.b.uid]: d.b.level },
      credited:
        !!winner &&
        !!loser &&
        duelCredited({
          ms,
          loserDamage: loser.dealt,
          winnerMaxHp: winner.maxHp,
          winnerLevel: winner.level,
          loserLevel: loser.level,
        }),
    });
  }

  // --- Helpers.

  /** `uid`'s fighter in `d`, and its opponent. */
  private pair(d: Duel, uid: string): [Fighter, Fighter] {
    return d.a.uid === uid ? [d.a, d.b] : [d.b, d.a];
  }

  /** A hit from `by` on `victim` landing at `at`: rolled `now` (its crit
   * chance as a Focus has it, its share of a wave as hard as a Rage
   * makes it), judged as it lands. `hold`: a Cymbal Trap's (ms). */
  private queue(
    d: Duel,
    by: Fighter,
    victim: Fighter,
    now: number,
    at: number,
    mult: number,
    hold?: number,
  ) {
    const { amount, crit } = hitDamage(
      focused(by.stats, by.buffs, now),
      this.rand,
    );
    d.pending.push({
      at,
      by: by.uid,
      to: victim.uid,
      amount,
      crit,
      mult: mult * buffMultiplier(by.buffs, "damage", now),
      ...(hold ? { hold } : {}),
    });
  }

  private buff(f: Fighter, next: Buff, now: number): Buff {
    f.buffs = applyBuff(f.buffs, next, now);
    return f.buffs.find((b) => b.id === next.id) as Buff;
  }

  /** A Rimshot winding up is lost; the room sees it stop. */
  private dropSlam(f: Fighter, e: DuelEffects) {
    if (!f.slam) return;
    f.slam = null;
    e.out.push(all({ t: "channel", by: f.id, target: null, until: 0 }));
  }

  /** Its Multispin stops (it dropped out); the room sees its buff go. */
  private dropSpin(f: Fighter, now: number, e: DuelEffects) {
    if (!f.spin) return;
    f.spin = null;
    if (f.buffs.some((b) => b.id === "multispin" && b.until > now))
      e.out.push(all({ t: "buffOff", id: f.id, buff: "multispin" }));
    f.buffs = f.buffs.filter((b) => b.id !== "multispin");
  }

  /** `uid`'s challenges go: its own (the herzie it asked is told), and
   * any waiting on it (their challengers are told `why`). */
  private dropAsks(uid: string, why: DuelRefusal, e: DuelEffects) {
    for (const ask of [...this.asks.values()]) {
      if (ask.from === uid) {
        this.asks.delete(ask.from);
        e.out.push(to(ask.to, { t: "duelAskGone", from: ask.fromId }));
      } else if (ask.to === uid) {
        this.asks.delete(ask.from);
        e.out.push(
          to(ask.from, { t: "duelNo", with: ask.toId, why }),
          to(ask.to, { t: "duelAskGone", from: ask.fromId }),
        );
      }
    }
  }

  private forgetRematch(r: Rematch) {
    if (this.rematches.get(r.a) === r) this.rematches.delete(r.a);
    if (this.rematches.get(r.b) === r) this.rematches.delete(r.b);
  }

  private noteDecline(from: string, target: string, now: number) {
    const key = `${from} ${target}`;
    this.declines.set(key, [...(this.declines.get(key) ?? []), now]);
  }

  /** How long `from` must wait to challenge `target` again after its
   * declines (or challenges it let run out): the second within the window
   * makes it the long wait. 0 or less: it may. */
  private declineWait(from: string, target: string, now: number): number {
    const recent = (this.declines.get(`${from} ${target}`) ?? []).filter(
      (t) => t > now - DUEL.declineWindowMs,
    );
    const last = recent.at(-1);
    if (last === undefined) return 0;
    const wait =
      recent.length >= 2 ? DUEL.declinePenaltyMs : DUEL.declineCooldownMs;
    return last + wait - now;
  }

  /** Forget what no longer matters: old asks' gaps, declines out of their
   * window, rematches that ran out. */
  private prune(now: number) {
    for (const [uid, t] of this.lastAskAt)
      if (now - t >= DUEL.askGapMs) this.lastAskAt.delete(uid);
    for (const [key, list] of this.declines) {
      const recent = list.filter((t) => t > now - DUEL.declineWindowMs);
      if (recent.length) this.declines.set(key, recent);
      else this.declines.delete(key);
    }
    for (const [uid, t] of this.endedAt)
      if (now - t >= DUEL_AFTERCAST_MS) this.endedAt.delete(uid);
    for (const r of new Set(this.rematches.values()))
      if (now > r.until) this.forgetRematch(r);
  }

  private state(d: Duel): DuelState {
    return {
      id: d.id,
      a: d.a.id,
      b: d.b.id,
      x: round(d.centre.x),
      z: round(d.centre.z),
      phase: d.phase,
      intro: d.intro,
      at: d.at,
      startsAt: d.startsAt,
      suddenAt: d.suddenAt,
      endsAt: d.endsAt,
      marks: {
        a: { x: round(d.a.mark.x), z: round(d.a.mark.z) },
        b: { x: round(d.b.mark.x), z: round(d.b.mark.z) },
      },
      hp: [d.a, d.b].map((f) => ({ id: f.id, hp: f.hp, maxHp: f.maxHp })),
    };
  }

  private stateMsg(d: Duel): ServerMessage {
    return { t: "duel", ...this.state(d) };
  }
}

/** A duelist as it starts: full duel health (its level's), its ticket's
 * stats, skills all ready, no buffs. */
function fighter(p: DuelPeer, mark: { x: number; z: number }): Fighter {
  const kit = pvpKit(p.combat);
  return {
    ...kit,
    uid: p.uid,
    id: p.id,
    hp: kit.maxHp,
    ready: new Map(),
    buffs: [],
    mark,
    stunFrom: 0,
    stunUntil: 0,
    stunAt: mark,
    stuns: new StunReturns(RIMSHOT.drWindowMs),
    rootFrom: 0,
    rootUntil: 0,
    rootAt: mark,
    roots: new StunReturns(CYMBAL_TRAP.drWindowMs),
    slam: null,
    spin: null,
    outUntil: null,
    outLeft: null,
    awayUntil: null,
    dealt: 0,
    hits: 0,
    correctedAt: Number.NEGATIVE_INFINITY,
  };
}

function effects(): DuelEffects {
  return { out: [], place: [], results: [] };
}

function apart(a: { x: number; z: number }, b: { x: number; z: number }) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
