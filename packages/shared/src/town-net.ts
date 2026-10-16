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
import type { Equipped } from "./items.js";

/** Bumped on any incompatible change; the server turns away other versions
 * with {@link TOWN_CLOSE.outdated} so old desktop betas say "update" instead of
 * misreading frames. */
export const TOWN_PROTOCOL = 2;

/** Server snapshot rate. */
export const TOWN_TICK_HZ = 15;
export const TOWN_TICK_MS = 1000 / TOWN_TICK_HZ;
/** Players per room before newcomers spill into the next shard. */
export const TOWN_ROOM_CAPACITY = 40;
/** Shards a map may be split into. */
export const TOWN_MAX_SHARDS = 16;

/** The maps a client may ask for, with what the server needs to check
 * movement: the walkable radius and where a respawn puts you. Must match the
 * desktop's map files (checked by a desktop test). */
export const TOWN_MAPS = {
  home: { radius: 40, spawn: { x: 8.5, z: 9 } },
  /** The training grounds, through the portal: training dummies. */
  arena: { radius: 17, spawn: { x: 0, z: -12 } },
  /** The boss's cave: a small dark room, one shared fight. */
  bossroom: { radius: 13, spawn: { x: 0, z: 10 } },
  /** The Tower (an event): a lush island fought floor by floor, alone. You
   * arrive at the west end; each new floor puts you back there. */
  tower: { radius: 21, spawn: { x: -16.5, z: 0.5 } },
} as const;
export type TownMapId = keyof typeof TOWN_MAPS;
export function isTownMapId(id: string): id is TownMapId {
  return Object.hasOwn(TOWN_MAPS, id);
}

/** Maps that are one room however many come: the boss is shared, so there is
 * a single shard (and the room's capacity is the fight's). */
export const TOWN_SINGLE_SHARD: ReadonlySet<TownMapId> = new Set(["bossroom"]);
/** Maps that need a ticket carrying a claim: a `boss` claim for the boss
 * room, a `tower` claim for the Tower (see TownTicketPayload). */
export const TOWN_TICKETED_MAPS: ReadonlySet<TownMapId> = new Set([
  "bossroom",
  "tower",
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
  /** The render seed: the herzie's friend code. */
  seed: string;
  stage: number;
  equipped?: Equipped;
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
   * def, euphony]`, so the server can roll a cast's damage and judge a hit
   * or a heal without a database. Tickets from before stat points stop
   * after critDamage: read the rest as 0. */
  st?: [number, number, number, number, number?, number?, number?];
  /** Set only when the boss room is open: the boss event, when it ends
   * (unix seconds), and the boss's health as of the ticket (the room starts
   * a fight from it if it has none running). The boss room turns away
   * tickets without it. */
  boss?: { event: string; until: number; hp: number; maxHp: number };
  /** Set only while a Tower event is on: the event, when it ends (unix
   * seconds), and the floor this herzie starts on (one past their best).
   * The Tower turns away tickets without it. */
  tower?: { event: string; until: number; floor: number };
  /** The herzie's level, for the Tower's level gap. */
  lv?: number;
  /** The herzie's class (classes.ts), once chosen. */
  cls?: string;
  /** Its class skills and their levels, `[skillId, level]`, so the server
   * can judge a skill's strength without a database. */
  sk?: [string, number][];
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
/** In combat mode, on the training grounds. */
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
  | { t: "next" };

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
   * goes: what a tank is for. */
  kind: "circle" | "ring" | "buster";
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
};

/** A Tower floor: its number, its mobs' level (and the herzie's, for the
 * gap), the mobs, and whether it's cleared (the way on is open). */
export type TowerFloor = {
  floor: number;
  level: number;
  you: number;
  mobs: TowerMob[];
  cleared: boolean;
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
  /** Accepted: your entity id and everyone else here. A full snapshot follows. */
  | { t: "welcome"; you: number; players: TownPlayer[]; fight?: FightState }
  /** The boss's health and phase, when either changes. */
  | { t: "boss"; hp: number; maxHp: number; phase: 1 | 2 | 3 }
  | ({ t: "telegraph" } & BossTelegraph)
  /** An attack landed (or was dodged): remove its shape. */
  | { t: "resolve"; id: number; hits: number[] }
  /** A herzie's health (yours too), after damage. */
  | { t: "hp"; id: number; hp: number; maxHp: number }
  /** Your cast hit the boss — or, in the Tower, mob `mob` — for this much
   * (sent to you alone). */
  | { t: "hit"; damage: number; crit: boolean; mob?: number }
  /** The Tower's mobs, where they are now (every tick while any are up). */
  | { t: "mobs"; mobs: TowerMob[] }
  /** A Tower mob fell. */
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
      /** Where they drop from (a Tower mob); absent: out of the boss. */
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
  /** The room closes at `closesAt` (server ms): the boss left or won. */
  | { t: "closing"; why: "victory" | "escaped" | "sealed"; closesAt: number }
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
  /** A buff went on a herzie (or was refreshed). */
  | ({ t: "buff" } & TownBuff)
  /** Your skill was refused: it's ready again at `readyAt` (server clock),
   * or 0 when it can't be used here at all. */
  | { t: "skillDenied"; skill: string; seq: number; readyAt: number }
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
    };

export function parseServerMessage(text: string): ServerMessage | null {
  try {
    const m = JSON.parse(text);
    return m && typeof m.t === "string" ? (m as ServerMessage) : null;
  } catch {
    return null;
  }
}
