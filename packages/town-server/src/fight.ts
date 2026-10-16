/**
 * The boss room's fight, minus the sockets: who's in it, their health, the
 * boss, and what to tell whom. `room.ts` feeds it frames and relays what it
 * returns, so everything here is tested without a Durable Object.
 */
import {
  type AttackStyle,
  attackStyle,
  isHerzieClass,
} from "@herzies/shared/classes";
import {
  type Contribution,
  contributionOf,
  type HitStats,
  meleeDamage,
} from "@herzies/shared/combat";
import { CONSUMABLE_COOLDOWN_MS } from "@herzies/shared/medea";
import {
  isSkillId,
  SKILL_COOLDOWN_GRACE_MS,
  SKILL_DEFS,
  type SkillId,
  skillValue,
  skillXpFor,
} from "@herzies/shared/skills";
import { buffMult, healMult } from "@herzies/shared/stats";
import type {
  BossPlace,
  BossTelegraph,
  EatRefusal,
  FightState,
  LootDrop,
  ServerMessage,
  TownLook,
  TownTicketPayload,
} from "@herzies/shared/town-net";
import {
  BossEngine,
  type BossEvent,
  type BossPlayer,
  type Telegraph,
  TUNING,
} from "./boss";
import { PositionHistory } from "./history";

/** The room holds eating to CONSUMABLE_COOLDOWN_MS less this, so a client
 * keeping to the full cooldown is never refused (or struck) for network
 * jitter. */
const EAT_COOLDOWN_GRACE_MS = 250;

/** How often HP and boss damage are reported while nothing urgent happens. */
export const REPORT_EVERY_MS = 2_000;
/** After the boss falls, how long the room stays open for a victory lap
 * and to pick up the loot. */
export const VICTORY_LINGER_MS = 45_000;
/** After the event ends with the boss alive, how long until the doors close. */
export const ESCAPE_LINGER_MS = 15_000;

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
  /** Its basic attack, from its class: a wave, or a thrown disc. */
  attack: AttackStyle;
  /** A melee blow's share of a wave: a stick with a class, else a bump. */
  melee: number;
};

/** What became of a skill. "early" is a cooldown refusal inside the grace
 * window: refused, but not held against the socket. */
export type SkillResult = "used" | "cooldown" | "early" | "unknown" | "ignored";

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
};

/** What one herzie did for the fight since the last batch: damage dealt,
 * and HP healed or blocked (support, 00111). Zero parts are left out. */
export type BossRow = {
  uid: string;
  damage: number;
  healing?: number;
  blocked?: number;
};

/** Until the end screen's table comes back, the fight reports this often. */
const RESULTS_RETRY_MS = 1_000;

type Claim = NonNullable<TownTicketPayload["boss"]>;

export class FightRuntime {
  readonly engine: BossEngine;
  readonly eventId: string;
  /** Unix ms when the boss escapes. */
  readonly until: number;
  /** When the room shuts (server ms), once something has ended the fight. */
  closesAt: number | null = null;
  closeWhy: "victory" | "escaped" | null = null;

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

  constructor(claim: Claim, now: number, seed = now) {
    this.eventId = claim.event;
    this.until = claim.until * 1000;
    this.engine = new BossEngine({
      hp: claim.hp,
      maxHp: claim.maxHp,
      seed,
      now,
    });
    this.nextReportAt = now + REPORT_EVERY_MS;
  }

