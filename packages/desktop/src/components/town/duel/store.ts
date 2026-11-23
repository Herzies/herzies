import type {
  DuelClientOp,
  DuelEndReason,
  DuelRefusal,
  DuelState,
  ServerMessage,
} from "@herzies/shared/town-net";
import { useSyncExternalStore } from "react";
import { mmss } from "./clock";

/**
 * Duels as the client holds them: every duel running in the room (their
 * rings), the one you're in, a challenge waiting on you or on the herzie
 * you challenged, and how your last duel ended. Written by
 * {@link handleDuelMessage} from the socket; read by the frame loop and,
 * through {@link useDuel}, by the HUD.
 *
 * Framework-free apart from the hooks, and free of sound and sight: what
 * the player should feel goes out as a {@link DuelEvent} (see feel.ts), so
 * the rules here are tested on their own.
 */

/** Who a herzie in the room is, as the HUD names it. */
export type Who = { name: string; seed: string; title?: string | null };

/** A duel in the room. Times are the server's (ms): see {@link localOf}. */
export type DuelView = Omit<DuelState, "hp"> & {
  health: Map<number, { hp: number; maxHp: number }>;
  /** Stunned until (server ms), by duelist. */
  stuns: Map<number, number>;
  /** A duelist's dropped connection: back by (server ms), or it's left. */
  away: Map<number, number>;
  /** When this client first heard of it, and when it ended here
   * (performance.now() ms; null while on): the ring drops in and fades. */
  seenAt: number;
  endedAt: number | null;
};

/** A challenge to you, waiting on your answer. */
export type DuelInvite = {
  from: number;
  who: Who;
  lv?: number;
  cls?: string;
  /** Answered or gone by (performance.now() ms), out of `ttl`. */
  until: number;
  ttl: number;
};

/** Your challenge, waiting on theirs. */
export type DuelOutgoing = {
  to: number;
  who: Who;
  until: number;
  ttl: number;
};

/** How your last duel went, for the banner and the end panel. */
export type DuelResult = {
  id: number;
  opponent: number;
  /** Their name then (they may have left since). */
  who: Who;
  /** Won (true), lost (false), or neither (a draw, a cancel). */
  won: boolean | null;
  why: DuelEndReason;
  /** How long the fight ran, and your hits in it. */
  ms: number;
  hits: number;
  /** When it ended here (performance.now() ms). */
  at: number;
  /** A rematch may be asked for until then (server ms; null: it can't). */
  rematchUntil: number | null;
  /** You asked for one; they did. */
  rematchAsked: boolean;
  rematchBy: boolean;
};

/** What happened, for the player to feel (sound, numbers, shakes). */
export type DuelEvent =
  | { k: "ask"; invite: DuelInvite }
  | { k: "refused"; text: string }
  | { k: "start"; duel: DuelView; mine: boolean }
  | {
      k: "hp";
      duel: DuelView;
      id: number;
      hp: number;
      was: number;
      maxHp: number;
    }
  | {
      k: "hit";
      target: number;
      damage: number;
      crit: boolean;
      blocked: boolean;
    }
  | { k: "stun"; id: number; until: number }
  | { k: "out"; until: number | null }
  | { k: "away"; id: number; until: number | null; who: Who | undefined }
  | {
      k: "end";
      duel: DuelView;
      winner: number | null;
      loser: number | null;
      why: DuelEndReason;
      ms: number;
      names: { a: string; b: string };
      result: DuelResult | null;
    }
  | { k: "rematch"; by: number; who: Who | undefined };

/** What the store needs from the connection. */
export type DuelContext = {
  /** A server time as performance.now() ms. */
  toLocal: (serverTime: number) => number;
  you: () => number | null;
  /** Another herzie in the room, by entity id. */
  who: (id: number) => Who | undefined;
  /** Sends a duel op (an `auto` decline is answered here). */
  send: (op: DuelClientOp) => void;
};

/** Who takes challenges from whom (Settings → Privacy). */
export type DuelRequests = "everyone" | "friends" | "nobody";

