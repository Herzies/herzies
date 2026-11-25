/**
 * The multiplayer Town's wire protocol, shared by the desktop client, the
 * town server (a Cloudflare Durable Object) and the `town-ticket` edge
 * function.
 *
 * Movement is the hot path and travels as small fixed-size binary frames;
 * everything else (joining, looks, errors) is JSON text. Each client predicts
 * its own herzie and reports where it is; the server checks the report,
 * batches everyone's changes into one snapshot per tick and sends it to the
 * whole room — one message per player per tick instead of one per pair.
 *
 * Kept free of React and the DOM: this file is bundled into the Worker and
 * vendored into the Deno edge functions.
 */
import type { CreatureParams } from "./creature-params.js";
import type { Equipped } from "./items.js";
import type { TowerBoon } from "./tower.js";
import type {
  WildsCacheHold,
  WildsCacheView,
  WildsGroundDrop,
  WildsHunt,
  WildsLootRefusal,
} from "./wilds-loot.js";

/** Bumped on any incompatible change; the server turns away other versions
 * with {@link TOWN_CLOSE.outdated} so old desktop betas say "update" instead of
 * misreading frames. */
export const TOWN_PROTOCOL = 6;
// 6: the sky ship to the Wilds (the `airship` map, a room for its deck) and
// free-for-all PvP on the Wilds. An app from before can't ride a ship or
// fight there.

/** Server snapshot rate. */
export const TOWN_TICK_HZ = 15;
export const TOWN_TICK_MS = 1000 / TOWN_TICK_HZ;
/** Players per room before newcomers spill into the next shard. */
export const TOWN_ROOM_CAPACITY = 40;
/** Shards a map may be split into. */
export const TOWN_MAX_SHARDS = 16;

/** The maps a client may ask for, with what the server needs to check
 * movement: the walkable radius and where a respawn puts you, and on the
 * islands with a Sky Dock its ship's gangplank — walked up from the pier's
 * end past the island's edge into the gangway (`from` foot, `to` top, its
 * walkable `half` width either side), which is the island's room's until
 * you're through. Must match the desktop's map files (checked by a desktop
 * test). */
export const TOWN_MAPS = {
  home: {
    radius: 40,
    spawn: { x: 13.5, z: 12 },
    gangplank: { from: [39.42, -3.78], to: [44.42, -4.26], half: 0.5 },
  },
  /** The boss's cave: a small dark room, one shared fight. */
  bossroom: { radius: 13, spawn: { x: 0, z: 10 } },
  /** The Tower (an event): its round stone hall inside, fought floor by
   * floor, alone. Its spawn is the west end of the open floor, a few
   * steps in from the doorway; each new floor puts you back there. */
  tower: { radius: 21, spawn: { x: -12.5, z: 0.5 } },
  /** The Wilds: a big wild island east of Town, reached by sky ship. */
  wilds: {
    radius: 83,
    spawn: { x: -66.5, z: 0.5 },
    gangplank: { from: [-82.6, 0.52], to: [-87.62, 0.55], half: 0.5 },
  },
  /** A sky ship's deck, in its own frame (its flight is the same for
   * everyone, from the clock: see wilds.ts). One room per ship: its shard
   * is the ship's index. */
  airship: { radius: 13, spawn: { x: 0, z: 0 } },
} as const;
export type TownMapId = keyof typeof TOWN_MAPS;
export function isTownMapId(id: string): id is TownMapId {
  return Object.hasOwn(TOWN_MAPS, id);
}

type Gangplank = {
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  readonly half: number;
};

/** Whether (x, z) is somewhere a herzie may stand on `map`, give or take
 * `slack`: inside its walkable radius, or on its Sky Dock's gangplank (a
 * ship's there only some of the time; the server doesn't keep the
 * timetable, and a stub of plank in the air is nowhere worth cheating to). */
export function inTownBounds(
  map: TownMapId,
  x: number,
  z: number,
  slack = 0,
): boolean {
  const def: { radius: number; gangplank?: Gangplank } = TOWN_MAPS[map];
  if (Math.hypot(x, z) <= def.radius + slack) return true;
  const g = def.gangplank;
  if (!g) return false;
  const [x0, z0] = g.from;
  const dx = g.to[0] - x0;
  const dz = g.to[1] - z0;
  const len = Math.hypot(dx, dz);
  const along = ((x - x0) * dx + (z - z0) * dz) / len;
  const across = ((x - x0) * dz - (z - z0) * dx) / len;
  return (
    along >= -slack &&
    along <= len + slack &&
    Math.abs(across) <= g.half + slack
  );
}
/** Maps where sitting on a bench earns extra health: the peaceful ones
 * with benches. The app counts it as you sit; the Town server credits it. */
export const TOWN_REST_MAPS: ReadonlySet<TownMapId> = new Set([
  "home",
  "wilds",
  "airship",
]);

/** Maps that are one room however many come: the boss is shared, so there is
 * a single shard (and the room's capacity is the fight's). */
export const TOWN_SINGLE_SHARD: ReadonlySet<TownMapId> = new Set(["bossroom"]);

/** Maps the website may watch (`?watch=1`): read-only sockets that see
 * herzies walk about, but no names, and bodies the server makes up (a
 * herzie's real one is its friend code's). They never take a player's
 * place. */
export const TOWN_WATCH_MAPS: ReadonlySet<TownMapId> = new Set(["home"]);
/** Watchers per room before more are turned away with `full`. */
export const TOWN_WATCH_CAPACITY = 100;
/** The `you` a watcher's welcome carries: it has no herzie. */
export const TOWN_WATCHER_ID = 0;
/** Maps that need a ticket carrying a claim: a `boss` claim for the boss
 * room, a `tower` claim for the Tower (see TownTicketPayload). */
export const TOWN_TICKETED_MAPS: ReadonlySet<TownMapId> = new Set([
  "bossroom",
  "tower",
]);
/** Maps whose ticket is asked for by name (`town-ticket?map=`), so it can
 * carry that map's claim: the ticketed ones, which need one, and the Wilds,
 * where an open "wilds" event's claim keys the room's loot and the
 * listening bonus (none while the Wilds are shut). */
