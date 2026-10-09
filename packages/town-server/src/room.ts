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
import {
  decodeStateFrame,
  encodeSnapshot,
  isTownMapId,
  quantizeState,
  type ServerMessage,
  type SnapshotEntry,
  TOWN_CLOSE,
  TOWN_PING,
  TOWN_PONG,
  TOWN_PROTOCOL,
  TOWN_ROOM_CAPACITY,
  TOWN_TICK_MS,
  type TownLook,
  type TownMapId,
  type TownPlayer,
  type TownState,
  type TownTicketPayload,
  verifyTownTicket,
} from "@herzies/shared/town-net";
import {
  checkMove,
  type MoveGuard,
  newGuard,
  RateLimiter,
  startingPoint,
} from "./rules";

export type Env = {
  TOWN_ROOM: DurableObjectNamespace<TownRoom>;
  TOWN_TICKET_SECRET: string;
  /** Overrides {@link TOWN_ROOM_CAPACITY} (tests). */
  ROOM_CAPACITY?: string;
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

/** Survives hibernation on the socket itself. */
type Attachment = {
  connectedAt: number;
  map: TownMapId;
  player?: {
    id: number;
    uid: string;
    name: string;
    look: TownLook;
    exp: number;
    state: TownState;
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
  };
  limiter: RateLimiter;
  strikes: number;
};

export class TownRoom extends DurableObject<Env> {
  private sessions = new Map<WebSocket, Session>();
  /** Players who moved since the last tick. */
  private dirty = new Set<Session>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private quietTicks = 0;

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
      const session = this.session(ws, att, now);
      if (att.player) {
        session.player = {
          ...att.player,
          guard: newGuard(att.player.state.x, att.player.state.z, now),
          receivedAt: now,
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
    const att: Attachment = { connectedAt: now, map };
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
      let m: { t?: unknown; v?: unknown; ticket?: unknown; at?: TownState };
      try {
        m = JSON.parse(message);
      } catch {
        this.strike(s);
        return;
      }
      if (m?.t === "hello" && !s.player) await this.hello(s, m, now);
      else if (m?.t === "ticket" && s.player) await this.renew(s, m.ticket);
      else this.strike(s);
      return;
    }
    if (!s.player) {
      this.drop(s, TOWN_CLOSE.auth, "state before hello");
      return;
    }
    const frame = decodeStateFrame(message);
    if (!frame) {
      this.strike(s);
      return;
    }
    const p = s.player;
    const next = quantizeState(frame.state);
    if (!checkMove(p.guard, next.x, next.z, now, s.att.map)) {
      this.strike(s);
      this.send(s, { t: "correct", x: p.state.x, z: p.state.z });
      return;
    }
    p.state = next;
    p.receivedAt = now;
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
    };
    this.persist(s);

    const others = [...this.sessions.values()].flatMap((o) =>
      o !== s && o.player ? [o.player] : [],
    );
    this.send(s, { t: "welcome", you: id, players: others.map(playerOf) });
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
    p.name = t.name;
    p.look = t.look;
    this.persist(s);
    if (changed) this.broadcast({ t: "look", player: playerOf(p) });
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
    if (this.ctx.getWebSockets().length)
      await this.ctx.storage.setAlarm(now + SWEEP_MS);
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
    if (this.dirty.size === 0) {
      if (++this.quietTicks >= IDLE_TICKS && this.ticker) {
        clearInterval(this.ticker);
        this.ticker = null;
      }
      return;
    }
    this.quietTicks = 0;
    const now = Date.now();
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

function playerOf(p: { id: number; name: string; look: TownLook }): TownPlayer {
  return { id: p.id, name: p.name, look: p.look };
}
