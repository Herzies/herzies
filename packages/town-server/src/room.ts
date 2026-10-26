/**
 * One shard of one Town map: a Durable Object every player in it is
 * connected to.
 *
 * Clients report where their herzie is; the room checks each move and, 15
 * times a second, sends everyone one snapshot of whoever moved. A quiet room
 * (nobody walking) runs no timer, and pings are answered by the runtime
 * without waking the object, so idle rooms hibernate and cost nothing.
 *
 * Hibernation drops everything in memory, so each socket carries what's
 * needed to rebuild its player (its attachment), and the constructor
 * rebuilds from those.
 */

import { DurableObject } from "cloudflare:workers";
import { parseTune, TUNE_MIN_INTERVAL_MS } from "@herzies/shared/boss-fight";
import { SKILL_DEFS, skillValue } from "@herzies/shared/skills";
import { healMult } from "@herzies/shared/stats";
import {
  type BossClaim,
  decodeCastFrame,
  decodeStateFrame,
  type EatRefusal,
  encodeSnapshot,
  isTownMapId,
  quantizeState,
  type ServerMessage,
  type SnapshotEntry,
  TOWN_CLOSE,
  TOWN_FLAG_SITTING,
  TOWN_INSTANCED_MAPS,
  TOWN_MAPS,
  TOWN_PING,
  TOWN_PONG,
  TOWN_PROTOCOL,
  TOWN_ROOM_CAPACITY,
  TOWN_TICK_MS,
  TOWN_TICKET_TTL_S,
  TOWN_TICKETED_MAPS,
  type TownLook,
  type TownMapId,
  type TownPlayer,
  type TownState,
  type TownTicketPayload,
  verifyTownTicket,
} from "@herzies/shared/town-net";
import { benchBonusHp } from "@herzies/shared/vitals";
import { CHANNEL_SLACK, DEV_EVENT, FightRuntime, type Outbound } from "./fight";
import { RestMeter } from "./rest";
import {
  checkMove,
  type MoveGuard,
  newGuard,
  RateLimiter,
  startingPoint,
} from "./rules";
import { eatInDb, postVitals, reviveInDb } from "./vitals";

export type Env = {
  TOWN_ROOM: DurableObjectNamespace<TownRoom>;
  TOWN_TICKET_SECRET: string;
  /** Overrides {@link TOWN_ROOM_CAPACITY} (tests). */
  ROOM_CAPACITY?: string;
  /** The `town-vitals` edge function. Unset: the room reports no health. */
  TOWN_VITALS_URL?: string;
  /** Local dev only: let the boss room open without an event, with a
   * throwaway boss that is never reported. */
  DEV_BOSS?: string;
  /** Local dev only: how long the dev boss's lobby lasts, in seconds
   * (default 20). */
  DEV_BOSS_LOBBY_S?: string;
};

/** A socket must say hello this soon after connecting. */
const HELLO_TIMEOUT_MS = 5_000;
/** Clients ping every 10 s; this much silence means they're gone. */
const IDLE_TIMEOUT_MS = 45_000;
/** How often the room looks for dead sockets and expired tickets. */
const SWEEP_MS = 30_000;
/** Grace past a ticket's expiry for a renewal still in flight. */
const TICKET_GRACE_S = 30;
/** Ticks with nobody moving before the timer stops. */
const IDLE_TICKS = 15;
/** Messages a second per socket, and the burst allowed. */
const RATE = 30;
const BURST = 45;
/** Dropped or refused messages per sweep before a socket is kicked. */
const MAX_STRIKES = 90;
const MAX_TEXT = 8_192;
/** First byte of a cast frame (see `encodeCastFrame`). */
const CAST_OP = 3;

/** How old a boss-room ticket may be. Its health is as of issue. */
const FRESH_TICKET_MS = 2 * 60_000;
/** Maps where sitting on a bench earns extra health: peaceful ones. */
const REST_MAPS: ReadonlySet<TownMapId> = new Set(["home"]);

/** Survives hibernation on the socket itself. */
type Attachment = {
  connectedAt: number;
  map: TownMapId;
  /** An instanced map's room: whose it is (a user id). */
  instance?: string;
  player?: {
    id: number;
    uid: string;
    name: string;
    look: TownLook;
    exp: number;
    state: TownState;
    maxHp?: number;
    /** Knocked out, outside a fight (from the ticket). */
    down?: boolean;
    /** Its Resurrect's level (0: it has none), and how much stronger its
     * heals are (its Euphony), for a resurrect outside a fight. */
    rez?: number;
    healMult?: number;
  };
};