export const TOWN_CLAIM_MAPS: ReadonlySet<TownMapId> = new Set([
  ...TOWN_TICKETED_MAPS,
  "wilds",
]);
/** Maps where every herzie gets a room of their own: the client names it
 * with `?i=<user id>`, and the room only takes that herzie's ticket. */
export const TOWN_INSTANCED_MAPS: ReadonlySet<TownMapId> = new Set(["tower"]);

/** Top walking speed, world units a second (the desktop's `WALK_SPEED`). */
export const TOWN_WALK_SPEED = 4.5;
/** Top speed while sprinting (Shift held); the server allows up to this. */
export const TOWN_SPRINT_SPEED = 6;

/** WebSocket close codes the server uses, so the client knows whether to
 * retry, move shard, or give up. */
export const TOWN_CLOSE = {
  /** Bad, missing or expired ticket: fetch a new one, then retry. */
  auth: 4001,
  /** Protocol version mismatch: stop and ask for an update. */
  outdated: 4002,
  /** Room is full: try the next shard. */
  full: 4003,
  /** The same herzie connected again elsewhere: stop. */
  replaced: 4004,
  /** Too many messages or impossible movement: back off. */
  kicked: 4005,
  /** Went quiet (no pings): reconnect. */
  idle: 4006,
  /** The room shut: the fight ended or the boss left. Go back to town. */
  closed: 4007,
  /** The room is sealed to you (no boss claim, or knocked out). */
  sealed: 4008,
} as const;

// ---------------------------------------------------------------------------
// Looks and tickets

/** What other players need to draw you. */
export type TownLook = {
  /** The render seed: the herzie's friend code. Website watchers get a
   * stand-in seed instead, with the body the real one rolls in `body`, so
   * the code never leaves the server. */
  seed: string;
  stage: number;
  equipped?: Equipped;
  /** The body its real seed rolls, drawn instead of the seed's. Only what
   * watchers get carries it. */
  body?: CreatureParams;
};

export type TownTicketPayload = {
  /** Supabase user id: one connection per user. */
  uid: string;
  name: string;
  look: TownLook;
  /** Expiry, unix seconds. */
  exp: number;
  /** Health when the ticket was issued; the Town server seeds a fight from
   * it. Absent on tickets from before health existed. */
  hp?: { hp: number; maxHp: number; down: boolean };
  /** Combat stats, `[sonicPower, luck, critChance, critDamage, stamina,
   * def, euphony, timing]`, so the server can roll a cast's damage, pace a
   * herzie's casts and judge a hit or a heal without a database. Tickets
   * from before stat points stop after critDamage, and from before Timing
   * after euphony: read the rest as 0. */
  st?: [number, number, number, number, number?, number?, number?, number?];
  /** Set only when the boss room is open: the boss event, when it ends
   * (unix seconds), and the boss's health as of the ticket (the room starts
   * a fight from it if it has none running). The boss room turns away
   * tickets without it. */
  boss?: BossClaim;
  /** Set only while a Tower event is on: the event, when it ends (unix
   * seconds), the floor this herzie starts on (one past the floor its
   * climb has reached: tower_reset starts a climb over, so this can be
   * below its best), the boons its climb has picked (TOWER_BOONS), and
   * the climb's number (tower_reset counts it up; the room's tower batches
   * carry it back, so a batch from before a reset can't undo it). The
   * Tower turns away tickets without it. */
  tower?: {
    event: string;
    until: number;
    floor: number;
    boons?: TowerBoon[];
    /** Picks the climb has skipped (each counts as a pick spent). */
    skips?: number;
    climb?: number;
  };
  /** Set only while a "wilds" event is on (on a ticket for the Wilds): the
   * event and its window (ms since the epoch). The Wilds room keys its
   * caches, dropped cards and listening bonus on it; without it, none of
   * those. */
  wilds?: { event: string; startsAt: number; endsAt: number };
  /** The herzie's level, for the Tower's level gap. */
  lv?: number;
  /** The herzie's class (classes.ts), once chosen. */
  cls?: string;
  /** Its class skills and their levels, `[skillId, level]`, so the server
   * can judge a skill's strength without a database. */
  sk?: [string, number][];
  /** The emotes it owns (emotes.ts), so the server can refuse one it
   * doesn't. Absent: none. */
  em?: string[];
  /** A game master (00133): its name carries a "GM" mark. */
  gm?: true;
  /** The title it wears (titles.ts), shown over its name. Absent: none. */
  ti?: string;
};

/** The boss room's half of a ticket. */
export type BossClaim = {
  event: string;
  /** When the event ends (unix seconds): the boss escapes. */
  until: number;
  /** The boss's health in the database as of the ticket. Before the lock
   * it's a placeholder; the lock sets it from the roster. */
  hp: number;
  maxHp: number;
  /** When the lobby locks into a fight (unix seconds). Absent from older
   * ticket servers: no lobby, the fight is on. */
  starts?: number;
  /** Once locked: when, the herzies still in, and the revives spent, so a
   * room that restarted mid-fight picks it up where it was. */
  locked?: { at: number; roster: string[]; revives: number };
  /** Health per herzie in the roster; default BOSS_HP_PER_PLAYER. */
  hpPerPlayer?: number;
  /** Its minions' strength, as a Tower floor; default MINION_FLOOR. */
  minionFloor?: number;
};

/** How long a ticket lasts; the client renews well before this. */
export const TOWN_TICKET_TTL_S = 10 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(
      s.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (s.length % 4)) % 4),
    );
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hmacKey(secret: string, use: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [use],
  );
}

/** `payload.signature`, both base64url: an HMAC-SHA256 ticket the edge
 * function issues and the town server checks, so the server trusts who you
 * are and how you look without its own database access. */