  get open(): boolean {
    return this.closesAt === null;
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
    const hp = behind ? Math.min(known.hp, fromTicket) : fromTicket;
    const down = ticket.hp?.down || hp <= 0 || (behind && known.down);
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
      attack: attackStyle(ticket.cls),
      melee: meleeDamage(isHerzieClass(ticket.cls)),
      // A rejoin doesn't reset cooldowns.
      ready: known?.ready ?? new Map(),
    };
    this.players.set(uid, p);
    this.history.record(uid, now, at.x, at.z);
    this.engine.noteSpawn(uid, now);
    return p;
  }

  /** Someone left (or lost their connection). Their health stays on record. */
  leave(uid: string): void {
    const p = this.players.get(uid);
    if (!p) return;
    p.present = false;
    this.history.forget(uid);
    this.leftUnreported.add(uid);
    this.reportNow = true;
  }

  /** A player's ticket was renewed: only stats may change; health never
   * comes back up from a ticket mid-fight, and max HP stays as it joined. */
  renew(uid: string, ticket: TownTicketPayload): void {
    const p = this.players.get(uid);
    if (!p) return;
    // Skill levels only go up: a ticket issued before a level-up this fight
    // reported mustn't take it back.
    for (const [skill, level] of skillsOf(ticket))
      p.skills.set(skill, Math.max(level, p.skills.get(skill) ?? 0));
    if (!ticket.st) return;
    p.stats = statsOf(ticket.st);
  }

  player(uid: string): FightPlayer | undefined {
    return this.players.get(uid);
  }

  onState(uid: string, x: number, z: number, now: number): void {
    if (this.players.get(uid)?.present) this.history.record(uid, now, x, z);
  }

  /** A cast. Ignored once knocked out or when the fight is over. */
  cast(
    uid: string,
    yaw: number,
    pitch: number,
    now: number,
  ): "hit" | "miss" | "cooldown" | "dead" | "ignored" {
    const p = this.players.get(uid);
    if (!p?.present || p.down || !this.open) return "ignored";
    const pos = this.history.at(uid, now);
    if (!pos) return "ignored";
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
  ): { result: SkillResult; readyAt: number; out: Outbound[] } {
    const out: Outbound[] = [];
    const p = this.players.get(uid);
    if (!p?.present || p.down || !this.open)
      return { result: "ignored", readyAt: 0, out };
    if (!isSkillId(skillId) || !p.skills.has(skillId))
      return { result: "unknown", readyAt: 0, out };
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
    p.ready.set(skillId, now + def.cooldownMs);

    out.push({
      to: "all",
      msg: {
        t: "skill",
        by: p.id,
        skill: skillId,
        level,
        x: round(pos.x),
        z: round(pos.z),
        yaw: round(yaw),
      },
    });

    if (skillId === "soothing-drones") {
      let restored = 0;
      for (const o of this.players.values()) {
        if (!o.present || o.down) continue;
        const at = this.history.at(o.uid, now);
        if (!at) continue;
        if (Math.hypot(at.x - pos.x, at.z - pos.z) > (def.radius ?? 0))
          continue;
        const heal = Math.min(
          o.maxHp - o.hp,
          value * healMult(p.stats.euphony) * o.maxHp,
        );
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
      out.push({
        to: "all",
        msg: {
          t: "buff",
          id: p.id,
          buff: buff.id,
          value: buff.value,
          until: buff.until,
        },
      });
    } else if (skillId === "backspin") {
      this.engine.backspin(uid, pos, yaw, pitch, p.stats, value, now);
    }
    return { result: "used", readyAt: now + def.cooldownMs, out };
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

  /** What a newcomer needs to see the fight as it stands. */
  state(now: number): FightState {
    return {
      event: this.eventId,
      hp: this.engine.hp,
      maxHp: this.engine.maxHp,
      phase: this.engine.currentPhase,
      telegraphs: this.engine.active.map((t) => this.wire(t)),
      health: [...this.players.values()]
        .filter((p) => p.present)
        .map((p) => ({ id: p.id, hp: p.hp, maxHp: p.maxHp })),
      buffs: this.engine.activeBuffs(now).flatMap(({ uid, buff }) => {
        const p = this.players.get(uid);
        return p?.present
          ? [{ id: p.id, buff: buff.id, value: buff.value, until: buff.until }]
          : [];
      }),
      now,
    };
  }

  /** Advance the fight to `now`. */
  step(now: number): Outbound[] {
    const out: Outbound[] = [];
    const alive: BossPlayer[] = [];
    for (const p of this.players.values()) {
      if (!p.present) continue;
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
      if (this.open && now >= this.until) {
        this.closesAt = now + ESCAPE_LINGER_MS;
        this.closeWhy = "escaped";
        this.reportNow = true;
        out.push({
          to: "all",
          msg: { t: "closing", why: "escaped", closesAt: this.closesAt },
        });
      }
    }
    // The dev boss's end screen comes from the room itself, at once.
    if (this.closeWhy && this.eventId === DEV_EVENT && !this.resultsSent)
      out.push(...this.results(this.devTable()));
    return out;
  }

  private apply(ev: BossEvent, out: Outbound[], now: number) {
    switch (ev.t) {
      case "telegraph":
        out.push({
          to: "all",
          msg: { t: "telegraph", ...this.wire(ev.telegraph) },
        });
        break;
      case "resolve": {
        const hit: number[] = [];
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
          out.push({
            to: "all",
            msg: { t: "hp", id: p.id, hp: p.hp, maxHp: p.maxHp },
          });
          if (p.hp <= 0) {
            p.down = true;
            // Knocked out: nothing left to raise the stored health toward.
            this.healed.delete(p.uid);
            out.push({ to: { uid: p.uid }, msg: { t: "down" } });
          }
          this.reportNow = true;
        }
        out.push({ to: "all", msg: { t: "resolve", id: ev.id, hits: hit } });
        break;
      }
      case "hit": {
        this.bossDirty = true;
        this.credit(ev.uid, "damage", ev.damage);
        if (ev.skill && isSkillId(ev.skill))
          this.earn(ev.uid, ev.skill, skillXpFor(ev.skill, ev.damage));
        out.push({
          to: { uid: ev.uid },
          msg: { t: "hit", damage: ev.damage, crit: ev.crit },
        });
        break;
      }
      case "phase":
        this.bossDirty = true;
        break;
      case "killed": {
        this.closesAt = now + VICTORY_LINGER_MS;
        this.closeWhy = "victory";
        this.reportNow = true;
        const by = this.players.get(ev.by)?.id ?? 0;
        out.push({
          to: "all",
          msg: { t: "victory", by, closesAt: this.closesAt },
        });
        // The local-dev boss is never reported, so nothing would ever say
        // what dropped: give everyone here a CD to look at (no real drop
        // behind it, so picking it up collects nothing).
        if (this.eventId === DEV_EVENT) {
          const loot: Record<string, LootDrop[]> = {};
          for (const p of this.players.values())
            loot[p.uid] = [{ id: "", item: "cd" }];
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
          if (healing > 0) row.healing = healing;
          if (blocked > 0) row.blocked = blocked;
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
    // Over: ask for the end screen's table, but only on a report whose
    // batch carries every hit there was (one re-sent from before would
    // leave the last of them out). Until it's back, report again soon.
    let results: FightReport["results"];
    if (this.closeWhy && !this.resultsSent && this.eventId !== DEV_EVENT) {
      if (!this.pending.size)
        results = {
          event: this.eventId,
          uids: [...this.players.values()]
            .filter((p) => p.present)
            .map((p) => p.uid),
        };
      this.nextReportAt = Math.min(this.nextReportAt, now + RESULTS_RETRY_MS);
    }
    return {
      results,
      hp: [...this.players.values()]
        .filter((p) => p.present || this.leftUnreported.has(p.uid))
        .filter((p) => !(p.down && this.downAcked.has(p.uid)))
        .map((p) => {
          const heal = Math.round(this.healed.get(p.uid) ?? 0);
          return heal > 0
            ? { uid: p.uid, hp: p.hp, heal }
            : { uid: p.uid, hp: p.hp };
        }),
      boss:
        this.inflight && this.eventId !== DEV_EVENT
          ? { event: this.eventId, ...this.inflight }
          : undefined,
      skills:
        this.xpInflight && this.eventId !== DEV_EVENT
          ? this.xpInflight
          : undefined,
    };
  }

  /** `town-vitals` took the report: its boss damage needn't be re-sent. */
  reported(report: FightReport): void {
    for (const r of report.hp) {
      if (!this.players.get(r.uid)?.present) this.leftUnreported.delete(r.uid);
      if (r.hp <= 0) this.downAcked.add(r.uid);
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
   * Victory if the boss fell, defeat if it got away.
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
          damage: Math.round(c.damage),
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
      r: t.r,
      inner: t.inner,
      at: t.at,
      hitAt: t.hitAt,
      ...(target !== undefined ? { target } : {}),
    };
  }

  /** `uid` did `amount` of `kind` for the fight: into the next batch (and
   * the dev boss's own tally). */
  private credit(uid: string, kind: keyof Contribution, amount: number) {
    if (!(amount > 0)) return;
    for (const tally of this.eventId === DEV_EVENT
      ? [this.pending, this.devDealt]
      : [this.pending]) {
      const c = tally.get(uid) ?? { damage: 0, healing: 0, blocked: 0 };
      c[kind] += amount;
      tally.set(uid, c);
    }
  }

  /** Whether anything still needs reporting. */
  get unreported(): boolean {
    return (
      this.inflight !== null ||
      this.pending.size > 0 ||
      this.leftUnreported.size > 0 ||
      this.xpInflight !== null ||
      this.healed.size > 0
    );
  }
}

/** The event id used by the local-dev bypass; never reported. */
export const DEV_EVENT = "dev";

/** The skills a ticket says this herzie has, at their levels. */
/** What a fight reads off a player's stats: a cast's damage, their Def, and
 * what Euphony does to their skills. */
export type FightStats = HitStats & { def: number; euphony: number };

/** Stats from a ticket's `st`; a ticket from before stat points has no Def
 * or Euphony, and one from before stats has nothing. */
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
