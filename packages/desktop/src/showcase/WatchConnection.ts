import {
  decodeSnapshot,
  EntityBuffer,
  parseServerMessage,
  ServerClock,
  TOWN_PING,
  TOWN_PONG,
  type TownLook,
  type TownPlayer,
} from "@herzies/shared";

/** Someone in the Town, as the website sees them: no name, and a body the
 * server made up (see the Town server's standInSeed). */
export type Watched = {
  id: number;
  look: TownLook;
  buffer: EntityBuffer;
};

/** Clients ping every 10 s; the room drops a watcher silent for 45. */
const PING_MS = 10_000;
/** Nothing heard for this long (not even a pong): start over. */
const DEAD_MS = 30_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/**
 * A read-only seat in the home island's room (`?watch=1`): who's there,
 * and where they walk. Sends nothing but pings. Reconnects with backoff;
 * turned away for being full, it waits longer and tries again. Only
 * connected while the tab is in sight.
 */
export class WatchConnection {
  readonly clock = new ServerClock();
  readonly herzies = new Map<number, Watched>();
  version = 0;
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private pingLoop: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastHeard = 0;
  private stopped = false;

  constructor(private readonly url: string) {
    document.addEventListener("visibilitychange", this.onVisibility);
    if (!document.hidden) this.open();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close() {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.teardown();
  }

  /** A tab out of sight gives its seat up (there are only so many, and
   * nothing is drawn meanwhile); back in sight, it takes one again. */
  private onVisibility = () => {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown();
    if (!document.hidden) {
      this.attempt = 0;
      this.open();
    }
  };

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private open() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.lastHeard = performance.now();
      this.pingLoop = setInterval(() => {
        if (performance.now() - this.lastHeard > DEAD_MS) {
          this.teardown();
          this.retry();
          return;
        }
        try {
          ws.send(TOWN_PING);
        } catch {
          // Closing.
        }
      }, PING_MS);
    };
    ws.onmessage = (e) => {
      this.lastHeard = performance.now();
      if (typeof e.data === "string") this.onText(e.data);
      else this.onBinary(e.data as ArrayBuffer);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.teardown();
      this.retry();
    };
  }

  private teardown() {
    const ws = this.ws;
    this.ws = null;
    if (this.pingLoop) clearInterval(this.pingLoop);
    this.pingLoop = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
    this.clock.reset();
    if (this.herzies.size) {
      this.herzies.clear();
      this.emit();
    }
  }

  private retry() {
    // Hidden: it reconnects when the tab is back (see onVisibility).
    if (this.stopped || document.hidden) return;
    const wait = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.attempt++);
    this.retryTimer = setTimeout(
      () => this.open(),
      wait * (0.75 + Math.random() * 0.5),
    );
  }

  private add(p: TownPlayer) {
    const existing = this.herzies.get(p.id);
    this.herzies.set(p.id, {
      id: p.id,
      look: p.look,
      buffer: existing?.buffer ?? new EntityBuffer(),
    });
  }

  private onText(text: string) {
    if (text === TOWN_PONG) return;
    const m = parseServerMessage(text);
    if (!m) return;
    switch (m.t) {
      case "welcome":
        this.attempt = 0;
        this.herzies.clear();
        for (const p of m.players) this.add(p);
        this.emit();
        return;
      case "join":
      case "look":
        this.add(m.player);
        this.emit();
        return;
      case "leave":
        if (this.herzies.delete(m.id)) this.emit();
        return;
    }
  }

  private onBinary(data: ArrayBuffer) {
    const snap = decodeSnapshot(data);
    if (!snap) return;
    this.clock.observe(snap.serverTime, performance.now());
    for (const e of snap.entries) {
      this.herzies.get(e.id)?.buffer.push(snap.serverTime - e.age, e.state);
    }
  }
}
