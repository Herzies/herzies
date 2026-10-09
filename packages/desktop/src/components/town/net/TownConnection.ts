import {
  decodeSnapshot,
  EntityBuffer,
  encodeStateFrame,
  parseServerMessage,
  quantizeState,
  ServerClock,
  TOWN_CLOSE,
  TOWN_MAX_SHARDS,
  TOWN_PING,
  TOWN_PONG,
  TOWN_PROTOCOL,
  TOWN_TICK_MS,
  type TownLook,
  type TownMapId,
  type TownPlayer,
  type TownState,
} from "@herzies/shared";

/** A signed pass from the `town-ticket` edge function. */
export type TownTicket = { ticket: string; url: string; exp: number };

export type TownNetStatus =
  /** Not wanted right now (the Town isn't open). */
  | "idle"
  | "connecting"
  | "online"
  /** Lost the connection; retrying. */
  | "offline"
  /** Switched off server-side; checks again now and then. */
  | "off"
  /** The server speaks a newer protocol: the app needs updating. */
  | "outdated"
  /** This herzie joined from somewhere else (another copy of the app). */
  | "replaced";

/** Another player, as drawn. */
export type RemotePlayer = {
  id: number;
  name: string;
  look: TownLook;
  buffer: EntityBuffer;
};

export type TownConnectionOptions = {
  map: TownMapId;
  getTicket: () => Promise<TownTicket>;
  /** Where the player's herzie is now. */
  readState: () => TownState;
  /** The server refused a move: put the herzie back here. */
  onCorrect?: (x: number, z: number) => void;
};

/** How often to ping; the server drops sockets silent for 45 s. */
const PING_MS = 10_000;
/** Silence after which the connection counts as dead. */
const DEAD_MS = 25_000;
/** Renew the ticket this long before it runs out. */
const RENEW_EARLY_S = 120;
/** Reconnect backoff: 1 s doubling to 30 s, randomised ("full jitter") so a
 * server restart isn't met by everyone at once. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** After being kicked, wait at least this long. */
const KICKED_MIN_MS = 10_000;
/** With multiplayer switched off, look again this often. */
const OFF_RETRY_MS = 5 * 60_000;
/** Heading change worth sending, radians. */
const HEADING_EPSILON = 0.02;

/**
 * The multiplayer Town's connection: keeps a socket to the town server while
 * wanted, reports where the player's herzie is, and keeps every other
 * player's recent states for drawing.
 *
 * Framework-free. React subscribes via {@link subscribe}, which fires when
 * the status or the roster changes. Movement doesn't notify anyone: the
 * frame loop reads the buffers directly.
 */
export class TownConnection {
  status: TownNetStatus = "idle";
  /** Other players, by entity id. */
  readonly remotes = new Map<number, RemotePlayer>();
  readonly clock = new ServerClock();
  /** Our own entity id on the server. */
  you: number | null = null;
  /** Bumped on every status or roster change (for useSyncExternalStore). */
  version = 0;

  private ws: WebSocket | null = null;
  private wanted = false;
  private shard = 0;
  private attempt = 0;
  private ticket: TownTicket | null = null;
  private seq = 0;
  private lastSent: TownState | null = null;
  private lastHeard = 0;
  private afk = false;
  private sendLoop: ReturnType<typeof setInterval> | null = null;
  private pingLoop: ReturnType<typeof setInterval> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  constructor(private opts: TownConnectionOptions) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private setStatus(s: TownNetStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit();
  }

