/**
 * The Wilds' free-for-all (see shared wilds-pvp.ts): everyone outside the
 * safe camp may hurt everyone else outside it, and the room judges every
 * blow the way it judges a duel's (pvp.ts): casts and skills from the aim
 * alone, lag-compensated, through the cast budget and a Slinger's discs.
 * Pure like DuelRuntime (an injected clock and RNG): `room.ts` feeds it
 * frames, casts and skills, and relays what it returns.
 *
 * PvP health is the room's alone: it starts full, none of it reaches the
 * database, and being taken down never knocks a herzie out there. Down,
 * it lies where it fell for WILDS_PVP.respawnMs, then gets up in the camp
 * with full health and a moment's protection. Leaving mid-fight counts as
 * being taken down, and a herzie that comes back soon finds its health and
 * its protection as it left them: only a real arrival (first in, or back
 * after WILDS_PVP.keepMs) or getting up is protected afresh, so dropping
 * the socket (the app hides its window, and the client lets go of the
 * room while it's hidden) and coming back is no way to stay untouchable.
 */
import {
  aimDirection,
  DISC_RANGE,
  discLandsAfterMs,
  HERZIE_BODY,
  hitDamage,
  STRIKE_DAMAGE,
} from "@herzies/shared/combat";
import { DUEL, duelAttackShare } from "@herzies/shared/duel";
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
  type ServerMessage,
  type SkillRefusal,
  TOWN_MAPS,
} from "@herzies/shared/town-net";
import { inWildsSafeCamp } from "@herzies/shared/wilds";
import {
  WILDS_PVP,
  wildsDamage,
  wildsInCombat,
  wildsRegenStep,
  wildsSonicCap,
} from "@herzies/shared/wilds-pvp";
import { Bleeds } from "./bleed";
import {
  focused,
  quickness,
  type ShelterDome,
  shelterOf,
  TUNING,
} from "./boss";
import { BARD_BUFF_MAX, CastBudget, StunReturns } from "./budgets";
import { HOLD_CORRECT_EVERY_MS, HOLD_EASE_MS, HOLD_SLACK } from "./duel";
import type { Outbound, SkillResult } from "./fight";
import { DiscHands } from "./hands";
import { PositionHistory } from "./history";
import {
  all,
  buffMsg,
  castMeets,
  firstAlong,
  type PvpBody,
  type PvpKit,
  type PvpTicket,
  pvpKit,
  round,
  seenAt,
  to,
} from "./pvp";
import { Spin } from "./spin";

/** A herzie arriving in the room, as the free-for-all needs it. */
export type WildsPeer = {
  uid: string;
  id: number;
  name: string;
  x: number;
  z: number;
  combat: PvpTicket;
};

/** What a call into the runtime means for the room: what to tell whom,
 * herzies to stand somewhere (getting up in the camp: the room moves
 * them there, resets their move guard and tells them), and herzies taken
 * down (for the Wilds' loot: each drops a card where it fell). */
export type WildsEffects = {
  out: Outbound[];
  place: { uid: string; x: number; z: number }[];
  downs: WildsDown[];
};

/** A herzie taken down (or gone mid-fight, which counts the same): who,
 * by whom, and where it fell. */
export type WildsDown = {
  victim: string;
  victimId: number;
  killer: string;
  at: { x: number; z: number };
};

/** Who last hurt a herzie, as they were then. */
type Hitter = { uid: string; id: number; name: string };

type Brawler = PvpKit & {
  uid: string;
  id: number;
  name: string;
  hp: number;
  ready: Map<SkillId, number>;
  /** Only its own (Haste, Shuffle, its Cymbrella's): in a free-for-all
   * nobody is anybody's ally. */
  buffs: Buff[];
  /** Taken down: it gets up in the camp then. */
  downUntil: number | null;
  /** Hits on it don't count until then (just arrived, or got up; carried
   * over a reconnect, never renewed by one). */
  shieldUntil: number;
  /** Stunned until then. */
  stunUntil: number;
  stuns: StunReturns;
  /** Where it's held (down, or stunned), and since when. */
  heldAt: { x: number; z: number };
  heldFrom: number;
  /** When it was last put right while held. */
  correctedAt: number;
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
  /** When it last took, and last dealt, PvP damage. */
  hurtAt: number;
  dealtAt: number;
  /** Who hurt it last (the one credited if it leaves mid-fight). */
  lastHitBy: Hitter | null;
  /** Its next step of health back, once out of combat. */
  regenAt: number;
};