export async function signTownTicket(
  payload: TownTicketPayload,
  secret: string,
): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(body),
  );
  return `${body}.${base64url(new Uint8Array(sig))}`;
}

/** The ticket's payload if its signature holds and it hasn't expired. */
export async function verifyTownTicket(
  ticket: string,
  secret: string,
  nowSeconds: number = Date.now() / 1000,
): Promise<TownTicketPayload | null> {
  if (typeof ticket !== "string" || ticket.length > 8192) return null;
  const dot = ticket.indexOf(".");
  if (dot < 0) return null;
  const body = ticket.slice(0, dot);
  const sig = fromBase64url(ticket.slice(dot + 1));
  const raw = fromBase64url(body);
  if (!sig || !raw) return null;
  // subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    sig,
    encoder.encode(body),
  );
  if (!ok) return null;
  let payload: TownTicketPayload;
  try {
    payload = JSON.parse(decoder.decode(raw));
  } catch {
    return null;
  }
  if (
    typeof payload?.uid !== "string" ||
    typeof payload.name !== "string" ||
    typeof payload.look?.seed !== "string" ||
    typeof payload.look.stage !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp <= nowSeconds
  ) {
    return null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Town server → `town-vitals` requests

/** Max age of a signed `town-vitals` request, so a captured one can't be
 * replayed later. */
export const VITALS_REQUEST_TTL_MS = 60_000;

function vitalsMessage(body: string, ts: number, nonce: string): string {
  // The "vitals:" prefix keeps these signatures from ever validating as a
  // ticket body, though both use the same secret.
  return `vitals:${ts}:${nonce}:${body}`;
}

/** The signature the Town server sends with a request to `town-vitals`. */
export async function signVitalsRequest(
  body: string,
  ts: number,
  nonce: string,
  secret: string,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(vitalsMessage(body, ts, nonce)),
  );
  return base64url(new Uint8Array(sig));
}

/** Whether a `town-vitals` request is signed by the Town server and fresh. */
export async function verifyVitalsRequest(
  body: string,
  ts: number,
  nonce: string,
  signature: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > VITALS_REQUEST_TTL_MS) {
    return false;
  }
  if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 64) {
    return false;
  }
  const sig = fromBase64url(signature);
  if (!sig) return false;
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    sig,
    encoder.encode(vitalsMessage(body, ts, nonce)),
  );
}

// ---------------------------------------------------------------------------
// Movement frames (binary)

/** Where a herzie is and what it's doing, as the wire carries it. */
export type TownState = {
  x: number;
  z: number;
  /** Radians, any range; sent modulo 2π. */
  heading: number;
  /** Ground speed, units a second: drives the walk cycle. */
  speed: number;
  flags: number;
};

/** Away from keyboard: shown dimmed. */
export const TOWN_FLAG_AFK = 1;
/** Sitting on a bench (at its seat): drawn seated. */
export const TOWN_FLAG_SITTING = 2;
/** Standing still with music playing: drawn dancing. */
export const TOWN_FLAG_DANCING = 4;
/** Three bits counting sonic casts, mod 8 (see castSeqOf): whenever they
 * change, the herzie cast as many waves, facing its heading. A count, not
 * an "is casting" bit, so two casts between ticks aren't one. */
export const TOWN_CAST_SHIFT = 3;
export const TOWN_CAST_MASK = 0b111 << TOWN_CAST_SHIFT;
/** In combat mode. */
export const TOWN_FLAG_COMBAT = 64;
/** Flips on every jump: whenever it changes, the herzie hopped. A toggle,
 * not an "is airborne" bit, so a jump straight after landing still shows. */
export const TOWN_FLAG_JUMP = 128;

/** The cast count carried in a state's flags. */
export function castSeqOf(flags: number): number {
  return (flags & TOWN_CAST_MASK) >> TOWN_CAST_SHIFT;
}
/** `flags` carrying cast count `seq` (mod 8). */
export function withCastSeq(flags: number, seq: number): number {
  return (flags & ~TOWN_CAST_MASK) | ((seq & 0b111) << TOWN_CAST_SHIFT);
}
/** How many casts it took to get from count `from` to `to` (mod 8). */
export function castsBetween(from: number, to: number): number {
  return (to - from + 8) & 0b111;
}

const OP_STATE = 1;
const OP_SNAPSHOT = 2;
const OP_CAST = 3;

/** Positions in centimetres in an int16: ±327 units, well past the island. */
const POS_SCALE = 100;
const POS_MAX = 32767 / POS_SCALE;
const TAU = Math.PI * 2;
const HEADING_SCALE = 65536 / TAU;
/** Speed in 5 cm/s steps in a uint8: up to 12.75 units a second. */
const SPEED_SCALE = 20;

/** op + seq + entity state. */
export const STATE_FRAME_BYTES = 1 + 2 + 8;
/** Per entity in a snapshot: id + age + state. */
const SNAPSHOT_ENTRY_BYTES = 2 + 1 + 8;
/** op + count + server time. */
const SNAPSHOT_HEADER_BYTES = 1 + 2 + 8;

function writeState(v: DataView, at: number, s: TownState): void {
  const clampPos = (n: number) =>
    Math.round(Math.max(-POS_MAX, Math.min(POS_MAX, n)) * POS_SCALE);
  v.setInt16(at, clampPos(s.x));
  v.setInt16(at + 2, clampPos(s.z));
  const h = ((s.heading % TAU) + TAU) % TAU;
  v.setUint16(at + 4, Math.round(h * HEADING_SCALE) & 0xffff);
  v.setUint8(
    at + 6,
    Math.max(0, Math.min(255, Math.round(s.speed * SPEED_SCALE))),
  );
  v.setUint8(at + 7, s.flags & 0xff);
}

function readState(v: DataView, at: number): TownState {
  return {
    x: v.getInt16(at) / POS_SCALE,
    z: v.getInt16(at + 2) / POS_SCALE,
    heading: v.getUint16(at + 4) / HEADING_SCALE,
    speed: v.getUint8(at + 6) / SPEED_SCALE,
    flags: v.getUint8(at + 7),
  };
}

