/**
 * The boss room's fight, minus the sockets: who's in it, their health, the
 * boss, and what to tell whom. `room.ts` feeds it frames and relays what it
 * returns, so everything here is tested without a Durable Object.
 */
import type { HitStats } from "@herzies/shared/combat";
import type {
  BossTelegraph,
  FightState,
  LootDrop,
  ServerMessage,
  TownTicketPayload,
} from "@herzies/shared/town-net";
import { BossEngine, type BossEvent, type BossPlayer } from "./boss";
import { PositionHistory } from "./history";

/** How often HP and boss damage are reported while nothing urgent happens. */
export const REPORT_EVERY_MS = 2_000;
/** After the boss falls, how long the room stays open for a victory lap
 * and to pick up the loot. */
export const VICTORY_LINGER_MS = 45_000;
/** After the event ends with the boss alive, how long until the doors close. */
export const ESCAPE_LINGER_MS = 5_000;

export type Outbound = {
  /** Everyone in the room, or one player. */
  to: "all" | { uid: string };
  msg: ServerMessage;
};

export type FightPlayer = {
  uid: string;
  /** The room's entity id for this socket. */
  id: number;
  hp: number;
  maxHp: number;
  down: boolean;
  stats: HitStats;
  present: boolean;
};

/** What the room sends `town-vitals`: absolute HP for everyone present, and
 * the boss damage dealt since the last successful report. `batch` names the
 * damage, so a retry after a lost reply isn't counted twice. */
export type FightReport = {
  hp: { uid: string; hp: number }[];
  boss?: {
    event: string;
    batch: string;
    damage: { uid: string; damage: number }[];
  };
};

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
  private pendingDamage = new Map<string, number>();
  private inflight: {
    batch: string;
    damage: { uid: string; damage: number }[];
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
    const [sonicPower, , critChance, critDamage] = ticket.st ?? [0, 0, 0, 0];
    const p: FightPlayer = {
      uid,
      id,
      hp,
      maxHp,
      down: !!down,
      stats: { sonicPower, critChance, critDamage },
      present: true,
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
   * comes back up from a ticket mid-fight. */
  renew(uid: string, ticket: TownTicketPayload): void {
    const p = this.players.get(uid);
    if (!p || !ticket.st) return;
    const [sonicPower, , critChance, critDamage] = ticket.st;
    p.stats = { sonicPower, critChance, critDamage };
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
    return this.engine.cast(uid, pos, yaw, pitch, p.stats, now);
  }

  /** What a newcomer needs to see the fight as it stands. */
  state(now: number): FightState {
    return {
      event: this.eventId,
      hp: this.engine.hp,
      maxHp: this.engine.maxHp,
      phase: this.engine.currentPhase,
      telegraphs: this.engine.active.map(wire),
      health: [...this.players.values()]
        .filter((p) => p.present)
        .map((p) => ({ id: p.id, hp: p.hp, maxHp: p.maxHp })),
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
    return out;
  }

  private apply(ev: BossEvent, out: Outbound[], now: number) {
    switch (ev.t) {
      case "telegraph":
        out.push({ to: "all", msg: { t: "telegraph", ...wire(ev.telegraph) } });
        break;
      case "resolve": {
        const hit: number[] = [];
        for (const h of ev.hits) {
          const p = this.players.get(h.uid);
          if (!p || p.down) continue;
          p.hp = Math.max(0, p.hp - h.damage);
          hit.push(p.id);
          out.push({
            to: "all",
            msg: { t: "hp", id: p.id, hp: p.hp, maxHp: p.maxHp },
          });
          if (p.hp <= 0) {
            p.down = true;
            out.push({ to: { uid: p.uid }, msg: { t: "down" } });
          }
          this.reportNow = true;
        }
        out.push({ to: "all", msg: { t: "resolve", id: ev.id, hits: hit } });
        break;
      }
      case "hit": {
        this.bossDirty = true;
        this.pendingDamage.set(
          ev.uid,
          (this.pendingDamage.get(ev.uid) ?? 0) + ev.damage,
        );
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
    if (!this.inflight && this.pendingDamage.size) {
      this.inflight = {
        batch: `${this.eventId}:${now}:${++this.batchSeq}:${crypto.randomUUID()}`,
        damage: [...this.pendingDamage].map(([uid, damage]) => ({
          uid,
          damage,
        })),
      };
      this.pendingDamage.clear();
    }
    return {
      hp: [...this.players.values()]
        .filter((p) => p.present || this.leftUnreported.has(p.uid))
        .filter((p) => !(p.down && this.downAcked.has(p.uid)))
        .map((p) => ({ uid: p.uid, hp: p.hp })),
      boss:
        this.inflight && this.eventId !== DEV_EVENT
          ? { event: this.eventId, ...this.inflight }
          : undefined,
    };
  }

  /** `town-vitals` took the report: its boss damage needn't be re-sent. */
  reported(report: FightReport): void {
    for (const r of report.hp) {
      if (!this.players.get(r.uid)?.present) this.leftUnreported.delete(r.uid);
      if (r.hp <= 0) this.downAcked.add(r.uid);
    }
    if (report.boss && this.inflight?.batch === report.boss.batch) {
      this.inflight = null;
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

  /** Whether anything still needs reporting. */
  get unreported(): boolean {
    return (
      this.inflight !== null ||
      this.pendingDamage.size > 0 ||
      this.leftUnreported.size > 0
    );
  }
}

/** The event id used by the local-dev bypass; never reported. */
export const DEV_EVENT = "dev";

function wire(t: {
  id: number;
  kind: "circle" | "ring";
  x: number;
  z: number;
  r: number;
  inner: number;
  at: number;
  hitAt: number;
}): BossTelegraph {
  return {
    id: t.id,
    kind: t.kind,
    x: round(t.x),
    z: round(t.z),
    r: t.r,
    inner: t.inner,
    at: t.at,
    hitAt: t.hitAt,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