export const duel = {
  /** Your entity id in the room. */
  you: null as number | null,
  /** Every duel in the room, by id (the ended ones until their rings have
   * faded). */
  rooms: new Map<number, DuelView>(),
  invite: null as DuelInvite | null,
  outgoing: null as DuelOutgoing | null,
  /** You've said yes to `from`, and wait on the room. */
  answering: null as number | null,
  /** You're outside the ring: you yield then (server ms), unless back. */
  outUntil: null as number | null,
  result: null as DuelResult | null,
  /** Who you're fighting, as they were named when it began. */
  foe: null as Who | null,
  /** Your hits in the duel you're in. */
  hits: 0,
  /** The menu over a herzie's name: whose, and where (CSS px). */
  menu: null as { id: number; x: number; y: number } | null,
};

/** How long an ended duel's ring stays to fade (ms). */
export const RING_FADE_MS = 800;

let toLocal: (t: number) => number = (t) => t;

/** A server time on this machine's clock (performance.now() ms). */
export function localOf(serverTime: number): number {
  return toLocal(serverTime);
}

// --- Settings ----------------------------------------------------------------

const REQUESTS_KEY = "town.duel.requests";
let requests: DuelRequests = (() => {
  try {
    const v = localStorage.getItem(REQUESTS_KEY);
    return v === "friends" || v === "nobody" ? v : "everyone";
  } catch {
    return "everyone";
  }
})();
/** Herzies whose challenges are turned down unasked, this session (by
 * friend code: entity ids change with every visit). */
const blocked = new Set<string>();
/** Your friends' codes (the app's state). */
let friends: ReadonlySet<string> = new Set();

export function duelRequests(): DuelRequests {
  return requests;
}

export function setDuelRequests(v: DuelRequests): void {
  requests = v;
  try {
    localStorage.setItem(REQUESTS_KEY, v);
  } catch {
    // Not remembered, then.
  }
  emit();
}

export function setDuelFriends(codes: readonly string[]): void {
  friends = new Set(codes);
}

export function blockDuels(seed: string): void {
  blocked.add(seed);
}

/** Whether a challenge from `seed` reaches you, or is turned down unasked. */
export function takesChallengeFrom(seed: string): boolean {
  if (blocked.has(seed)) return false;
  if (requests === "nobody") return false;
  return requests === "everyone" || friends.has(seed);
}

// --- Change -----------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();
const eventListeners = new Set<(e: DuelEvent) => void>();

function emit() {
  version++;
  for (const l of listeners) l();
}

function fire(e: DuelEvent) {
  for (const l of eventListeners) l(e);
}