/** Rounds a state the way the wire would, so the sender and the server agree
 * on exactly where a herzie is. */
export function quantizeState(s: TownState): TownState {
  const buf = new DataView(new ArrayBuffer(8));
  writeState(buf, 0, s);
  return readState(buf, 0);
}

/** Client → server: "I am here". `seq` wraps at 65536. */
export function encodeStateFrame(seq: number, s: TownState): ArrayBuffer {
  const buf = new ArrayBuffer(STATE_FRAME_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, OP_STATE);
  v.setUint16(1, seq & 0xffff);
  writeState(v, 3, s);
  return buf;
}

export function decodeStateFrame(
  data: ArrayBuffer,
): { seq: number; state: TownState } | null {
  if (data.byteLength !== STATE_FRAME_BYTES) return null;
  const v = new DataView(data);
  if (v.getUint8(0) !== OP_STATE) return null;
  return { seq: v.getUint16(1), state: readState(v, 3) };
}

export type SnapshotEntry = {
  id: number;
  /** How long before the snapshot's time the server received this state, in
   * ms (0–255). Timing each state by its arrival rather than by the tick
   * that carried it keeps remote walking speeds even. */
  age: number;
  state: TownState;
};

/** Server → client: everyone who changed since the last tick (or the whole
 * room, for a newcomer), stamped with the server's clock in ms. */
export function encodeSnapshot(
  serverTime: number,
  entries: readonly SnapshotEntry[],
): ArrayBuffer {
  const buf = new ArrayBuffer(
    SNAPSHOT_HEADER_BYTES + entries.length * SNAPSHOT_ENTRY_BYTES,
  );
  const v = new DataView(buf);
  v.setUint8(0, OP_SNAPSHOT);
  v.setUint16(1, entries.length);
  v.setFloat64(3, serverTime);
  let at = SNAPSHOT_HEADER_BYTES;
  for (const e of entries) {
    v.setUint16(at, e.id);
    v.setUint8(at + 2, Math.max(0, Math.min(255, Math.round(e.age))));
    writeState(v, at + 3, e.state);
    at += SNAPSHOT_ENTRY_BYTES;
  }
  return buf;
}

export function decodeSnapshot(
  data: ArrayBuffer,
): { serverTime: number; entries: SnapshotEntry[] } | null {
  if (data.byteLength < SNAPSHOT_HEADER_BYTES) return null;
  const v = new DataView(data);
  if (v.getUint8(0) !== OP_SNAPSHOT) return null;
  const count = v.getUint16(1);
  if (data.byteLength !== SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_ENTRY_BYTES)
    return null;
  const entries: SnapshotEntry[] = [];
  let at = SNAPSHOT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    entries.push({
      id: v.getUint16(at),
      age: v.getUint8(at + 2),
      state: readState(v, at + 3),
    });
    at += SNAPSHOT_ENTRY_BYTES;
  }
  return { serverTime: v.getFloat64(3), entries };
}

// ---------------------------------------------------------------------------
// Casts (binary, client to server)

/** op + seq + yaw + pitch. */
export const CAST_FRAME_BYTES = 1 + 2 + 2 + 2;
/** Angles travel as int16 ten-thousandths of a radian: ±3.2767. */
const ANGLE_SCALE = 10_000;

/** A sonic cast and where it was aimed, as the boss room needs it. Yaw and
 * pitch are the unit direction's angles (see `aimAngles`). */
export type CastFrame = { seq: number; yaw: number; pitch: number };

const clampAngle = (a: number) =>
  Math.round(Math.max(-3.2767, Math.min(3.2767, a)) * ANGLE_SCALE);

export function encodeCastFrame(c: CastFrame): ArrayBuffer {
  const buf = new ArrayBuffer(CAST_FRAME_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, OP_CAST);
  v.setUint16(1, c.seq & 0xffff);
  v.setInt16(3, clampAngle(c.yaw));
  v.setInt16(5, clampAngle(c.pitch));
  return buf;
}

/** The cast in a frame, or null if it isn't one. */
export function decodeCastFrame(buf: ArrayBuffer): CastFrame | null {
  if (buf.byteLength !== CAST_FRAME_BYTES) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== OP_CAST) return null;
  return {
    seq: v.getUint16(1),
    yaw: v.getInt16(3) / ANGLE_SCALE,
    pitch: v.getInt16(5) / ANGLE_SCALE,
  };
}

// ---------------------------------------------------------------------------
// Control messages (JSON text)

/** Liveness ping. The server answers "pong" without waking up (a Durable
 * Object auto-response), so idle rooms stay hibernated. */
export const TOWN_PING = "ping";
export const TOWN_PONG = "pong";

export type TownPlayer = {
  id: number;
  name: string;
  look: TownLook;
  /** Knocked out, outside a fight (in a fight its health says so): a Bard
   * can play it back up. */
  down?: true;
  /** A game master: its name carries a "GM" mark. */
  gm?: true;
  /** The title it wears (titles.ts), shown over its name. */
  title?: string;
};

/** What a duelist sends about a duel (see duel.ts). */
export type DuelClientOp =
  /** Challenge herzie `to` (an entity id), standing within
   * DUEL.challengeRange. One outgoing challenge at a time: a new one
   * replaces the last. */
  | { op: "ask"; to: number }
  /** Answer `from`'s challenge. `auto`: declined without asking the player
   * (they don't take duels, or blocked this herzie): the challenger is told
   * "not accepting" rather than "declined". */
  | { op: "answer"; from: number; yes: boolean; auto?: boolean }
  /** Withdraw your challenge. */
  | { op: "cancel" }
  /** Give up the duel you're in (also sent before leaving the map). */
  | { op: "yield" }
  /** After a duel: ask for a rematch, or agree to one asked for. */
  | { op: "rematch" };

/** Why a challenge (or a rematch) didn't happen, as the room tells the
 * challenger. */