/** A herzie that left: its health, when it gets up if it was down, and
 * when its protection ends (spent while it's away), until the room forgets
 * it (WILDS_PVP.keepMs) and its next arrival is a fresh one. */
type Kept = {
  hp: number;
  downUntil: number | null;
  shieldUntil: number;
  until: number;
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

export class WildsPvpRuntime {
  private brawlers = new Map<string, Brawler>();
  private kept = new Map<string, Kept>();
  /** Hits in flight: rolled at the cast, judged as they land. */
  private pending: PendingHit[] = [];
  private domes: ShelterDome[] = [];
  /** Forbidden Frequency's discs and bleeds, by the bleeding herzie's
   * uid (FORBIDDEN_FREQUENCY.herzieMs each). */
  private bleeds = new Bleeds(FORBIDDEN_FREQUENCY.herzieMs);
  private casts = new CastBudget(TUNING.castEveryMs, TUNING.castBurst);
  private hands = new DiscHands();
  private history = new PositionHistory();

  constructor(private readonly rand: () => number = Math.random) {}

  /** Something to keep the room ticking for: hits in flight, a Rimshot
   * winding up, records spinning, someone down, or someone's health still
   * coming back. */
  get live(): boolean {
    if (this.pending.length || this.bleeds.busy) return true;
    for (const b of this.brawlers.values())
      if (b.downUntil !== null || b.slam || b.spin || b.hp < b.maxHp)
        return true;
    return false;
  }

  /** Whether `uid` has taken or dealt PvP damage lately: the room holds
   * its moves to a fight's rules then (no hop back onto the spawn). */
  fighting(uid: string, now: number): boolean {
    const b = this.brawlers.get(uid);
    return !!b && wildsInCombat(Math.max(b.hurtAt, b.dealtAt), now);
  }

  /** `uid`'s standing as the room tells it (tests, and a newcomer). */
  standing(uid: string, now: number): ServerMessage | null {
    const b = this.brawlers.get(uid);
    return b ? this.stateMsg(b, now) : null;
  }

  /** Whether `uid` is down (lying where it fell). */
  isDown(uid: string): boolean {
    return this.brawlers.get(uid)?.downUntil != null;
  }

  // --- Coming and going.

  /** `p` arrived (protected a moment), or came back within keepMs (as it
   * left: its health, its time down, what's left of its protection); and
   * told everyone else's standing. The same herzie on a new socket just
   * carries on. */
  join(p: WildsPeer, now: number): WildsEffects {
    const e = effects();
    this.prune(now);
    this.history.record(p.uid, now, p.x, p.z);
    const was = this.brawlers.get(p.uid);
    if (was) {
      was.id = p.id;
      was.name = p.name;
      Object.assign(was, pvpKit(p.combat));
      was.hp = Math.min(was.hp, was.maxHp);
      e.out.push(...this.welcome(p.uid, now));
      return e;
    }
    const b = brawler(p, now);
    this.brawlers.set(p.uid, b);
    e.out.push(...this.welcome(p.uid, now));
    const kept = this.kept.get(p.uid);
    this.kept.delete(p.uid);
    if (kept?.downUntil != null) {
      if (now >= kept.downUntil) {
        // Its time down is over: up in the camp, as if it never left.
        this.respawn(b, now, e);
        return e;
      }
      // Still down: where it is now, until its time is up.
      b.hp = 0;
      b.downUntil = kept.downUntil;
      b.shieldUntil = 0;
      b.heldAt = { x: p.x, z: p.z };
      b.heldFrom = now;
    } else if (kept) {
      b.hp = Math.min(b.maxHp, kept.hp);
      b.shieldUntil = kept.shieldUntil;
    }
    e.out.push(all(this.stateMsg(b, now)));
    return e;
  }

  /** `p` was here when the room went to sleep (with nobody hurt or down,
   * see `live`): it carries on at full health, nothing to tell. */
  adopt(p: WildsPeer, now: number): void {
    const b = brawler(p, now);
    b.shieldUntil = 0;
    this.brawlers.set(p.uid, b);
    this.history.record(p.uid, now, p.x, p.z);
  }

  /** `uid`'s fresh ticket: how it fights from now (its health as it is). */
  renew(uid: string, combat: PvpTicket, now: number): WildsEffects {
    const e = effects();
    const b = this.brawlers.get(uid);
    if (!b) return e;
    const wasMax = b.maxHp;
    Object.assign(b, pvpKit(combat));
    if (b.maxHp === wasMax) return e;
    // A level up: full stays full, hurt stays as hurt.
    b.hp = b.hp >= wasMax ? b.maxHp : Math.min(b.hp, b.maxHp);
    if (b.downUntil !== null) b.hp = 0;
    e.out.push(all(this.stateMsg(b, now)));
    return e;
  }

  /**
   * `uid` left the room (or its socket closed). Hurt by someone in the
   * last WILDS_PVP.combatMs, it's as good as taken down: the last to hurt
   * it gets the line. Its health, its time down and its protection are
   * kept a while for when it comes back: everyone's, hurt or not, or a
   * reconnect would be a fresh arrival.
   */
  gone(uid: string, now: number): WildsEffects {
    const e = effects();
    const b = this.brawlers.get(uid);
    if (!b) return e;
    const at = this.history.at(uid, now) ?? b.heldAt;
    this.brawlers.delete(uid);
    this.history.forget(uid);
    this.casts.forget(uid);
    this.hands.forget(uid);
    this.domes = this.domes.filter((d) => d.by !== uid);
    this.pending = this.pending.filter((h) => h.by !== uid && h.to !== uid);
    // Its bleed goes with it; those it threw last end, nobody to credit.
    this.bleeds.end(uid);
    for (const key of this.bleeds.forget(uid))
      this.bleedOver(key, b.id, now, e);
    let downUntil = b.downUntil;
    if (downUntil === null && b.lastHitBy && wildsInCombat(b.hurtAt, now)) {
      downUntil = now + WILDS_PVP.respawnMs;
      this.feed(b.lastHitBy, b, at, true, now, e);
    }
    this.kept.set(uid, {
      hp: downUntil !== null ? 0 : b.hp,
      downUntil,
      shieldUntil: b.shieldUntil,
      until: now + WILDS_PVP.keepMs,
    });
    return e;
  }

  // --- The fight.

  /** Where the room has `uid` now (fed from its moves). */
  onState(uid: string, x: number, z: number, now: number): void {
    if (this.brawlers.has(uid)) this.history.record(uid, now, x, z);
  }

  /**
   * Where `uid`'s move to (x, z) is held, if it is: where it lies while
   * it's down, where it was stunned while it is, and where a Cymbal Trap
   * caught it while that holds. `correct`: tell it (as a duel's hold: past
   * HOLD_SLACK, after the ease, not too often). Null: it moves freely.
   */
  hold(
    uid: string,
    x: number,
    z: number,
    now: number,
  ): { x: number; z: number; correct: boolean } | null {
    const b = this.brawlers.get(uid);
    if (!b) return null;
    let at: { x: number; z: number };
    let since: number;
    if (b.downUntil !== null || now < b.stunUntil) {
      at = b.heldAt;
      since = b.heldFrom;
    } else if (now < b.rootUntil) {
      at = b.rootAt;
      since = b.rootFrom;
    } else return null;
    const correct =
      Math.hypot(x - at.x, z - at.z) > HOLD_SLACK &&
      now - since >= HOLD_EASE_MS &&
      now - b.correctedAt >= HOLD_CORRECT_EVERY_MS;
    if (correct) b.correctedAt = now;
    return { x: at.x, z: at.z, correct };
  }

  /**
   * A basic cast, judged like a duelist's: its cast budget, its aim (with
   * the assist) at the first herzie in its way as its client saw them, and
   * the flight time. From the camp, or at herzies in it, down or still
   * protected, it meets nobody. Attacking from outside the camp ends your
   * own protection. "ignored": not now (down, stunned, a Rimshot winding
   * up).
   */
  cast(
    uid: string,
    yaw: number,
    pitch: number,
    now: number,
  ): { result: "hit" | "miss" | "cooldown" | "ignored"; out: Outbound[] } {
    const out: Outbound[] = [];
    const b = this.brawlers.get(uid);
    if (!b || b.downUntil !== null || now < b.stunUntil || b.slam)
      return { result: "ignored", out };
    const pos = this.history.at(uid, now);
    if (!pos) return { result: "ignored", out };
    const quick = quickness(b.buffs, now, b.stats.timing);
    if (!this.casts.spend(uid, now, quick)) return { result: "cooldown", out };
    const camp = inWildsSafeCamp(pos.x, pos.z);
    if (!camp) this.unshield(b, now, out);
    const hit = camp
      ? null
      : castMeets(b, pos, yaw, pitch, this.foes(uid, now));
    // Both discs out: see BossEngine.cast.
    if (
      b.attack === "disc" &&
      !this.hands.take(uid, now, hit?.dist ?? null, quick)
    )
      return { result: "miss", out };
    if (!hit) return { result: "miss", out };
    this.queue(b, hit.uid, now, now + hit.flightMs, hit.mult);
    return { result: "hit", out };
  }

  /**
   * A class skill, as in a duel: its attacks hit whoever they meet outside
   * the camp, its heals and buffs only itself (nobody is an ally here).
   * Taunt and Resurrect mean nothing to herzies (refused, "wilds").
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
    const b = this.brawlers.get(uid);
    if (!b || b.downUntil !== null || now < b.stunUntil)
      return { result: "ignored", readyAt: 0, out };
    if (!isSkillId(skillId) || !b.skills.has(skillId))
      return { result: "unknown", readyAt: 0, out };
    if (skillId === "taunt" || skillId === "resurrect")
      return { result: "refused", readyAt: 0, reason: "wilds", out };
    if (!b.armed)
      return { result: "refused", readyAt: 0, reason: "instrument", out };
    const pos = this.history.at(uid, now);
    if (!pos) return { result: "ignored", readyAt: 0, out };
    const readyAt = b.ready.get(skillId) ?? 0;
    if (now < readyAt) {
      const early = readyAt - now <= SKILL_COOLDOWN_GRACE_MS;
      return { result: early ? "early" : "cooldown", readyAt, out };
    }
    const def = SKILL_DEFS[skillId];
    const level = b.skills.get(skillId) ?? 1;
    const value = skillValue(skillId, level);
    b.ready.set(skillId, now + def.cooldownMs);
    out.push(
      all({
        t: "skill",
        by: b.id,
        skill: skillId,
        level,
        x: round(pos.x),
        z: round(pos.z),
        yaw: round(yaw),
      }),
    );
    const camp = inWildsSafeCamp(pos.x, pos.z);

    if (skillId === "soothing-drones") {
      // Its own health only.
      const heal = Math.min(
        b.maxHp - b.hp,
        Math.round(value * healMult(b.stats.euphony) * b.maxHp),
      );
      if (heal > 0) {
        b.hp += heal;
        out.push(all(this.stateMsg(b, now)));
      }
    } else if (skillId === "cymbrella") {
      // A dome where it stands: hits on it there are blocked (see land).
      // Only its own: nobody else shelters under it.
      const ms = Math.round(value * 1000);
      this.domes.push({
        x: pos.x,
        z: pos.z,
        from: now,
        until: now + ms,
        by: uid,
      });
      out.push(
        all(
          buffMsg(
            b.id,
            this.buff(b, { id: "cymbrella", value: 1, until: now + ms }, now),
          ),
        ),
      );
    } else if (
      skillId === "haste" ||
      skillId === "rage" ||
      skillId === "focus"
    ) {
      // Its own only: nobody is anybody's ally here.
      const strength = Math.min(
        BARD_BUFF_MAX[skillId],
        value * buffMult(b.stats.euphony),
      );
      const until = now + (def.durationMs ?? 0);
      out.push(
        all(
          buffMsg(
            b.id,
            this.buff(b, { id: skillId, value: strength, until, by: uid }, now),
          ),
        ),
      );
    } else if (skillId === "multispin") {
      // Records round it for its length: whoever it may hurt takes a hit
      // from each that touches them (stepSpins). The app draws them from
      // the buff.
      if (!camp) this.unshield(b, now, out);
      const records = multispinRecords(level);
      const until = now + (def.durationMs ?? 0);
      b.spin = new Spin(now, until, records);
      out.push(
        all(
          buffMsg(
            b.id,
            this.buff(b, { id: "multispin", value: records, until }, now),
          ),
        ),
      );
    } else if (skillId === "shuffle") {
      const until = now + (def.durationMs ?? 0);
      const bounces = shuffleBounces(level);
      out.push(
        all(
          buffMsg(
            b.id,
            this.buff(b, { id: "shuffle", value: bounces, until }, now),
          ),
        ),
      );
    } else if (skillId === "backspin") {
      if (!camp) {
        this.unshield(b, now, out);
        const foes = this.foes(uid, now);
        // Each a disc: `value` of a wave, at a disc's share (as in a duel).
        const mult = value * DUEL.discShare;
        const half = (BACKSPIN_DISCS - 1) / 2;
        for (let i = 0; i < BACKSPIN_DISCS; i++) {
          const dir = aimDirection(yaw + (i - half) * BACKSPIN_SPREAD, pitch);
          const hit = firstAlong(pos, dir, foes, DISC_RANGE);
          if (hit)
            this.queue(b, hit.uid, now, now + discLandsAfterMs(hit.dist), mult);
        }
      }
    } else if (skillId === "forbidden-frequency") {
      // A disc that bleeds the first it meets where it lands
      // (stepBleeds).
      if (!camp) {
        this.unshield(b, now, out);
        const hit = firstAlong(
          pos,
          aimDirection(yaw, pitch),
          this.foes(uid, now),
          DISC_RANGE,
        );
        if (hit)
          this.bleeds.throw({
            at: now + discLandsAfterMs(hit.dist),
            by: uid,
            key: hit.uid,
            level,
            stats: focused(b.stats, b.buffs, now),
          });
      }
    } else if (skillId === "cymbal-trap") {
      // Thrown: a stick's blow on the first it meets when it gets there,
      // and a hold (see land).
      if (!camp) {
        this.unshield(b, now, out);
        const hit = firstAlong(
          pos,
          aimDirection(yaw, pitch),
          this.foes(uid, now),
          CYMBAL_TRAP.range,
        );
        if (hit)
          this.queue(
            b,
            hit.uid,
            now,
            now + cymbalLandsAfterMs(hit.dist),
            CYMBAL_TRAP.damage * duelAttackShare("melee", STRIKE_DAMAGE),
            Math.round(value * 1000),
          );
      }
    } else if (skillId === "rimshot") {
      if (!camp) this.unshield(b, now, out);
      // The wind-up: it lands where it began, when it's done (stepSlams).
      b.slam = { until: now + (def.castMs ?? 0), x: pos.x, z: pos.z, level };
    }
    return { result: "used", readyAt: now + def.cooldownMs, out };
  }

  /** Advance to `now`: Rimshots slam, hits land, the downed get up in the
   * camp, and health comes back to those out of combat. */
  step(now: number): WildsEffects {
    const e = effects();
    this.prune(now);
    this.stepSlams(now, e);
    this.stepSpins(now, e);
    this.stepBleeds(now, e);
    this.land(now, e);
    for (const b of this.brawlers.values()) {
      if (b.downUntil !== null) {
        if (now >= b.downUntil) this.respawn(b, now, e);
        continue;
      }
      if (
        b.hp < b.maxHp &&
        now >= b.regenAt &&
        !wildsInCombat(Math.max(b.hurtAt, b.dealtAt), now)
      ) {
        b.hp = Math.min(b.maxHp, b.hp + wildsRegenStep(b.maxHp));
        b.regenAt = now + WILDS_PVP.regenEveryMs;
        e.out.push(all(this.stateMsg(b, now)));
      }
    }
    this.domes = this.domes.filter((d) => d.until > now);
    return e;
  }

  /** Rimshots whose wind-up is done slam: everyone it may hurt within
   * reach of where it began takes the blow, and rolls for a stun. */
  private stepSlams(now: number, e: WildsEffects) {
    for (const b of this.brawlers.values()) {
      const s = b.slam;
      if (!s || now < s.until) continue;
      b.slam = null;
      if (inWildsSafeCamp(s.x, s.z)) continue;
      for (const foe of this.foes(b.uid, now)) {
        if (
          Math.hypot(foe.x - s.x, foe.z - s.z) >
          RIMSHOT.radius + HERZIE_BODY.radius
        )
          continue;
        // Two blows of a stick.
        this.queue(
          b,
          foe.uid,
          now,
          now,
          RIMSHOT.damage * duelAttackShare("melee", STRIKE_DAMAGE),
        );
        const v = this.brawlers.get(foe.uid);
        if (
          v &&
          this.rand() < skillValue("rimshot", s.level) &&
          now >= v.stunUntil
        )
          this.stun(v, now, e);
      }
    }
  }

  /** Forbidden Frequency discs that arrived take hold on whoever may
   * still be hurt (up, out of the camp, no dome taking it), and bleeds
   * tick: stacks × its share of a wave at a disc's share, from its
   * thrower's stats (Sonic Power held to its victim's band, no crit) as
   * hard as its Rage makes it, landing as a hit at once. */
  private stepBleeds(now: number, e: WildsEffects) {
    for (const disc of this.bleeds.landed(now)) {
      const v = this.brawlers.get(disc.key);
      const by = this.brawlers.get(disc.by);
      if (!v || !by || v.downUntil !== null || this.inCamp(v.uid, disc.at))
        continue;
      const dome = shelterOf(
        this.domes.filter((d) => d.by === v.uid),
        {
          uid: v.uid,
          alive: true,
          maxHp: v.maxHp,
          posAt: (t) => this.history.at(v.uid, t),
        },
        disc.at,
      );
      if (dome) continue;
      const b = this.bleeds.stack(disc, now);
      e.out.push(
        all({
          t: "bleed",
          by: by.id,
          target: v.id,
          stacks: b.stacks,
          until: b.until,
        }),
      );
    }
    for (const { key, bleed: b } of this.bleeds.ticks(now)) {
      const v = this.brawlers.get(key);
      const by = this.brawlers.get(b.by);
      if (!v || !by) continue;
      const { amount } = hitDamage(
        {
          ...b.stats,
          sonicPower: Math.min(b.stats.sonicPower, wildsSonicCap(v.level)),
          critChance: 0,
        },
        this.rand,
      );
      this.pending.push({
        at: now,
        by: by.uid,
        to: v.uid,
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

  /** The bleed on `uid` (last thrown by entity `by`) ended early: it
   * fell, or its thrower left. The room sees it stop. */
  private bleedOver(uid: string, by: number, now: number, e: WildsEffects) {
    const v = this.brawlers.get(uid);
    if (v)
      e.out.push(all({ t: "bleed", by, target: v.id, stacks: 0, until: now }));
  }

  /** Multispins' records touch whoever their Slinger may hurt, round
   * wherever it stands: a hit of MULTISPIN.damage of a wave at a disc's
   * share (as Backspin's), landing at once. From the camp they touch
   * nobody; touching someone ends the Slinger's own protection. */
  private stepSpins(now: number, e: WildsEffects) {
    for (const b of this.brawlers.values()) {
      const s = b.spin;
      if (!s) continue;
      const pos = this.history.at(b.uid, now);
      const bodies =
        pos && !inWildsSafeCamp(pos.x, pos.z)
          ? this.foes(b.uid, now).map((f) => ({
              key: f.uid,
              x: f.x,
              z: f.z,
              r: HERZIE_BODY.radius,
            }))
          : [];
      const touches = s.touches(now, (t) => this.history.at(b.uid, t), bodies);
      if (touches.length) this.unshield(b, now, e.out);
      for (const touch of touches)
        this.queue(b, touch.key, now, now, MULTISPIN.damage * DUEL.discShare);
      if (s.over(now)) b.spin = null;
    }
  }

  /** Stunned by a Rimshot: held where it stands, its own Rimshot (if
   * winding up) lost, for a mob's stun scaled for a herzie with its
   * diminishing returns. */
  private stun(v: Brawler, now: number, e: WildsEffects) {
    const ms = v.stuns.take(now, RIMSHOT.stunMs * WILDS_PVP.stunScale);
    v.stunUntil = now + ms;
    v.heldFrom = now;
    v.heldAt = this.history.at(v.uid, now) ?? v.heldAt;
    this.dropSlam(v, e.out);
    e.out.push(all({ t: "pvpStun", id: v.id, until: v.stunUntil }));
  }

  /** Caught by a Cymbal Trap thrown by `by`: held where it stands (it may
   * turn, cast and use its skills, a Rimshot winding up included), for
   * `base` with its holds' diminishing returns. Not while it already is. */
  private root(
    v: Brawler,
    by: Brawler,
    now: number,
    base: number,
    e: WildsEffects,
  ) {
    if (now < v.rootUntil) return;
    const ms = v.roots.take(now, base);
    v.rootFrom = now;
    v.rootUntil = now + ms;
    v.rootAt = this.history.at(v.uid, now) ?? v.heldAt;
    e.out.push(all({ t: "trap", by: by.id, target: v.id, until: v.rootUntil }));
  }

  /** Hits that have arrived land: on nobody in the camp (now or a moment
   * ago, in the defender's favour), a dome may take them, and the last of
   * a herzie's health takes it down. */
  private land(now: number, e: WildsEffects) {
    if (!this.pending.length) return;
    const due = this.pending
      .filter((h) => h.at <= now)
      .sort((x, y) => x.at - y.at);
    if (!due.length) return;
    this.pending = this.pending.filter((h) => h.at > now);
    for (const h of due) {
      const by = this.brawlers.get(h.by);
      const v = this.brawlers.get(h.to);
      if (!by || !v || v.downUntil !== null) continue;
      if (this.inCamp(v.uid, h.at)) continue;
      const dome = shelterOf(
        this.domes.filter((d) => d.by === v.uid),
        {
          uid: v.uid,
          alive: true,
          maxHp: v.maxHp,
          posAt: (t) => this.history.at(v.uid, t),
        },
        h.at,
      );
      if (dome) {
        e.out.push(
          to(by.uid, {
            t: "pvpHit",
            target: v.id,
            damage: 0,
            crit: h.crit,
            blocked: true,
            ...(h.bleed ? { bleed: true as const } : {}),
          }),
        );
        continue;
      }
      const damage = wildsDamage({
        amount: h.amount,
        mult: h.mult,
        def: v.def,
        reductions: buffReductions(v.buffs, h.at),
        maxHp: v.maxHp,
      });
      v.hp = Math.max(0, v.hp - damage);
      v.hurtAt = now;
      by.dealtAt = now;
      v.lastHitBy = { uid: by.uid, id: by.id, name: by.name };
      e.out.push(
        to(by.uid, {
          t: "pvpHit",
          target: v.id,
          damage,
          crit: h.crit,
          ...(h.bleed ? { bleed: true as const } : {}),
        }),
      );
      if (v.hp <= 0) this.takeDown(v, by, now, e);
      else {
        e.out.push(all(this.stateMsg(v, now, by.id)));
        if (h.hold) this.root(v, by, now, h.hold, e);
      }
    }
  }

  /** `v` is taken down by `by`: it lies where it fell, its buffs and
   * Rimshot gone, until it gets up in the camp; the line goes out. */
  private takeDown(v: Brawler, by: Brawler, now: number, e: WildsEffects) {
    v.downUntil = now + WILDS_PVP.respawnMs;
    v.heldAt = this.history.at(v.uid, now) ?? v.heldAt;
    v.heldFrom = now;
    v.stunUntil = 0;
    v.rootUntil = 0;
    this.dropSlam(v, e.out);
    v.spin = null;
    const bleed = this.bleeds.end(v.uid);
    if (bleed)
      this.bleedOver(v.uid, this.brawlers.get(bleed.by)?.id ?? 0, now, e);
    for (const b of activeBuffs(v.buffs, now))
      e.out.push(all({ t: "buffOff", id: v.id, buff: b.id }));
    v.buffs = [];
    this.domes = this.domes.filter((d) => d.by !== v.uid);
    e.out.push(all(this.stateMsg(v, now, by.id)));
    this.feed(
      { uid: by.uid, id: by.id, name: by.name },
      v,
      v.heldAt,
      false,
      now,
      e,
    );
  }

  /** Up in the camp: full health, protected a moment, put on the spawn. */
  private respawn(b: Brawler, now: number, e: WildsEffects) {
    const { spawn } = TOWN_MAPS.wilds;
    b.hp = b.maxHp;
    b.downUntil = null;
    b.shieldUntil = now + WILDS_PVP.shieldMs;
    b.stunUntil = 0;
    b.rootUntil = 0;
    b.hurtAt = Number.NEGATIVE_INFINITY;
    b.dealtAt = Number.NEGATIVE_INFINITY;
    b.lastHitBy = null;
    b.heldAt = { ...spawn };
    this.history.forget(b.uid);
    this.history.record(b.uid, now, spawn.x, spawn.z);
    this.hands.forget(b.uid);
    e.place.push({ uid: b.uid, x: spawn.x, z: spawn.z });
    e.out.push(all(this.stateMsg(b, now)));
  }

  /** The line: `by` took `v` down (or `v` left mid-fight, `logged`). To
   * the two of them and anyone within WILDS_PVP.feedRange of `at`. */
  private feed(
    by: Hitter,
    v: Pick<Brawler, "uid" | "id" | "name">,
    at: { x: number; z: number },
    logged: boolean,
    now: number,
    e: WildsEffects,
  ) {
    const msg: ServerMessage = {
      t: "pvpFeed",
      by: this.brawlers.get(by.uid)?.id ?? null,
      byName: by.name,
      victim: v.id,
      victimName: v.name,
      ...(logged ? { logged: true as const } : {}),
    };
    const near = new Set([by.uid, v.uid]);
    for (const b of this.brawlers.values()) {
      const p = this.history.at(b.uid, now);
      if (p && Math.hypot(p.x - at.x, p.z - at.z) <= WILDS_PVP.feedRange)
        near.add(b.uid);
    }
    for (const uid of near)
      if (this.brawlers.has(uid)) e.out.push(to(uid, msg));
    e.downs.push({
      victim: v.uid,
      victimId: v.id,
      killer: by.uid,
      at: { ...at },
    });
  }

  // --- Helpers.

  /** Everyone `uid` may hurt now, where its client saw them: up, out of
   * the camp, and no longer protected. */
  private foes(uid: string, now: number): PvpBody[] {
    const out: PvpBody[] = [];
    for (const b of this.brawlers.values()) {
      if (b.uid === uid || b.downUntil !== null || now < b.shieldUntil)
        continue;
      const seen = seenAt(this.history, b.uid, now);
      if (seen && !inWildsSafeCamp(seen.x, seen.z))
        out.push({ uid: b.uid, x: seen.x, z: seen.z });
    }
    return out;
  }

  /** Whether `uid` stands in the camp at `t`, or did a moment before. */
  private inCamp(uid: string, t: number): boolean {
    for (const at of [t, t - TUNING.rewindMs]) {
      const p = this.history.at(uid, at);
      if (p && inWildsSafeCamp(p.x, p.z)) return true;
    }
    return false;
  }

  /** A hit from `by` on `victimUid` landing at `at`: rolled `now`, with
   * `by`'s Sonic Power held to its victim's level band (its crit chance as
   * a Focus has it, its share of a wave as hard as a Rage makes it).
   * `hold`: a Cymbal Trap's (ms). */
  private queue(
    by: Brawler,
    victimUid: string,
    now: number,
    at: number,
    mult: number,
    hold?: number,
  ) {
    const v = this.brawlers.get(victimUid);
    if (!v) return;
    const stats = focused(
      {
        ...by.stats,
        sonicPower: Math.min(by.stats.sonicPower, wildsSonicCap(v.level)),
      },
      by.buffs,
      now,
    );
    const { amount, crit } = hitDamage(stats, this.rand);
    this.pending.push({
      at,
      by: by.uid,
      to: victimUid,
      amount,
      crit,
      mult: mult * buffMultiplier(by.buffs, "damage", now),
      ...(hold ? { hold } : {}),
    });
  }

  private buff(b: Brawler, next: Buff, now: number): Buff {
    b.buffs = applyBuff(b.buffs, next, now);
    return b.buffs.find((x) => x.id === next.id) as Buff;
  }

  /** It attacked: no longer protected. */
  private unshield(b: Brawler, now: number, out: Outbound[]) {
    if (now >= b.shieldUntil) return;
    b.shieldUntil = 0;
    out.push(all(this.stateMsg(b, now)));
  }

  /** A Rimshot winding up is lost; the room sees it stop. */
  private dropSlam(b: Brawler, out: Outbound[]) {
    if (!b.slam) return;
    b.slam = null;
    out.push(all({ t: "channel", by: b.id, target: null, until: 0 }));
  }

  /** Everyone else's standing, for `uid`: those not at full health, up
   * and unprotected (nothing to tell of them). */
  private welcome(uid: string, now: number): Outbound[] {
    const out: Outbound[] = [];
    for (const b of this.brawlers.values()) {
      const plain =
        b.hp >= b.maxHp && b.downUntil === null && now >= b.shieldUntil;
      if (b.uid !== uid && !plain) out.push(to(uid, this.stateMsg(b, now)));
    }
    return out;
  }

  private prune(now: number) {
    for (const [uid, k] of this.kept) if (now >= k.until) this.kept.delete(uid);
  }

  private stateMsg(b: Brawler, now: number, by?: number): ServerMessage {
    return {
      t: "pvp",
      id: b.id,
      hp: b.hp,
      maxHp: b.maxHp,
      ...(b.downUntil !== null ? { down: b.downUntil } : {}),
      ...(now < b.shieldUntil ? { shield: b.shieldUntil } : {}),
      ...(by !== undefined ? { by } : {}),
    };
  }
}

/** A herzie just arrived: full PvP health, protected a moment (`join`
 * takes back what a returning one left with). */
function brawler(p: WildsPeer, now: number): Brawler {
  const kit = pvpKit(p.combat);
  return {
    ...kit,
    uid: p.uid,
    id: p.id,
    name: p.name,
    hp: kit.maxHp,
    ready: new Map(),
    buffs: [],
    downUntil: null,
    shieldUntil: now + WILDS_PVP.shieldMs,
    stunUntil: 0,
    stuns: new StunReturns(RIMSHOT.drWindowMs),
    heldAt: { x: p.x, z: p.z },
    heldFrom: now,
    rootFrom: 0,
    rootUntil: 0,
    rootAt: { x: p.x, z: p.z },
    roots: new StunReturns(CYMBAL_TRAP.drWindowMs),
    correctedAt: Number.NEGATIVE_INFINITY,
    slam: null,
    spin: null,
    hurtAt: Number.NEGATIVE_INFINITY,
    dealtAt: Number.NEGATIVE_INFINITY,
    lastHitBy: null,
    regenAt: 0,
  };
}

function effects(): WildsEffects {
  return { out: [], place: [], downs: [] };
}