/** Hears every {@link DuelEvent}. Returns the unsubscribe. */
export function onDuelEvent(fn: (e: DuelEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Re-renders when anything about duels changes. */
export function useDuel(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** Re-renders when `pick`'s answer changes (a primitive), not on every
 * change: a herzie's tag asking whether its menu is open. */
export function useDuelValue<T extends string | number | boolean | null>(
  pick: () => T,
): T {
  return useSyncExternalStore(subscribe, pick);
}

// --- Reading ----------------------------------------------------------------

/** The duel you're in (countdown or fight), if any. */
export function myDuel(): DuelView | undefined {
  const you = duel.you;
  if (you === null) return undefined;
  for (const d of duel.rooms.values())
    if (d.endedAt === null && (d.a === you || d.b === you)) return d;
  return undefined;
}

/** True from the accept through the end: no loadout switching then. */
export function inDuel(): boolean {
  return !!myDuel();
}

/** {@link inDuel}, re-rendering when it changes. */
export function useInDuel(): boolean {
  return useSyncExternalStore(subscribe, inDuel);
}

let myHpShown: { hp: number; maxHp: number } | null = null;
/** Your duel health, from the accept until your ring has faded: what your
 * own health bar shows in place of your health then. Null otherwise. The
 * same object while it's unchanged (useSyncExternalStore compares it). */
export function myDuelHp(): { hp: number; maxHp: number } | null {
  const you = duel.you;
  const h = you === null ? undefined : ringOf(you)?.health.get(you);
  if (!h) myHpShown = null;
  else if (myHpShown?.hp !== h.hp || myHpShown.maxHp !== h.maxHp)
    myHpShown = { hp: h.hp, maxHp: h.maxHp };
  return myHpShown;
}

/** {@link myDuelHp}, re-rendering when it changes. */
export function useMyDuelHp(): { hp: number; maxHp: number } | null {
  return useSyncExternalStore(subscribe, myDuelHp);
}

/** The other one in duel `d` (from `id`'s side). */
export function opponentIn(d: DuelView, id: number | null): number {
  return d.a === id ? d.b : d.a;
}

/** Your opponent, in the duel you're in. */
export function myOpponent(): number | null {
  const d = myDuel();
  return d ? opponentIn(d, duel.you) : null;
}

/** The duel herzie `id` is fighting in (not ended), if any. */
export function duelOf(id: number): DuelView | undefined {
  for (const d of duel.rooms.values())
    if (d.endedAt === null && (d.a === id || d.b === id)) return d;
  return undefined;
}

/** The duel herzie `id` is in or was just in (its ring still fading): its
 * health is drawn till then. */
export function ringOf(id: number): DuelView | undefined {
  let last: DuelView | undefined;
  for (const d of duel.rooms.values())
    if (d.a === id || d.b === id) {
      if (d.endedAt === null) return d;
      last = d;
    }
  return last;
}

/** Whether the fight of duel `d` is on at local time `now` ("FIGHT!" has
 * been called): the server's word, or its start time come. */
export function fightOn(d: DuelView, now: number): boolean {
  return (
    d.endedAt === null && (d.phase === "fight" || now >= localOf(d.startsAt))
  );
}

/** You're in a duel's fight: casts and skills go to the server. */
export function duelFighting(now = performance.now()): boolean {
  const d = myDuel();
  return !!d && fightOn(d, now);
}

/** Your herzie is held where it stands: the countdown, or a stun. */
export function duelHeld(now = performance.now()): boolean {
  const d = myDuel();
  if (!d || duel.you === null) return false;
  if (!fightOn(d, now)) return true;
  const stun = d.stuns.get(duel.you);
  return stun !== undefined && now < localOf(stun);
}

// --- Writing ----------------------------------------------------------------

function view(s: DuelState, seen: number): DuelView {
  const { hp, ...rest } = s;
  return {
    ...rest,
    health: new Map(hp.map((h) => [h.id, { hp: h.hp, maxHp: h.maxHp }])),
    stuns: new Map(),
    away: new Map(),
    seenAt: seen,
    endedAt: null,
  };
}

const named = (ctx: DuelContext, id: number): Who =>
  ctx.who(id) ?? { name: "Someone", seed: "" };

/** What a refusal says, neutral whoever's at fault. `accepting`: it came
 * back on your yes (or a rematch), not your challenge. */
export function refusalText(
  why: DuelRefusal,
  name: string,
  opts: { retryIn?: number; accepting?: boolean; rematch?: boolean } = {},
): string | null {
  const q = `"${name}"`;
  if (opts.rematch)
    switch (why) {
      case "expired":
        return "The rematch window closed.";
      case "busy":
        return `${q} is busy.`;
      case "gone":
        return `${q} left.`;
      case "far":
        return `Too far from ${q} for a rematch.`;
      case "away":
        return `${q} can't duel right now.`;
      case "cancelled":
        return null;
      default:
        return "The rematch is off.";
    }
  switch (why) {
    case "self":
      return "You can't challenge yourself.";
    case "here":
      return "Duels aren't allowed here.";
    case "far":
      return opts.accepting
        ? `Too far from ${q}: the duel's off.`
        : `Get closer to ${q} to challenge them.`;
    case "busy":
      return `${q} is busy right now.`;
    case "away":
      return `${q} can't duel right now.`;
    case "declined":
      return `${q} declined.`;
    case "expired":
      return `${q} didn't answer.`;
    case "auto":
      return `${q} isn't accepting duels.`;
    case "cooldown":
      return opts.retryIn !== undefined
        ? `You can challenge ${q} again in ${mmss(opts.retryIn)}.`
        : "Wait a moment before challenging again.";
    case "gone":
      return `${q} left.`;
    case "cancelled":
      return null;
  }
}

/** Apply one server message. Returns whether it was about duels (the
 * welcome is also everyone else's). */
export function handleDuelMessage(m: ServerMessage, ctx: DuelContext): boolean {
  toLocal = ctx.toLocal;
  const now = performance.now();
  switch (m.t) {
    case "welcome": {
      duel.you = m.you;
      duel.invite = null;
      duel.outgoing = null;
      duel.answering = null;
      duel.outUntil = null;
      duel.rooms.clear();
      // Already running: drawn as they are, no drop-in.
      for (const s of m.duels ?? []) {
        duel.rooms.set(s.id, view(s, Number.NEGATIVE_INFINITY));
        // Back in your own duel (a dropped connection): who it's against.
        if (s.a === m.you || s.b === m.you)
          duel.foe = named(ctx, s.a === m.you ? s.b : s.a);
      }
      emit();
      return false;
    }
    case "duelAsk": {
      const who = named(ctx, m.from);
      if (!takesChallengeFrom(who.seed)) {
        ctx.send({ op: "answer", from: m.from, yes: false, auto: true });
        return true;
      }
      duel.invite = {
        from: m.from,
        who,
        ...(m.lv !== undefined ? { lv: m.lv } : {}),
        ...(m.cls !== undefined ? { cls: m.cls } : {}),
        until: now + m.ttl,
        ttl: m.ttl,
      };
      fire({ k: "ask", invite: duel.invite });
      emit();
      return true;
    }
    case "duelAsked":
      duel.outgoing = {
        to: m.to,
        who: named(ctx, m.to),
        until: now + m.ttl,
        ttl: m.ttl,
      };
      emit();
      return true;
    case "duelNo": {
      // About the rematch (not a fresh challenge, nor your yes to one).
      const rematch =
        duel.result?.opponent === m.with &&
        duel.outgoing?.to !== m.with &&
        duel.answering !== m.with;
      const accepting = duel.answering === m.with;
      // Named as they were in the duel: they may have left the room since.
      const name =
        ctx.who(m.with)?.name ??
        (duel.result?.opponent === m.with ? duel.result.who.name : "Someone");
      if (duel.outgoing?.to === m.with) duel.outgoing = null;
      if (duel.answering === m.with) duel.answering = null;
      if (rematch && duel.result) {
        // The rematch is off.
        duel.result.rematchAsked = false;
        duel.result.rematchBy = false;
        duel.result.rematchUntil = null;
      }
      const text = refusalText(m.why, name, {
        ...(m.retryIn !== undefined ? { retryIn: m.retryIn } : {}),
        accepting,
        rematch,
      });
      if (text) fire({ k: "refused", text });
      emit();
      return true;
    }
    case "duelAskGone":
      if (duel.invite?.from === m.from) duel.invite = null;
      emit();
      return true;
    case "duelRematch":
      if (duel.result?.opponent === m.by) duel.result.rematchBy = true;
      fire({ k: "rematch", by: m.by, who: ctx.who(m.by) });
      emit();
      return true;
    case "duel": {
      const { t: _t, ...s } = m;
      const was = duel.rooms.get(s.id);
      if (was) {
        // A phase moved on (the fight, sudden death): the times and marks
        // as the room has them; health keeps its own messages.
        Object.assign(was, {
          phase: s.phase,
          startsAt: s.startsAt,
          suddenAt: s.suddenAt,
          endsAt: s.endsAt,
        });
        emit();
        return true;
      }
      const v = view(s, now);
      duel.rooms.set(s.id, v);
      const you = ctx.you();
      const mine = you !== null && (s.a === you || s.b === you);
      if (mine) {
        // Whatever was pending between anyone is moot now.
        duel.invite = null;
        duel.outgoing = null;
        duel.answering = null;
        duel.outUntil = null;
        duel.result = null;
        duel.hits = 0;
        duel.foe = named(ctx, s.a === you ? s.b : s.a);
      } else if (
        duel.invite &&
        (s.a === duel.invite.from || s.b === duel.invite.from)
      ) {
        duel.invite = null;
      }
      fire({ k: "start", duel: v, mine });
      emit();
      return true;
    }
    case "duelHp": {
      const d = duelOf(m.id);
      if (!d) return true;
      const was = d.health.get(m.id)?.hp ?? m.maxHp;
      d.health.set(m.id, { hp: m.hp, maxHp: m.maxHp });
      fire({ k: "hp", duel: d, id: m.id, hp: m.hp, was, maxHp: m.maxHp });
      emit();
      return true;
    }
    case "duelHit":
      if (!m.blocked) duel.hits++;
      fire({
        k: "hit",
        target: m.target,
        damage: m.damage,
        crit: m.crit,
        blocked: !!m.blocked,
      });
      return true;
    case "duelStun": {
      const d = duelOf(m.id);
      if (d) d.stuns.set(m.id, m.until);
      fire({ k: "stun", id: m.id, until: m.until });
      emit();
      return true;
    }
    case "duelOut":
      duel.outUntil = m.until;
      fire({ k: "out", until: m.until });
      emit();
      return true;
    case "duelAway": {
      const d = duelOf(m.id);
      if (d) {
        if (m.until === null) d.away.delete(m.id);
        else d.away.set(m.id, m.until);
      }
      fire({ k: "away", id: m.id, until: m.until, who: ctx.who(m.id) });
      emit();
      return true;
    }
    case "duelEnd": {
      const d = duel.rooms.get(m.id);
      const names = {
        a: named(ctx, m.a).name,
        b: named(ctx, m.b).name,
      };
      const you = ctx.you();
      let result: DuelResult | null = null;
      if (you !== null && (m.a === you || m.b === you)) {
        const opponent = m.a === you ? m.b : m.a;
        const tally = m.tally.find((x) => x.id === you);
        result = {
          id: m.id,
          opponent,
          who: named(ctx, opponent),
          won: m.winner === null ? null : m.winner === you,
          why: m.why,
          ms: m.ms,
          hits: tally?.hits ?? duel.hits,
          at: now,
          rematchUntil: m.rematchUntil ?? null,
          rematchAsked: false,
          rematchBy: false,
        };
        duel.result = result;
        duel.outUntil = null;
      }
      if (d) {
        d.phase = "over";
        d.endedAt = now;
        if (m.loser !== null)
          d.health.set(m.loser, {
            hp: 0,
            maxHp: d.health.get(m.loser)?.maxHp ?? 1,
          });
        fire({
          k: "end",
          duel: d,
          winner: m.winner,
          loser: m.loser,
          why: m.why,
          ms: m.ms,
          names,
          result,
        });
      }
      emit();
      return true;
    }
    default:
      return false;
  }
}

/** Ended duels whose rings have faded: gone. Called by the frame loop. */
export function pruneDuels(now: number): void {
  let changed = false;
  for (const [id, d] of duel.rooms) {
    if (d.endedAt !== null && now - d.endedAt > RING_FADE_MS) {
      duel.rooms.delete(id);
      changed = true;
    }
  }
  if (changed) emit();
}

/** Out of the room (another island, the Town closed): nothing of its duels
 * comes along. How your last one ended stays, for its banner. */
export function resetDuels(): void {
  duel.rooms.clear();
  duel.invite = null;
  duel.outgoing = null;
  duel.answering = null;
  duel.outUntil = null;
  duel.menu = null;
  if (duel.result) duel.result.rematchUntil = null;
  emit();
}

/** The challenge to you, answered here (the message goes from actions.ts). */
export function clearInvite(answered: number, yes: boolean): void {
  if (duel.invite?.from === answered) duel.invite = null;
  duel.answering = yes ? answered : null;
  emit();
}

export function clearOutgoing(): void {
  duel.outgoing = null;
  emit();
}

/** You asked for a rematch. */
export function markRematchAsked(): void {
  if (duel.result) duel.result.rematchAsked = true;
  emit();
}

/** The end panel closed. */
export function dismissResult(): void {
  duel.result = null;
  emit();
}

export function openPlayerMenu(id: number, x: number, y: number): void {
  duel.menu = { id, x, y };
  emit();
}

export function closePlayerMenu(): void {
  if (!duel.menu) return;
  duel.menu = null;
  emit();
}