export type DuelRefusal =
  /** Not close enough: walk up (DUEL.challengeRange; on accept, acceptRange). */
  | "far"
  /** One of you is in a duel, or the herzie is answering another challenge. */
  | "busy"
  /** Not on this map (DUEL_MAPS). */
  | "here"
  | "self"
  | "declined"
  /** No answer in DUEL.askTtlMs. */
  | "expired"
  /** The herzie doesn't take duels (an `auto` decline). */
  | "auto"
  /** Too soon: after your last challenge, or this herzie's last decline.
   * `retryIn` says how long. */
  | "cooldown"
  /** The herzie is away (AFK) or knocked out. */
  | "away"
  /** The herzie left the room. */
  | "gone"
  /** You withdrew it. */
  | "cancelled";

/** How a duel ended. */
export type DuelEndReason =
  /** Brought to its knees (the winner's hit took the last of its HP). */
  | "defeat"
  /** Gave up. */
  | "yield"
  /** Stayed outside the ring too long. */
  | "bounds"
  /** Left the room, or lost its connection and didn't come back. */
  | "left"
  /** Ran to DUEL.hardCapMs: the higher share of health won. */
  | "time"
  /** Ran to DUEL.hardCapMs level, or both left. No winner. */
  | "draw"
  /** Called off before the fight began (a disconnect in the countdown, the
   * room restarting). Nothing counts. */
  | "cancelled";

/** A duel as the room tells everyone in it. Times are server clock (ms,
 * the snapshots' clock). */
export type DuelState = {
  id: number;
  /** The challenger and the challenged (entity ids). */
  a: number;
  b: number;
  /** The ring's centre (radius DUEL.ringRadius). */
  x: number;
  z: number;
  phase: "countdown" | "fight" | "over";
  /** Whether the countdown opens with the VS card (not on a rematch). */
  intro: boolean;
  /** When the countdown began, and when the fight does ("FIGHT!"). */
  at: number;
  startsAt: number;
  /** Sudden death from here (startsAt + DUEL.regulationMs), and the end at
   * the latest (startsAt + DUEL.hardCapMs). */
  suddenAt: number;
  endsAt: number;
  /** Where each was put for the countdown. */
  marks: { a: { x: number; z: number }; b: { x: number; z: number } };
  /** Both duelists' duel health. */
  hp: { id: number; hp: number; maxHp: number }[];
};

/** A herzie in the Wilds' free-for-all (wilds-pvp.ts) as the room tells
 * everyone, when any of it changes: its PvP health, whether it's down
 * (and gets up in the camp at `down`, server ms), and whether hits on it
 * don't count yet (until `shield`, server ms). Nobody is told of a
 * herzie at full health with neither. */
export type WildsPvpState = {
  id: number;
  hp: number;
  maxHp: number;
  down?: number;
  shield?: number;
};

export type ClientMessage =
  /** First message on a socket. `at` is where the herzie stands now. */
  | { t: "hello"; v: number; ticket: string; at: TownState }
  /** A fresh ticket: renews the session and carries look changes. */
  | { t: "ticket"; ticket: string }
  /** A class skill, aimed (yaw, pitch) like a cast. `seq` echoes back in a
   * refusal, so the client can undo just that prediction. */
  | { t: "skill"; skill: string; seq: number; yaw: number; pitch: number }
  /** Eat a consumable (a Star Candy) in a boss fight, where the room holds
   * HP. `seq` echoes back in the answer. Elsewhere the client eats through
   * the API instead. */
  | { t: "eat"; item: string; seq: number }
  /** In the Tower, on a cleared floor: on to the next one. The room puts
   * you back at the map's spawn (the west end). */
  | { t: "next" }
  /** In the boss room, the Tower or on the Wilds: whether you're playing
   * music (the boss hates it, any of it; the Tower pays the same bonus;
   * the Wilds' Hunt Crystal fills with it). Sent when it changes. */
  | { t: "tune"; on: boolean }
  /** A Bard's lute: its basic attack heals the ally it's aimed at (true)
   * or hurts (false). Sent on every switch and every arrival. */
  | { t: "stance"; heal: boolean }
  /** Play an emote (emotes.ts) for everyone in the room. Any room; refused
   * unless the ticket says you own it, and at most one per
   * EMOTE_COOLDOWN_MS. */
  | { t: "emote"; e: string }
  /** Knocked out in a raid, and giving up: out of the fight for good (no
   * reward). The app then respawns you in town. */
  | { t: "forfeit" }
  /** Duels, on the maps that have them (DUEL_MAPS). */
  | ({ t: "duel" } & DuelClientOp)
  /** On the Wilds: take dropped card `id` (in reach, and only once its
   * first claim is yours or over). (A cache isn't asked for: the room
   * opens it for whoever holds it; see `wildsHold`.) */
  | { t: "wildsTake"; id: string }
  /** In the Tower: open the cleared floor's chest (within TOWER_CHEST.reach,
   * once it's settled). The room answers with the floor (no chest) and
   * its `loot`. */
  | { t: "chestOpen" }
  /** In the Tower: spend the climb's next earned pick on offer `offer` of
   * the floor's `offers` (its index), or skip it (null). The room answers
   * with the floor (its boons, picks and the next offers). */
  | { t: "towerPick"; offer: number | null };

/** Why a skill was refused, when the player can do something about it:
 * nobody downed near enough, no revives left, not until the fight, or not
 * in a duel or the Wilds' free-for-all (Taunt, Resurrect). */
export type SkillRefusal =
  | "no-target"
  | "not-yet"
  | "instrument"
  | "duel"
  | "wilds";

/** Why the room refused to let you eat: knocked out, already at full HP,
 * too soon after the last one, none left in the bank, not something you
 * eat, or not in a fight (eat through the API instead). */
export type EatRefusal =
  | "down"
  | "full"
  | "cooldown"
  | "none-left"
  | "not-consumable"
  | "not-here"
  | "failed";

/** A shape the boss is about to hit the floor with. Times are server clock
 * (ms, the same clock as snapshots); a client shows the remaining windup
 * from `hitAt`, so a late message still draws the right fill. */