  /** Connect (if not already) and stay connected until {@link stop}. */
  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.shard = 0;
    this.attempt = 0;
    // Coming back to the Town after being replaced takes the herzie back.
    if (this.status === "outdated") return;
    this.connect();
  }

  /** Leave the Town. */
  stop() {
    this.wanted = false;
    this.clearRetry();
    this.teardown(1000, "bye");
    if (this.status !== "outdated") this.setStatus("idle");
  }

  /** Shown dimmed to others ("away"). Sent at once. */
  setAfk(afk: boolean) {
    if (this.afk === afk) return;
    this.afk = afk;
    this.sendState(true);
  }

  /** Fetch a fresh ticket now, so others see a new outfit or name. */
  async refreshLook() {
    if (!this.ws || this.status !== "online") return;
    try {
      this.ticket = await this.opts.getTicket();
      this.sendJson({ t: "ticket", ticket: this.ticket.ticket });
      this.scheduleRenew();
    } catch {
      // The next renewal will catch up.
    }
  }

  // --- Connecting -----------------------------------------------------------

  private async connect() {
    if (!this.wanted || this.ws) return;
    this.clearRetry();
    this.setStatus(this.status === "online" ? "offline" : "connecting");
    let ticket: TownTicket;
    try {
      ticket = await this.freshTicket();
    } catch (e) {
      if (!this.wanted) return;
      if (String(e).includes("off")) {
        this.setStatus("off");
        this.retry(OFF_RETRY_MS);
      } else {
        this.setStatus("offline");
        this.retry(this.backoff());
      }
      return;
    }
    if (!this.wanted || this.ws) return;

    const url = `${socketBase(ticket.url)}/v1/town/${this.opts.map}?shard=${this.shard}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.retry(this.backoff());
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastHeard = performance.now();
      this.sendJson({
        t: "hello",
        v: TOWN_PROTOCOL,
        ticket: ticket.ticket,
        at: this.currentState(),
      });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastHeard = performance.now();
      if (typeof e.data === "string") this.onText(e.data);
      else this.onBinary(e.data as ArrayBuffer);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.onClosed(e.code);
    };
  }

  private async freshTicket(): Promise<TownTicket> {
    const t = this.ticket;
    if (t && t.exp - Date.now() / 1000 > RENEW_EARLY_S) return t;
    this.ticket = await this.opts.getTicket();
    return this.ticket;
  }

  private onClosed(code: number) {
    const wasOnline = this.status === "online";
    this.teardown();
    if (!this.wanted) return;
    switch (code) {
      case TOWN_CLOSE.outdated:
        this.setStatus("outdated");
        return;
      case TOWN_CLOSE.replaced:
        this.wanted = false;
        this.setStatus("replaced");
        return;
      case TOWN_CLOSE.full:
        // Spill into the next shard straight away.
        this.shard = (this.shard + 1) % TOWN_MAX_SHARDS;
        this.retry(0);
        return;
      case TOWN_CLOSE.auth:
        this.ticket = null;
        break;
      case TOWN_CLOSE.kicked:
        this.setStatus("offline");
        this.retry(Math.max(KICKED_MIN_MS, this.backoff()));
        return;
    }
    this.setStatus("offline");
    // A connection that was working gets one quick retry first.
    this.retry(wasOnline && this.attempt === 0 ? 250 : this.backoff());
  }

  private backoff(): number {
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    this.attempt++;
    return Math.max(250, Math.random() * cap);
  }

  private retry(ms: number) {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, ms);
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Drop the socket and everything tied to it. */
  private teardown(code?: number, reason?: string) {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      if (code !== undefined && ws.readyState <= WebSocket.OPEN) {
        try {
          ws.close(code, reason);
        } catch {
          // Already closing.
        }
      }
    }
    if (this.sendLoop) clearInterval(this.sendLoop);
    if (this.pingLoop) clearInterval(this.pingLoop);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.sendLoop = this.pingLoop = this.renewTimer = null;
    this.you = null;
    this.lastSent = null;
    this.clock.reset();
    if (this.remotes.size) {
      this.remotes.clear();
      this.emit();
    }
  }

  // --- Messages -------------------------------------------------------------

  private onText(text: string) {
    if (text === TOWN_PONG) return;
    const m = parseServerMessage(text);
    if (!m) return;
    switch (m.t) {
      case "welcome":
        this.you = m.you;
        this.attempt = 0;
        this.remotes.clear();
        for (const p of m.players) this.addRemote(p);
        this.setStatus("online");
        this.emit();
        this.startLoops();
        return;
      case "join":
        this.addRemote(m.player);
        this.emit();
        return;
      case "look": {
        const r = this.remotes.get(m.player.id);
        if (r) {
          r.name = m.player.name;
          r.look = m.player.look;
        } else if (m.player.id !== this.you) this.addRemote(m.player);
        this.emit();
        return;
      }
      case "leave":
        if (this.remotes.delete(m.id)) this.emit();
        return;
      case "correct":
        this.lastSent = null;
        this.opts.onCorrect?.(m.x, m.z);
        return;
    }
  }

  private addRemote(p: TownPlayer) {
    if (p.id === this.you) return;
    const existing = this.remotes.get(p.id);
    this.remotes.set(p.id, {
      id: p.id,
      name: p.name,
      look: p.look,
      buffer: existing?.buffer ?? new EntityBuffer(),
    });
  }

  private onBinary(data: ArrayBuffer) {
    const snap = decodeSnapshot(data);
    if (!snap) return;
    const now = performance.now();
    this.clock.observe(snap.serverTime, now);
    for (const e of snap.entries) {
      if (e.id === this.you) continue;
      this.remotes.get(e.id)?.buffer.push(snap.serverTime - e.age, e.state);
    }
  }

  // --- Sending --------------------------------------------------------------

  private startLoops() {
    this.sendLoop ??= setInterval(() => this.sendState(), TOWN_TICK_MS);
    this.pingLoop ??= setInterval(() => {
      if (performance.now() - this.lastHeard > DEAD_MS) {
        // Half-open socket (sleep, network change): start over.
        this.onClosed(1006);
        return;
      }
      this.sendRaw(TOWN_PING);
    }, PING_MS);
    this.scheduleRenew();
  }

  private scheduleRenew() {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    const exp = this.ticket?.exp ?? 0;
    const ms = Math.max(5_000, (exp - RENEW_EARLY_S) * 1000 - Date.now());
    this.renewTimer = setTimeout(async () => {
      this.renewTimer = null;
      try {
        this.ticket = await this.opts.getTicket();
        this.sendJson({ t: "ticket", ticket: this.ticket.ticket });
        this.scheduleRenew();
      } catch {
        // Try again shortly; the server allows a grace period.
        this.renewTimer = setTimeout(() => this.scheduleRenew(), 15_000);
      }
    }, ms);
  }

  private currentState(): TownState {
    const s = this.opts.readState();
    return quantizeState({ ...s, flags: this.afk ? 1 : 0 });
  }

  /** Sends where the herzie is, if it changed (or `force`). */
  private sendState(force = false) {
    if (this.status !== "online") return;
    const s = this.currentState();
    const last = this.lastSent;
    if (
      !force &&
      last &&
      last.x === s.x &&
      last.z === s.z &&
      last.speed === s.speed &&
      last.flags === s.flags &&
      Math.abs(s.heading - last.heading) < HEADING_EPSILON
    )
      return;
    this.lastSent = s;
    this.seq = (this.seq + 1) & 0xffff;
    this.sendRaw(encodeStateFrame(this.seq, s));
  }

  private sendJson(m: unknown) {
    this.sendRaw(JSON.stringify(m));
  }

  private sendRaw(data: string | ArrayBuffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(data);
    } catch {
      // onclose will follow.
    }
  }
}

/** The town server's address as a WebSocket URL: tolerates a bare host or
 * an http(s) URL in the server's config. */
export function socketBase(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (/^wss?:\/\//i.test(u)) return u;
  if (/^https:\/\//i.test(u)) return `wss://${u.slice(8)}`;
  if (/^http:\/\//i.test(u)) return `ws://${u.slice(7)}`;
  return `wss://${u}`;
}