type Session = {
  ws: WebSocket;
  att: Attachment;
  /** Absent until hello. */
  player?: NonNullable<Attachment["player"]> & {
    guard: MoveGuard;
    /** When the newest state arrived, ms. */
    receivedAt: number;
    /** Max HP from the ticket, to size the bench bonus. */
    maxHp?: number;
    /** Seated time not yet reported. */
    rest: RestMeter;
  };
  limiter: RateLimiter;
  strikes: number;
  /** When this socket last said what it's listening to (server ms). */
  tunedAt?: number;
};

export class TownRoom extends DurableObject<Env> {
  private sessions = new Map<WebSocket, Session>();
  /** Players who moved since the last tick. */
  private dirty = new Set<Session>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private quietTicks = 0;
  /** The boss room's fight, once someone has arrived with a boss ticket. */
  private fight: FightRuntime | null = null;
  /** Resurrects being played outside a fight, by their Bard's user id. */
  private townChannels = new Map<string, TownChannel>();
  /** When each Bard's Resurrect is ready again outside a fight (server ms),
   * by user id. */
  private rezReady = new Map<string, number>();
  private reporting = false;
  private closeScheduled = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(TOWN_PING, TOWN_PONG),
    );
    const now = Date.now();
    for (const ws of ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) {
        ws.close(TOWN_CLOSE.auth, "no session");
        continue;
      }
      // A boss room that woke from eviction has lost its fight; its
      // players reconnect with fresh tickets and the fight resumes from them.
      if (TOWN_TICKETED_MAPS.has(att.map)) {
        ws.close(TOWN_CLOSE.auth, "room restarted");
        continue;
      }
      const session = this.session(ws, att, now);
      if (att.player) {
        session.player = {
          ...att.player,
          guard: newGuard(att.player.state.x, att.player.state.z, now),
          receivedAt: now,
          rest: new RestMeter(),
        };
      }
    }
  }

  private session(ws: WebSocket, att: Attachment, now: number): Session {
    const s: Session = {
      ws,
      att,
      limiter: new RateLimiter(RATE, BURST, now),
      strikes: 0,
    };
    this.sessions.set(ws, s);
    return s;
  }

  private get capacity(): number {
    return Number(this.env.ROOM_CAPACITY) || TOWN_ROOM_CAPACITY;
  }

  async fetch(request: Request): Promise<Response> {
    const map = request.headers.get("x-town-map") ?? "";
    if (!isTownMapId(map)) return new Response("unknown map", { status: 404 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    if (this.ctx.getWebSockets().length > this.capacity) {
      server.close(TOWN_CLOSE.full, "full");
      return new Response(null, { status: 101, webSocket: client });
    }
    const now = Date.now();
    const instance = request.headers.get("x-town-instance") ?? undefined;
    const att: Attachment = { connectedAt: now, map, instance };
    server.serializeAttachment(att);
    this.session(server, att, now);
    setTimeout(() => {
      const s = this.sessions.get(server);
      if (s && !s.player) this.drop(s, TOWN_CLOSE.auth, "no hello");
    }, HELLO_TIMEOUT_MS);
    await this.ensureSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const s = this.sessions.get(ws);
    if (!s) {
      ws.close(TOWN_CLOSE.auth, "no session");
      return;
    }
    const now = Date.now();
    if (!s.limiter.take(now)) {
      this.strike(s);
      return;
    }
    if (typeof message === "string") {
      if (message.length > MAX_TEXT) {
        this.drop(s, TOWN_CLOSE.kicked, "too long");
        return;
      }
      let m: {
        t?: unknown;
        v?: unknown;
        ticket?: unknown;
        at?: TownState;
        skill?: unknown;
        seq?: unknown;
        yaw?: unknown;
        pitch?: unknown;
        item?: unknown;
        on?: unknown;
      };
      try {
        m = JSON.parse(message);
      } catch {
        this.strike(s);
        return;
      }
      if (m?.t === "hello" && !s.player) await this.hello(s, m, now);
      else if (m?.t === "ticket" && s.player) await this.renew(s, m.ticket);
      else if (m?.t === "skill" && s.player) this.onSkill(s, m, now);
      else if (m?.t === "eat" && s.player) await this.onEat(s, m, now);
      else if (m?.t === "next" && s.player) this.onNext(s, now);
      else if (m?.t === "tune" && s.player) this.onTune(s, m.on, now);
      else if (m?.t === "forfeit" && s.player) this.onForfeit(s, now);
      else this.strike(s);
      return;
    }
    if (!s.player) {
      this.drop(s, TOWN_CLOSE.auth, "state before hello");
      return;
    }
    if (message.byteLength > 0 && new Uint8Array(message)[0] === CAST_OP) {
      this.onCast(s, message, now);
      return;
    }
    const frame = decodeStateFrame(message);
    if (!frame) {
      this.strike(s);
      return;
    }
    const p = s.player;
    // Knocked out in the cave: the body stays put (frames still on their
    // way from before the fall aren't held against the socket).
    if (this.fight?.frozen(p.uid)) return;
    const next = quantizeState(frame.state);
    if (!checkMove(p.guard, next.x, next.z, now, s.att.map)) {
      this.strike(s);
      this.send(s, { t: "correct", x: p.state.x, z: p.state.z });
      return;
    }
    const wasSeated = (p.state.flags & TOWN_FLAG_SITTING) !== 0;
    p.state = next;
    p.receivedAt = now;
    const seated = (next.flags & TOWN_FLAG_SITTING) !== 0;
    p.rest.tick(seated, now);
    // Stood up: report what resting earned now, so the app's health bar
    // (which counts the bench's speed itself) agrees when it looks.
    if (wasSeated && !seated) this.flushRest(now, s);
    this.fight?.onState(p.uid, next.x, next.z, now);
    this.dirty.add(s);
    this.startTicking();
  }

  private async hello(
    s: Session,
    m: { v?: unknown; ticket?: unknown; at?: TownState },
    now: number,
  ) {
    if (m.v !== TOWN_PROTOCOL) {
      this.drop(s, TOWN_CLOSE.outdated, "outdated");
      return;
    }
    const t = await this.verify(m.ticket);
    if (!t) {
      this.drop(s, TOWN_CLOSE.auth, "bad ticket");
      return;
    }
    if (!this.sessions.has(s.ws)) return; // closed while verifying

    // The boss room only takes tickets issued while the cave is open and
    // the herzie is on its feet.
    const ticketed = TOWN_TICKETED_MAPS.has(s.att.map);
    if (ticketed && !this.admit(s, t, now)) return;

    // The same herzie again (a reconnect, or a second copy of the app):
    // the new socket takes over the old one's place and id, so others see
    // it carry on rather than leave and come back.
    let id: number | undefined;
    for (const other of this.sessions.values()) {
      if (other !== s && other.player?.uid === t.uid) {
        id = other.player.id;
        this.sessions.delete(other.ws);
        this.dirty.delete(other);
        this.close(other.ws, TOWN_CLOSE.replaced, "replaced");
      }
    }
    const replacing = id !== undefined;
    id ??= this.freeId();

    const at = startingPoint(s.att.map, m.at?.x, m.at?.z);
    const state = quantizeState({
      x: at.x,
      z: at.z,
      heading: Number.isFinite(m.at?.heading) ? (m.at?.heading as number) : 0,
      speed: 0,
      flags: 0,
    });
    s.player = {
      id,
      uid: t.uid,
      name: t.name,
      look: t.look,
      exp: t.exp,
      state,
      guard: newGuard(state.x, state.z, now),
      receivedAt: now,
      maxHp: t.hp?.maxHp,
      rest: new RestMeter(),
      ...townVitalsOf(t, !!this.fight),
    };
    this.persist(s);
    const fp = this.fight?.join(t.uid, id, t, state, now);

    const others = [...this.sessions.values()].flatMap((o) =>
      o !== s && o.player ? [o.player] : [],
    );
    this.send(s, {
      t: "welcome",
      you: id,
      players: others.map(playerOf),
      fight: this.fight?.state(now, t.uid),
    });
    if (fp) {
      // Everyone else sees the newcomer's health bar.
      this.broadcast({ t: "hp", id, hp: fp.hp, maxHp: fp.maxHp }, s);
      if (fp.down) this.send(s, { t: "down" });
    }
    if (others.length) {
      s.ws.send(
        encodeSnapshot(
          now,
          others.map((p) => ({ id: p.id, age: 0, state: p.state })),
        ),
      );
    }
    const me = playerOf(s.player);
    this.broadcast(
      replacing ? { t: "look", player: me } : { t: "join", player: me },
      s,
    );
    this.dirty.add(s);
    this.startTicking();
    this.log(replacing ? "rejoin" : "join", s);
  }

  /** A fresh ticket: keeps the session alive and may change the look. */
  private async renew(s: Session, ticket: unknown) {
    const t = await this.verify(ticket);
    const p = s.player;
    if (!p || !this.sessions.has(s.ws)) return;
    if (!t || t.uid !== p.uid) {
      this.drop(s, TOWN_CLOSE.auth, "bad renewal");
      return;
    }
    const changed =
      t.name !== p.name || JSON.stringify(t.look) !== JSON.stringify(p.look);
    p.exp = t.exp;
    p.maxHp = t.hp?.maxHp;
    const wasDown = !!p.down;
    Object.assign(p, townVitalsOf(t, !!this.fight));
    const downChanged = wasDown !== !!p.down;
    for (const o of this.fight?.renew(p.uid, t) ?? []) this.dispatch(o);
    p.name = t.name;
    p.look = t.look;
    this.persist(s);
    if (changed || downChanged)
      this.broadcast({ t: "look", player: playerOf(p) });
  }

  private verify(ticket: unknown): Promise<TownTicketPayload | null> {
    if (typeof ticket !== "string") return Promise.resolve(null);
    return verifyTownTicket(ticket, this.env.TOWN_TICKET_SECRET);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const s = this.sessions.get(ws);
    if (s) this.leave(s, `closed ${code}`);
    this.close(ws, 1000, "bye");
  }

  async webSocketError(ws: WebSocket) {
    const s = this.sessions.get(ws);
    if (s) this.leave(s, "error");
  }

  /** Looks for sockets that went silent, never said hello, or let their
   * ticket lapse; and forgives old strikes. */
  async alarm() {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      s.strikes = 0;
      if (!s.player) {
        if (now - s.att.connectedAt > HELLO_TIMEOUT_MS)
          this.drop(s, TOWN_CLOSE.auth, "no hello");
        continue;
      }
      const pinged =
        this.ctx.getWebSocketAutoResponseTimestamp(s.ws)?.getTime() ?? 0;
      const seen = Math.max(pinged, s.player.receivedAt, s.att.connectedAt);
      if (now - seen > IDLE_TIMEOUT_MS) this.drop(s, TOWN_CLOSE.idle, "idle");
      else if (s.player.exp + TICKET_GRACE_S < now / 1000)
        this.drop(s, TOWN_CLOSE.auth, "ticket expired");
    }
    this.flushRest(now);
    const closes = this.fight?.closesAt;
    if (closes !== null && closes !== undefined && now >= closes) {
      this.closeRoom(now);
      return;
    }
    if (this.ctx.getWebSockets().length) {
      const next =
        closes && closes > now
          ? Math.min(now + SWEEP_MS, closes)
          : now + SWEEP_MS;
      await this.ctx.storage.setAlarm(next);
    }
  }

  /** Tell `town-vitals` how long each herzie sat on a bench, so resting
   * earns its extra health. Only in peaceful maps, and only while the
   * ticket says how much health the herzie has. */
  private flushRest(now: number, only?: Session) {
    const rest: { uid: string; bonus: number }[] = [];
    for (const s of only ? [only] : this.sessions.values()) {
      const p = s.player;
      if (!p) continue;
      p.rest.tick((p.state.flags & TOWN_FLAG_SITTING) !== 0, now);
      const seconds = p.rest.take();
      if (!p.maxHp || !REST_MAPS.has(s.att.map)) continue;
      const bonus = benchBonusHp(p.maxHp, seconds);
      if (bonus >= 0.5) rest.push({ uid: p.uid, bonus });
    }
    if (rest.length) void postVitals(this.env, { action: "report", rest });
  }

  private async ensureSweep() {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  private startTicking() {
    this.quietTicks = 0;
    this.ticker ??= setInterval(() => this.tick(), TOWN_TICK_MS);
  }

  private tick() {
    if (this.fight) this.runFight(Date.now());
    if (this.townChannels.size) this.stepTownChannels(Date.now());
    if (this.dirty.size === 0 && !this.fight && !this.townChannels.size) {
      if (++this.quietTicks >= IDLE_TICKS && this.ticker) {
        clearInterval(this.ticker);
        this.ticker = null;
      }
      return;
    }
    this.quietTicks = 0;
    const now = Date.now();
    if (this.dirty.size === 0) return;
    const entries: SnapshotEntry[] = [];
    for (const s of this.dirty) {
      if (!s.player) continue;
      entries.push({
        id: s.player.id,
        age: now - s.player.receivedAt,
        state: s.player.state,
      });
      this.persist(s);
    }
    this.dirty.clear();
    if (!entries.length) return;
    const frame = encodeSnapshot(now, entries);
    for (const s of this.sessions.values()) {
      if (s.player) this.trySend(s.ws, frame);
    }
  }

  private leave(s: Session, why: string) {
    this.sessions.delete(s.ws);
    this.dirty.delete(s);
    if (s.player) {
      this.flushRest(Date.now(), s);
      if (this.fight) {
        this.fight.leave(s.player.uid, Date.now());
        this.maybeReport(Date.now(), true);
        if (![...this.sessions.values()].some((o) => o.player) && this.ticker) {
          clearInterval(this.ticker);
          this.ticker = null;
        }
      }
      this.broadcast({ t: "leave", id: s.player.id });
      this.log("leave", s, why);
    }
  }

  private drop(s: Session, code: number, reason: string) {
    this.leave(s, reason);
    this.close(s.ws, code, reason);
  }

  private strike(s: Session) {
    if (++s.strikes > MAX_STRIKES) this.drop(s, TOWN_CLOSE.kicked, "abuse");
  }

  private freeId(): number {
    const used = new Set<number>();
    for (const s of this.sessions.values()) if (s.player) used.add(s.player.id);
    let id = 1;
    while (used.has(id)) id++;
    return id;
  }

  /** Whether the boss room lets this ticket in. Starts the fight from the
   * ticket's boss claim if none is running. In the lobby anyone on their
   * feet comes in; once the roster locks, only those in it (down or not). */
  private admit(s: Session, t: TownTicketPayload, now: number): boolean {
    if (s.att.map === "tower") return this.admitTower(s, t, now);
    let claim: BossClaim | undefined = t.boss;
    if (!claim && this.env.DEV_BOSS) {
      const lobby = Number(this.env.DEV_BOSS_LOBBY_S ?? 20);
      claim = {
        event: DEV_EVENT,
        until: now / 1000 + 3_600,
        hp: 20_000,
        maxHp: 20_000,
        starts: now / 1000 + (Number.isFinite(lobby) ? lobby : 20),
        hpPerPlayer: 10_000,
      };
    }
    if (!claim || claim.until * 1000 <= now) {
      this.drop(s, TOWN_CLOSE.sealed, "sealed");
      return false;
    }
    // The ticket carries health as of when it was issued: for the boss room
    // that has to be recent, or a ticket from before a hit could heal you.
    const issued = (t.exp - TOWN_TICKET_TTL_S) * 1000;
    if (now - issued > FRESH_TICKET_MS) {
      this.drop(s, TOWN_CLOSE.auth, "stale ticket");
      return false;
    }
    const down = !!t.hp?.down || (!!t.hp && t.hp.hp <= 0);
    // A new boss after the last one's fight is over (or abandoned): start
    // fresh rather than turn it away.
    const old = this.fight;
    if (
      old &&
      claim.event !== old.eventId &&
      (!old.open || ![...this.sessions.values()].some((o) => o.player))
    ) {
      this.fight = null;
      this.closeScheduled = false;
    }
    if (!this.fight) {
      // A downed herzie may only start the room back up for a locked fight
      // it's in (a room that restarted while it waited for a Bard).
      if (down && !claim.locked?.roster.includes(t.uid)) {
        this.drop(s, TOWN_CLOSE.sealed, "down");
        return false;
      }
      this.fight = new FightRuntime(claim, now);
      if (!this.env.TOWN_VITALS_URL && claim.event !== DEV_EVENT) {
        // The fight will look fine and save nothing: say so, loudly.
        console.error(
          JSON.stringify({
            event: "misconfigured",
            detail: "TOWN_VITALS_URL is not set: this fight will not be saved",
            boss: claim.event,
          }),
        );
      }
    }
    if (claim.event !== this.fight.eventId) {
      // Another boss's: this room is done.
      this.drop(s, TOWN_CLOSE.closed, "closed");
      return false;
    }
    const verdict = this.fight.mayJoin(t.uid, down, now);
    if (verdict === "ok") return true;
    if (verdict === "closed") this.drop(s, TOWN_CLOSE.closed, "closed");
    else this.drop(s, TOWN_CLOSE.sealed, verdict);
    return false;
  }

  /** Whether this Tower room lets the ticket in: it's this herzie's own
   * room, a Tower event is on, and they're on their feet. Starts their
   * floor from the ticket's claim if none is running. */
  private admitTower(s: Session, t: TownTicketPayload, now: number): boolean {
    if (!TOWN_INSTANCED_MAPS.has(s.att.map) || s.att.instance !== t.uid) {
      this.drop(s, TOWN_CLOSE.sealed, "not your room");
      return false;
    }
    let claim = t.tower;
    if (!claim && this.env.DEV_BOSS)
      claim = { event: DEV_EVENT, until: now / 1000 + 3_600, floor: 1 };
    if (!claim || claim.until * 1000 <= now) {
      this.drop(s, TOWN_CLOSE.sealed, "sealed");
      return false;
    }
    const issued = (t.exp - TOWN_TICKET_TTL_S) * 1000;
    if (now - issued > FRESH_TICKET_MS) {
      this.drop(s, TOWN_CLOSE.auth, "stale ticket");
      return false;
    }
    if (t.hp?.down || (t.hp && t.hp.hp <= 0)) {
      this.drop(s, TOWN_CLOSE.sealed, "down");
      return false;
    }
    // Another event's Tower, or one that ended: start over.
    if (
      this.fight &&
      (claim.event !== this.fight.eventId || !this.fight.open)
    ) {
      this.fight = null;
      this.closeScheduled = false;
    }
    if (!this.fight) {
      const { radius, spawn } = TOWN_MAPS.tower;
      this.fight = FightRuntime.tower(
        claim,
        t.uid,
        t.lv ?? 1,
        { radius, entry: spawn },
        now,
      );
    }
    return true;
  }

  /** On to the next Tower floor (the client walked through the far
   * portal); the herzie starts it back at the spawn. */
  private onNext(s: Session, now: number) {
    const p = s.player;
    if (!p || !this.fight?.tower) {
      this.strike(s);
      return;
    }
    // The move back to the start needs nothing here: a jump onto the map's
    // spawn is always allowed (checkMove), and the frames still on their
    // way from the far portal must pass too.
    for (const o of this.fight.next(p.uid, now)) this.dispatch(o);
  }

  private onCast(s: Session, message: ArrayBuffer, now: number) {
    const cast = decodeCastFrame(message);
    const p = s.player;
    if (!cast || !p || !this.fight) {
      this.strike(s);
      return;
    }
    const result = this.fight.cast(p.uid, cast.yaw, cast.pitch, now);
    if (result === "cooldown") this.strike(s);
  }

  /** A class skill. Only the boss room runs them; anywhere else they're
   * the client's own practice (no effect, no XP), so they're dropped
   * without a strike. */
  private onSkill(
    s: Session,
    m: { skill?: unknown; seq?: unknown; yaw?: unknown; pitch?: unknown },
    now: number,
  ) {
    const p = s.player;
    if (!p) return;
    const yaw = Number(m.yaw);
    const pitch = Number(m.pitch);
    const seq = Number(m.seq);
    if (
      typeof m.skill !== "string" ||
      !Number.isFinite(yaw) ||
      !Number.isFinite(pitch) ||
      !Number.isInteger(seq)
    ) {
      this.strike(s);
      return;
    }
    if (!this.fight) {
      this.townSkill(s, m.skill, seq, yaw, now);
      return;
    }
    const { result, readyAt, reason, out } = this.fight.skill(
      p.uid,
      m.skill,
      yaw,
      pitch,
      now,
    );
    for (const o of out) this.dispatch(o);
    if (result === "used" || result === "ignored") return;
    // Refused: say when it's ready (and why, if it's something the player
    // can act on), so the client puts its cooldown right.
    this.send(s, {
      t: "skillDenied",
      skill: m.skill,
      seq,
      readyAt,
      ...(reason ? { reason } : {}),
    });
    if (result === "cooldown" || result === "unknown") this.strike(s);
  }

  /** A skill outside a fight: only a Bard's Resurrect does anything here
   * (the rest need a fight to act on), on the nearest herzie that's down
   * within its reach. It's played for its channel, then the database brings
   * the herzie back; moving away cancels it, and costs no cooldown. */
  private townSkill(
    s: Session,
    skill: string,
    seq: number,
    yaw: number,
    now: number,
  ) {
    const p = s.player;
    if (!p || skill !== "resurrect" || !p.rez) return;
    if (this.townChannels.has(p.uid)) return;
    const def = SKILL_DEFS.resurrect;
    const ready = this.rezReady.get(p.uid) ?? 0;
    if (now < ready) {
      this.send(s, { t: "skillDenied", skill, seq, readyAt: ready });
      return;
    }
    let target: Session | null = null;
    let best = def.radius ?? 0;
    for (const o of this.sessions.values()) {
      if (o === s || !o.player?.down) continue;
      const d = Math.hypot(
        o.player.state.x - p.state.x,
        o.player.state.z - p.state.z,
      );
      if (d <= best) {
        best = d;
        target = o;
      }
    }
    if (!target?.player) {
      this.send(s, {
        t: "skillDenied",
        skill,
        seq,
        readyAt: 0,
        reason: "no-target",
      });
      return;
    }
    const until = now + (def.channelMs ?? 0);
    this.townChannels.set(p.uid, {
      by: s.ws,
      target: target.ws,
      until,
      x: p.state.x,
      z: p.state.z,
      level: p.rez,
    });
    this.broadcast({
      t: "skill",
      by: p.id,
      skill,
      level: p.rez,
      x: p.state.x,
      z: p.state.z,
      yaw,
    });
    this.broadcast({ t: "channel", by: p.id, target: target.player.id, until });
    this.startTicking();
  }

  /** Resurrects outside a fight: cancelled if the Bard moved or either of
   * them left (or the herzie got up by itself); landed once played. */
  private stepTownChannels(now: number) {
    for (const [uid, c] of this.townChannels) {
      const bard = this.sessions.get(c.by)?.player;
      const target = this.sessions.get(c.target)?.player;
      const ok =
        !!bard &&
        !!target?.down &&
        Math.hypot(bard.state.x - c.x, bard.state.z - c.z) <= CHANNEL_SLACK;
      if (!ok) {
        this.townChannels.delete(uid);
        if (bard)
          this.broadcast({ t: "channel", by: bard.id, target: null, until: 0 });
        continue;
      }
      if (now < c.until) continue;
      this.townChannels.delete(uid);
      void this.townRevive(c, bard, target, now);
    }
  }

  /** A resurrect outside a fight landed: the database brings the herzie
   * back (it alone knows its health here), then everyone sees it stand. */
  private async townRevive(
    c: TownChannel,
    bard: NonNullable<Session["player"]>,
    target: NonNullable<Session["player"]>,
    now: number,
  ) {
    const maxHp = target.maxHp ?? 0;
    const share = skillValue("resurrect", c.level) * (bard.healMult ?? 1);
    const hp = Math.max(1, Math.min(maxHp, Math.round(maxHp * share)));
    const ok = await reviveInDb(this.env, target.uid, hp);
    if (!ok || !this.sessions.has(c.target)) {
      if (this.sessions.has(c.by))
        this.broadcast({ t: "channel", by: bard.id, target: null, until: 0 });
      return;
    }
    this.rezReady.set(bard.uid, now + SKILL_DEFS.resurrect.cooldownMs);
    target.down = false;
    const ts = this.sessions.get(c.target);
    if (ts) {
      this.persist(ts);
      this.log("revive", ts, bard.uid);
    }
    this.broadcast({ t: "revived", id: target.id, by: bard.id });
    this.broadcast({ t: "hp", id: target.id, hp, maxHp });
    this.broadcast({ t: "look", player: playerOf(target) });
  }

  /** Whether a fighter is playing music, for the in-tune bonus. Only the
   * boss room cares; elsewhere it's dropped. Faster than a person presses
   * play and pause is a strike. */
  private onTune(s: Session, on: unknown, now: number) {
    const p = s.player;
    if (!p || !this.fight?.boss) return;
    const playing = parseTune(on);
    if (playing === null) {
      this.strike(s);
      return;
    }
    if (s.tunedAt !== undefined && now - s.tunedAt < TUNE_MIN_INTERVAL_MS) {
      this.strike(s);
      return;
    }
    s.tunedAt = now;
    this.fight.tune(p.uid, playing, now);
  }

  /** Knocked out in a raid, and giving up. */
  private onForfeit(s: Session, now: number) {
    const p = s.player;
    if (!p || !this.fight?.boss) return;
    for (const o of this.fight.forfeit(p.uid, now)) this.dispatch(o);
    this.maybeReport(now, true);
  }

  /** A consumable eaten in a fight, where this room holds HP: the database
   * uses up the copy, then the fight heals. Anywhere else the client eats
   * through the API, so an `eat` here is just told no. */
  private async onEat(
    s: Session,
    m: { item?: unknown; seq?: unknown },
    now: number,
  ) {
    const p = s.player;
    const seq = Number(m.seq);
    if (!p || typeof m.item !== "string" || !Number.isInteger(seq)) {
      this.strike(s);
      return;
    }
    const item = m.item;
    const refuse = (reason: EatRefusal) =>
      this.send(s, { t: "ate", seq, item, ok: false, reason });
    const fight = this.fight;
    if (!fight) return refuse("not-here");
    const no = fight.tryEat(p.uid, now);
    if (no) {
      if (no === "cooldown") this.strike(s);
      return refuse(no);
    }
    const reply = await eatInDb(this.env, p.uid, item);
    if (!reply?.ok) {
      const reason = reply?.reason;
      return refuse(
        reason === "none-left" || reason === "not-consumable"
          ? reason
          : "failed",
      );
    }
    // The fight (or the herzie in it) may be gone after the await.
    for (const o of this.fight?.eat(p.uid, reply.heal) ?? []) this.dispatch(o);
    this.send(s, { t: "ate", seq, item, ok: true, heal: reply.heal });
  }

  /** Step the fight and tell everyone what happened. */
  private runFight(now: number) {
    const fight = this.fight;
    if (!fight) return;
    const out = fight.step(now);
    for (const o of out) this.dispatch(o);
    if (fight.closesAt !== null && !this.closeScheduled) {
      this.closeScheduled = true;
      void this.ctx.storage.setAlarm(fight.closesAt);
      console.log(
        JSON.stringify({
          event: "fight-over",
          why: fight.closeWhy,
          boss: fight.eventId,
        }),
      );
    }
    this.maybeReport(now);
  }

  private dispatch(o: Outbound) {
    if (o.to === "all") {
      this.broadcast(o.msg);
      return;
    }
    const uid = o.to.uid;
    for (const s of this.sessions.values())
      if (s.player?.uid === uid) this.send(s, o.msg);
  }

  /** Send the fight's health and boss damage to `town-vitals`, one request
   * at a time; a failed one is retried by the next report unchanged. */
  private maybeReport(now: number, force = false) {
    const fight = this.fight;
    if (!fight || this.reporting) return;
    const report = fight.report(now, force);
    if (!report) return;
    if (
      !report.hp.length &&
      !report.boss &&
      !report.skills &&
      !report.results &&
      !report.tower &&
      !report.lock &&
      !report.revived &&
      !report.out &&
      !report.wipe
    )
      return;
    this.reporting = true;
    void postVitals(this.env, { action: "report", ...report })
      .then((reply) => {
        if (!reply) return;
        for (const o of fight.reported(report, reply.raid)) this.dispatch(o);
        const loot = reply.boss?.loot;
        if (loot) for (const o of fight.loot(loot)) this.dispatch(o);
        const levels = reply.skills?.levels;
        if (levels) for (const o of fight.skillUps(levels)) this.dispatch(o);
        if (report.results && reply.results)
          for (const o of fight.results(reply.results)) this.dispatch(o);
        if (report.tower && reply.tower?.drops)
          for (const o of fight.towerLoot(reply.tower.drops, report.tower))
            this.dispatch(o);
      })
      .finally(() => {
        this.reporting = false;
      });
  }

  /** Shut the room: the fight ended. Everyone goes back to town. */
  private closeRoom(now: number) {
    this.maybeReport(now, true);
    for (const s of [...this.sessions.values()]) {
      this.leave(s, "room closed");
      this.close(s.ws, TOWN_CLOSE.closed, "closed");
    }
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    // Done with this fight (its last report is on its way); the next boss
    // gets a fresh room.
    this.fight = null;
    this.closeScheduled = false;
  }

  private persist(s: Session) {
    const p = s.player;
    if (p) {
      s.att.player = {
        id: p.id,
        uid: p.uid,
        name: p.name,
        look: p.look,
        exp: p.exp,
        state: p.state,
        maxHp: p.maxHp,
      };
    }
    try {
      s.ws.serializeAttachment(s.att);
    } catch {
      // Socket already closed.
    }
  }

  private send(s: Session, m: ServerMessage) {
    this.trySend(s.ws, JSON.stringify(m));
  }

  private broadcast(m: ServerMessage, except?: Session) {
    const text = JSON.stringify(m);
    for (const s of this.sessions.values())
      if (s !== except && s.player) this.trySend(s.ws, text);
  }

  private trySend(ws: WebSocket, data: string | ArrayBuffer) {
    try {
      ws.send(data);
    } catch {
      // Closing; webSocketClose will clean up.
    }
  }

  private close(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private log(event: string, s: Session, detail?: string) {
    console.log(
      JSON.stringify({
        event,
        map: s.att.map,
        id: s.player?.id,
        uid: s.player?.uid,
        detail,
        players: [...this.sessions.values()].filter((o) => o.player).length,
      }),
    );
  }
}

function playerOf(p: {
  id: number;
  name: string;
  look: TownLook;
  down?: boolean;
}): TownPlayer {
  return {
    id: p.id,
    name: p.name,
    look: p.look,
    ...(p.down ? { down: true as const } : {}),
  };
}

/** A resurrect being played outside a fight. */
type TownChannel = {
  /** The Bard's socket and the herzie it's bringing back. */
  by: WebSocket;
  target: WebSocket;
  until: number;
  /** Where the Bard stood when it began (moving away cancels it). */
  x: number;
  z: number;
  level: number;
};

/** What a ticket says matters for a resurrect outside a fight: whether the
 * herzie is down (in a fight, the fight keeps that), its Resurrect's
 * level and its heals' strength. */
function townVitalsOf(
  t: TownTicketPayload,
  inFight: boolean,
): { down: boolean; rez: number; healMult: number } {
  const rez = t.sk?.find(([id]) => id === "resurrect")?.[1] ?? 0;
  return {
    down: !inFight && !!t.hp?.down,
    rez: Number.isFinite(rez) ? Math.max(0, rez) : 0,
    healMult: healMult(t.st?.[6] ?? 0),
  };
}