export type BossTelegraph = {
  id: number;
  /** A buster is aimed at one herzie, `target`, and lands on it wherever it
   * goes: what a tank is for. A scatter mark follows `target` too and goes
   * off around them, on anyone close: spread out. */
  kind: "circle" | "ring" | "buster" | "scatter" | "lane";
  /** A lane (the boss's charge): from (x, z) heading `yaw`, `len` long and
   * `r` either side of its line. */
  yaw?: number;
  len?: number;
  /** The enrage's pulse: lands on everyone, whatever their Def (1). */
  lethal?: 1;
  /** The dirge: lands on everyone, and only a Cymbrella's dome stops it (1). */
  doom?: 1;
  /** A minion's (or a Tower mob's) swing, not the boss's: its id. */
  mob?: number;
  x: number;
  z: number;
  r: number;
  /** A ring's safe middle; 0 for a circle. */
  inner: number;
  at: number;
  hitAt: number;
  /** A buster's target: an entity id. */
  target?: number;
};

/** A buff on a herzie, as the wire carries it. `until` is server clock. */
export type TownBuff = {
  id: number;
  buff: string;
  value: number;
  until: number;
  /** An in-tune bonus: what it does ("def", "heal" or "damage"). */
  kind?: string;
};

/** Where the raid stands, as the boss room tells everyone. Times are
 * server clock (ms). */
export type RaidState = {
  stage: "lobby" | "fight" | "over";
  /** When the lobby locks into a fight. */
  startsAt: number;
  /** When it locked (in a fight). */
  lockedAt?: number;
  /** Herzies in the fight (standing or down), and how many stand. In the
   * lobby: how many are waiting. */
  roster: number;
  standing: number;
  /** Who the boss is after (an entity id), if anyone. */
  focus: number | null;
  /** Whether that's because of a taunt. */
  taunted: boolean;
  /** When it starts to quicken, and when it ends the fight. */
  enrageAt?: number;
  hardAt?: number;
  /** Whether you're in the fight (sent per player): false once you're out,
   * or if you came after the lock. */
  you?: "in" | "out" | "watching";
};

/** What a newcomer to the boss room is told on arrival. */
export type FightState = {
  /** The boss's event id: the seed of its look, as it appears in town. */
  event: string;
  hp: number;
  maxHp: number;
  phase: 1 | 2 | 3;
  telegraphs: BossTelegraph[];
  /** Everyone's HP in the room, by entity id. */
  health: { id: number; hp: number; maxHp: number }[];
  /** Buffs still running, by entity id. */
  buffs?: TownBuff[];
  /** Server clock now (ms), so telegraph times line up at once. */
  now: number;
  /** In the Tower: the floor, as it stands. */
  tower?: TowerFloor;
  /** In the boss room: the raid, where the boss stands, what it's saying,
   * and any resurrect being played. */
  raid?: RaidState;
  bossAt?: { x: number; z: number; yaw: number };
  say?: { text: string; until: number };
  channels?: { by: number; target: number; until: number }[];
  /** Bards in their heal stance (entity ids): their bolts are drawn green. */
  healers?: number[];
  /** The boss's minions standing, if it has called any. */
  mobs?: TowerMob[];
};

/** A Tower mob as the wire carries it: where it is and which way it faces,
 * its health, and whether it's winding up a swing (`s` 1). */
export type TowerMob = {
  id: number;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  s: 0 | 1;
  /** Its kind (a brute when missing: older servers had only those). */
  k?: "spitter" | "lunger";
  /** An elite (1) or the Warden (2). */
  e?: 1 | 2;
  /** Stunned until (server ms): it stands there. Older servers never
   * send it, older apps ignore it. */
  st?: number;
};

/** A Tower floor: its number, its mobs' level (and the herzie's, for the
 * gap), the mobs, and whether it's cleared (the way on is open). */
export type TowerFloor = {
  floor: number;
  level: number;
  you: number;
  mobs: TowerMob[];
  cleared: boolean;
  /** Ms until the mobs enrage, as of sending (0: they have). Missing from
   * older servers. */
  enrageIn?: number;
  /** A cleared Warden's floor's chest, where it stands, shut until you
   * press E by it (a `chestOpen`; the room opens it, and its loot follows
   * as a `loot` from here: see TOWER_CHEST). Absent: no chest (any other
   * floor, or opened). */
  chest?: { x: number; z: number };
  /** The climb's boons so far (TOWER_BOONS), how many picks it has earned
   * and not spent (taken or skipped) yet, and the next pick's three
   * offers (towerBoonOffers; while `picks` > 0). Missing from older
   * servers. */
  boons?: TowerBoon[];
  picks?: number;
  offers?: TowerBoon[];
};

/** One piece of boss loot: a pending drop's id and its item id. */
export type LootDrop = { id: string; item: string };

/** A place on a boss fight's table: its rank by contribution (1 is the
 * top; see contributionOf), the herzie's name, the damage they dealt and the
 * HP they healed or blocked over the whole fight, and — for the top three,
 * drawn on the end screen — their look. */
export type BossPlace = {
  rank: number;
  name: string;
  damage: number;
  heal: number;
  look?: TownLook;
};

export type ServerMessage =
  /** Accepted: your entity id and everyone else here. A full snapshot
   * follows. `now`: the server's clock as it sent this, so times it
   * schedules (a shield, a cache opening) read right before any snapshot
   * (none come while you're alone); older servers left it out. `duels`:
   * those running in the room (to draw their rings). */
  | {
      t: "welcome";
      you: number;
      players: TownPlayer[];
      now?: number;
      fight?: FightState;
      duels?: DuelState[];
    }
  /** The boss's health and phase, when either changes. */
  | { t: "boss"; hp: number; maxHp: number; phase: 1 | 2 | 3 }
  | ({ t: "telegraph" } & BossTelegraph)
  /** An attack landed (or was dodged): remove its shape. */
  | {
      t: "resolve";
      id: number;
      hits: number[];
      /** Who a Cymbrella's dome sheltered from it (they took nothing). */
      sheltered?: number[];
    }
  /** You walked into mob `mob` and got hurt (your `hp` follows). Older
   * apps ignore it. */
  | { t: "bump"; mob: number }
  /** A herzie's health (yours too), after damage. */
  | { t: "hp"; id: number; hp: number; maxHp: number }
  /** Your cast hit the boss — or, in the Tower, mob `mob` — for this much
   * (sent to you alone). `bleed`: one of your Forbidden Frequency's bleed
   * hits. */
  | { t: "hit"; damage: number; crit: boolean; mob?: number; bleed?: true }
  /** The Tower's mobs (or the boss's minions), where they are now (every
   * tick while any are up). */
  /** Mobs that changed since the last (all of them in `welcome`/`floor`);
   * `at`: the server time they stood there. */
  | { t: "mobs"; mobs: TowerMob[]; at?: number }
  /** A Tower mob (or a minion) fell. */
  | { t: "mobDown"; mob: number; x: number; z: number }
  /** A Tower floor began, or was just cleared. */
  | ({ t: "floor" } & TowerFloor)
  /** You were knocked out. */
  | { t: "down" }
  /** The boss fell: the room closes shortly. */
  | { t: "victory"; by: number; closesAt: number }
  /** What you got for the boss, dropped in the cave for you to pick up:
   * each a ground drop (its id, for collect-drop) and the item it is.
   * Whatever isn't picked up here waits on your Home ground. */
  | {
      t: "loot";
      drops: LootDrop[];
      /** Where they drop from (a Tower mob, or a Warden's chest); absent:
       * out of the boss. */
      at?: { x: number; z: number };
    }
  /** The fight is over: how it went, its ten top damage dealers, and your
   * own place (null if you landed nothing). Sent once, to each herzie still
   * in the cave. */
  | {
      t: "results";
      outcome: "victory" | "defeat";
      top: BossPlace[];
      you: BossPlace | null;
    }
  /** The room closes at `closesAt` (server ms): the boss fell, got away,
   * or beat everyone (a wipe). */
  | {
      t: "closing";
      why: "victory" | "escaped" | "sealed" | "wiped";
      closesAt: number;
    }
  /** Where the boss stands and faces, while it walks (every tick it
   * moves). */
  /** Your own contribution to the fight so far, and where it ranks of
   * `of` (the roster), every couple of seconds. */
  | { t: "tally"; score: number; rank: number; of: number }
  /** Where the boss stands, at server time `at`. */
  | {
      t: "bossAt";
      at?: number;
      x: number;
      z: number;
      yaw: number;
      /** Stunned until (server ms). Older apps ignore it. */
      st?: number;
    }
  /** The boss says something, shown over its head until `until`. */
  | { t: "say"; text: string; until: number }
  /** The raid changed: its stage, roster, revives, the boss's focus. */
  | ({ t: "raid" } & RaidState)
  /** A buff came off a herzie before its time. */
  | { t: "buffOff"; id: number; buff: string }
  /** A Bard switched its lute's stance: heal bolts, or attacks. */
  | { t: "stance"; id: number; heal: boolean }
  /** Someone in the room played an emote. Older apps ignore it. */
  | { t: "emote"; id: number; e: string }
  /** A Bard began a resurrect on `target` (done at `until`), or it stopped
   * (`target` null). */
  | { t: "channel"; by: number; target: number | null; until: number }
  /** A downed herzie is back on its feet, played up by `by`. */
  /** `by`: the Bard's entity id, or -1 when the boss's fall did it. */
  | { t: "revived"; id: number; by: number }
  /** You're out of the fight: you left it, or were gone too long. */
  | { t: "out" }
  | { t: "join"; player: TownPlayer }
  | { t: "leave"; id: number }
  | { t: "look"; player: TownPlayer }
  /** The server refused a move: put your herzie back here. */
  | { t: "correct"; x: number; z: number }
  /** Someone used a class skill, for everyone to see it. */
  | {
      t: "skill";
      by: number;
      skill: string;
      level: number;
      x: number;
      z: number;
      yaw: number;
    }
  /** A Cymbal Trap's cymbal (thrown by `by`, an entity id) caught herzie
   * `target` (a mob's id when `mob`), and holds it where it stands until
   * `until` (server ms): it may turn and attack, not walk. Sent when the
   * cymbal gets there (the throw itself is a `skill`), to everyone who
   * can see it; a blow a dome took, or one on the boss, sends none. Older
   * apps ignore it. */
  | { t: "trap"; by: number; target: number; mob?: true; until: number }
  /** A bleed on herzie `target` (a mob's id when `mob`; the boss when
   * `boss`, `target` 0): `stacks` of it until `until` (server ms), thrown
   * by `by` (its newest thrower's entity id). Forbidden Frequency's, or
   * Silencio's when `skill` says so (its own, beside the other: one of
   * each on a target). Sent when a hit adds a stack or starts it over, and
   * with `stacks` 0 when it ends early (the target fell). Its ticks'
   * damage comes as ordinary hits. Older apps ignore it. */
  | {
      t: "bleed";
      by: number;
      target: number;
      mob?: true;
      boss?: true;
      skill?: "silencio";
      stacks: number;
      until: number;
    }
  /** A buff went on a herzie (or was refreshed). */
  | ({ t: "buff" } & TownBuff)
  /** Your skill was refused: it's ready again at `readyAt` (server clock),
   * or 0 when it can't be used here at all. `reason` says why, when it's
   * something the player can act on. */
  | {
      t: "skillDenied";
      skill: string;
      seq: number;
      readyAt: number;
      reason?: SkillRefusal;
    }
  /** One of your skills levelled up (sent to you alone). */
  | { t: "skillUp"; skill: string; level: number }
  /** The answer to your `eat` (sent to you alone). The HP itself arrives as
   * an `hp`, like any heal. */
  | {
      t: "ate";
      seq: number;
      item: string;
      ok: boolean;
      heal?: number;
      reason?: EatRefusal;
    }
  /** `from` challenges you to a duel (sent to you alone): its level and
   * class for the prompt, and ms left to answer. */
  | {
      t: "duelAsk";
      from: number;
      lv?: number;
      cls?: string;
      ttl: number;
    }
  /** Your challenge to `to` is out, waiting `ttl` ms (sent to you alone). */
  | { t: "duelAsked"; to: number; ttl: number }
  /** A challenge (or rematch) with `with` didn't happen, and why (sent to
   * those it concerns). `retryIn`: ms until you may ask again. */
  | { t: "duelNo"; with: number; why: DuelRefusal; retryIn?: number }
  /** `from` withdrew its challenge, or it ran out (sent to the challenged). */
  | { t: "duelAskGone"; from: number }
  /** Your last opponent wants a rematch (sent to you alone). */
  | { t: "duelRematch"; by: number }
  /** A duel began, moved on a phase, or went into sudden death (to the
   * whole room). */
  | ({ t: "duel" } & DuelState)
  /** A duelist's duel health (to the whole room). */
  | { t: "duelHp"; id: number; hp: number; maxHp: number }
  /** Your duel hit landed on `target` for `damage` (sent to you alone);
   * `blocked`: a Cymbrella's dome took it (damage 0). */
  | {
      t: "duelHit";
      target: number;
      damage: number;
      crit: boolean;
      blocked?: true;
      /** One of your Forbidden Frequency's bleed hits. */
      bleed?: true;
    }
  /** A duelist is stunned until `until` (server ms; to the whole room). */
  | { t: "duelStun"; id: number; until: number }
  /** You're outside the ring: you yield at `until` (server ms) unless you're
   * back. Null: back in, or the timer paused (stunned). */
  | { t: "duelOut"; until: number | null }
  /** Your opponent's connection dropped: it has until `until` (server ms)
   * to come back (null: it's back). */
  | { t: "duelAway"; id: number; until: number | null }
  /** A duel ended (to the whole room). `winner`/`loser` null on a draw or a
   * cancel. `ms`: how long the fight ran. `rematchUntil`: server ms the
   * two may ask for a rematch until (absent if they can't). */
  | {
      t: "duelEnd";
      id: number;
      a: number;
      b: number;
      winner: number | null;
      loser: number | null;
      why: DuelEndReason;
      ms: number;
      tally: { id: number; damage: number; hits: number }[];
      rematchUntil?: number;
    }
  /** A herzie's standing in the Wilds' free-for-all changed (to the whole
   * room; to a newcomer, everyone's that isn't the default). `by`: who
   * just hurt it, for the blow's direction. */
  | ({ t: "pvp"; by?: number } & WildsPvpState)
  /** Your blow in the Wilds landed on `target` for `damage` (sent to you
   * alone); `blocked`: its Cymbrella dome took it, or it was still
   * protected (damage 0). */
  | {
      t: "pvpHit";
      target: number;
      damage: number;
      crit: boolean;
      blocked?: true;
      /** One of your Forbidden Frequency's bleed hits. */
      bleed?: true;
    }
  /** A herzie in the Wilds is stunned until `until` (server ms; to the
   * whole room). */
  | { t: "pvpStun"; id: number; until: number }
  /** A herzie in the Wilds was taken down by `by` (an entity id; null if
   * it has left the room since), names as they were then. `logged`: it
   * left mid-fight, which counts the same. Sent to the two of them and to
   * anyone near where it fell. */
  | {
      t: "pvpFeed";
      by: number | null;
      byName: string;
      victim: number;
      victimName: string;
      logged?: true;
    }
  /** The Wilds' loot as it lies (to a newcomer, after `welcome`): the
   * cards dropped by herzies taken down, the cache that's out, who's
   * holding it (null: nobody), and the Hunt Crystal (null, or absent from
   * an older room: no event on). */
  | {
      t: "wildsLoot";
      drops: WildsGroundDrop[];
      cache: WildsCacheView | null;
      hold: WildsCacheHold | null;
      hunt?: WildsHunt | null;
    }
  /** The Hunt Crystal's charge or rate changed: someone started or
   * stopped listening, it filled (its cache's `wildsCache` comes with it),
   * it went dull again once the cache was opened, or the event began or
   * ended (null). To the whole room. */
  | { t: "wildsHunt"; hunt: WildsHunt | null }
  /** A herzie taken down on the Wilds (entity `from`) dropped a card where
   * it fell (to the whole room). */
  | { t: "wildsDrop"; drop: WildsGroundDrop; from: number }
  /** A dropped card is gone: taken by entity `by` (null: someone who has
   * left since), or `back` to its owner, unclaimed (to the whole room). */
  | { t: "wildsGone"; id: string; by: number | null; back?: true }
  /** A cache turned up (`cache`), or was opened by `by` (`cache` null;
   * `byName` as they were then) or ran out (null, no `by`). To the whole
   * room. */
  | {
      t: "wildsCache";
      cache: WildsCacheView | null;
      by?: number;
      byName?: string;
    }
  /** You took a dropped card (sent to you alone): it's in your bag. */
  | { t: "wildsTaken"; item: string; level: number }
  /** You were taken down and dropped this card (sent to you alone). */
  | { t: "wildsLost"; item: string; level: number }
  /** Who's holding cache `id` changed (to the whole room; see
   * WildsCacheHold): said on each change, not as it counts. Cleared by
   * the cache's own `wildsCache`. */
  | ({ t: "wildsHold"; id: string } & WildsCacheHold)
  /** The room wouldn't let you take drop `id`, or couldn't open cache
   * `id` for you though you held it, and why (sent to you alone). */
  | { t: "wildsRefused"; id: string; why: WildsLootRefusal };

export function parseServerMessage(text: string): ServerMessage | null {
  try {
    const m = JSON.parse(text);
    return m && typeof m.t === "string" ? (m as ServerMessage) : null;
  } catch {
    return null;
  }
}
