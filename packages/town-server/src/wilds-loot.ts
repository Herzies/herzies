/**
 * The Wilds' loot, as a Wilds room keeps it (see shared wilds-loot.ts):
 * the card a herzie taken down drops where it fell, the Hunt Crystal that
 * listening fills while the "wilds" event runs, and the cache it brings
 * out once it's full.
 *
 * The database holds what's real: a dropped card sits in escrow there from
 * the moment it falls, and a cache is opened once, by id. The room judges
 * who may reach for a drop (in reach, on their feet, the killer's moment
 * alone with it, one take at a time), who's listening (each says so; see
 * `tune`) and who holds the cache (it watches who stands in its ring, and
 * opens it for the first to hold it out), tells everyone what's lying
 * about, how full the crystal is and who's holding what, and gives
 * unclaimed drops back to their owners when their time is up. Drops don't
 * survive a room going to sleep, and needn't: the database gives back a
 * drop nobody returned once its life is over. The crystal and the cache
 * out do (see HuntStore); a room with anyone listening doesn't sleep, and
 * a hold cut short by a sleep just starts over.
 *
 * Like the free-for-all it's pure: the room injects the database, who's
 * where, a clock and ids, and relays what it emits. Calls that ask the
 * database resolve once it has answered (tests await them).
 */
import type {
  ServerMessage,
  TownTicketPayload,
} from "@herzies/shared/town-net";
import {
  huntCharge,
  huntRate,
  WILDS_CACHE_HOLD_MS,
  WILDS_CACHE_HOLD_RADIUS,
  WILDS_DROP,
  type WildsCacheHold,
  type WildsCacheView,
  type WildsGroundDrop,
  type WildsHunt,
  type WildsLootRefusal,
  wildsCacheId,
  wildsCacheSpot,
} from "@herzies/shared/wilds-loot";
import type { Outbound } from "./fight";
import { all, round, to } from "./pvp";
import type { WildsLootDb } from "./vitals";
import type { WildsDown } from "./wilds";

/** A ticket's wilds claim: the event on now and its window (ms). */
export type WildsClaim = NonNullable<TownTicketPayload["wilds"]>;

/** A herzie in the room, as the loot needs it: its entity id and name,
 * where the room has it, and whether it's down in the free-for-all. */
export type WildsLootPeer = {
  id: number;
  name: string;
  x: number;
  z: number;
  down: boolean;
};

/** What's kept of the Hunt Crystal over a room's sleep (a room only
 * sleeps with nobody listening, so it isn't filling): the event it's for,
 * its charge, how many caches it has brought out, and the one out. */
export type HuntSaved = {
  event: string;
  charge: number;
  k: number;
  cache: WildsCacheView | null;
};

/** Where the room keeps HuntSaved (its Durable Object's storage). */
export type HuntStore = {
  load: () => HuntSaved | undefined;
  save: (h: HuntSaved) => void;
};

/** What the room gives the loot. */
export type WildsLootDeps = {
  /** This room's shard (each has its own crystal and caches). */
  shard: number;
  db: WildsLootDb;
  /** The herzie `uid` here, or null if it isn't. */
  peer: (uid: string) => WildsLootPeer | null;
  /** Every herzie here, by user id (who might be holding the cache, or
   * listening). */
  here: () => Iterable<[uid: string, peer: WildsLootPeer]>;
  /** Tell whom what (relayed by the room, now or when the database
   * answers). */
  emit: (o: Outbound) => void;
  /** Server ms, for when an answer arrives. */
  clock?: () => number;
  /** A fresh drop id. */
  newId?: () => string;
  /** Where the crystal's kept over a sleep (none: it isn't). */
  store?: HuntStore;
};

/** Room-side slack on reach (world units): the room's idea of where you
 * stand is a frame or two behind your app's. A holder keeps the cache's
 * ring this much past its edge, too, so a herzie standing on the line
 * isn't in and out of it every tick. */
export const LOOT_REACH_SLACK = 0.5;
/** A change to who's holding the cache is told at most this often (ms):
 * what's said carries its own time, so a late word still counts right. */
export const HOLD_TELL_MS = 250;
/** A hold the database didn't answer drops back this far (ms), so the
 * holder asks again once they've held that much longer. */
export const HOLD_RETRY_MS = 2_000;
/** The most a hold counts on between two steps (ms): a stalled room
 * doesn't hand anyone a cache it didn't watch them hold. */
const HOLD_STEP_MAX_MS = 1_000;

/** A drop as the room keeps it: whose it was, and who took them down (by
 * user id: an entity id may be someone else's by the time it's asked). */
type HeldDrop = WildsGroundDrop & { owner: string; killer: string | null };

/** A takedown the database hasn't answered yet: asked again each sweep,
 * until its drop would have gone back anyway. */
type Unasked = {
  id: string;
  event: string;
  victim: string;
  victimId: number;
  killer: string;
  x: number;
  z: number;
  since: number;
};

type Cache = WildsCacheView & { event: string };

/** The Hunt Crystal: the event it's for, its charge at `at` (server ms)
 * and how fast it has filled since, how many were listening then, and how
 * many caches it has brought out this event (where the next turns up). */
type Hunt = {
  event: string;
  charge: number;
  rate: number;
  at: number;
  listeners: number;
  k: number;
};

/** A herzie holding the cache: its entity id, how long it has held (ms),
 * the step it stepped into the ring and the step it was last seen in it. */
type Holder = { id: number; ms: number; since: number; seen: number };

export class WildsLootRuntime {
  /** The event this room's loot is for: the newest any ticket claimed. */
  private claim: WildsClaim | null = null;
  /** Each herzie here's own claim, for who's on the Wilds (presence). */
  private claims = new Map<string, WildsClaim>();
  private drops = new Map<string, HeldDrop>();
  private unasked = new Map<string, Unasked>();
  private asking = new Set<string>();
  /** Drops with a take, or a return, in flight. */
  private taking = new Set<string>();
  private returning = new Set<string>();
  /** The cache out now (announced), and the one being opened. */
  private cache: Cache | null = null;
  private opening: string | null = null;
  /** The Hunt Crystal (null: no event on); who's said they're playing
   * music, by user id; and what a sleep left, till the event's back. */
  private hunt: Hunt | null = null;
  private tuned = new Set<string>();
  private saved: HuntSaved | undefined;
  /** Who's holding the cache out, by user id; whether it's contested;
   * when the holds last counted (server ms); a change not told yet, and
   * when they were last told; and the steps counted, to see who's gone. */
  private holds = new Map<string, Holder>();
  private contested = false;
  private heldAt = 0;
  private holdUntold = false;
  private holdToldAt = Number.NEGATIVE_INFINITY;
  private steps = 0;
  /** Database calls in flight. */
  private inFlight = 0;
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: WildsLootDeps) {
    this.clock = deps.clock ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.saved = deps.store?.load();
  }

  /** The event the loot is for (null: no "wilds" event claimed yet). */
  get event(): WildsClaim | null {
    return this.claim;
  }

  /** Something to keep the room awake for: drops lying about (lost to a
   * sleep otherwise, and only given back lazily), a database call still
   * out, someone holding the cache (it's watched every tick), or the
   * crystal filling (it overflows into a cache on a tick). */
  get live(): boolean {
    return (
      this.drops.size > 0 ||
      this.unasked.size > 0 ||
      this.inFlight > 0 ||
      this.holds.size > 0 ||
      this.holdUntold ||
      (this.hunt?.rate ?? 0) > 0
    );
  }

  // --- Who's here.

  /** `uid`'s ticket's wilds claim (on arrival, and each renewal; absent:
   * no event on for it). The room's event is the newest claimed: a later
   * window replaces it, the same event's window is kept up to date. */
  claimFor(uid: string, c: WildsClaim | undefined): void {
    if (!isClaim(c)) {
      this.claims.delete(uid);
      return;
    }
    this.claims.set(uid, c);
    const was = this.claim;
    if (!was || c.event === was.event || c.startsAt > was.startsAt)
      this.claim = c;
  }

  /** `uid` left the room. */
  leave(uid: string): void {
    this.claims.delete(uid);
    this.tuned.delete(uid);
  }

  /** Whether `uid` is playing music (said when it changes, and on each
   * arrival): listening on the Wilds fills the crystal. */
  tune(uid: string, playing: boolean, now: number): void {
    if (playing) this.tuned.add(uid);
    else this.tuned.delete(uid);
    this.fill(now);
  }

  /** Who's on the Wilds for the room's event, while it's on: every herzie
   * here whose ticket claims it (sent with the 30 s sweep's report). */
  presence(now: number): { event: string; uids: string[] } | null {
    const e = this.claim;
    if (!e || now < e.startsAt || now >= e.endsAt) return null;
    const uids: string[] = [];
    for (const [uid, c] of this.claims) if (c.event === e.event) uids.push(uid);
    return uids.length ? { event: e.event, uids } : null;
  }

  /** The loot as it lies, for a newcomer (right after its welcome). */
  snapshot(now: number): Extract<ServerMessage, { t: "wildsLoot" }> {
    const drops: WildsGroundDrop[] = [];
    for (const d of this.drops.values())
      if (now < d.expiresAt) drops.push(groundView(d));
    return {
      t: "wildsLoot",
      drops,
      cache: this.cache && cacheView(this.cache),
      hold: this.cache && this.holds.size ? this.holdView(this.heldAt) : null,
      hunt: this.huntView(now),
    };
  }

  // --- The clock.

  /** The crystal: filled on by whoever's listening, a cache turned up
   * when it's full (everyone's told), or a new event's (or none) and the
   * cache out gone with the last; and who's holding the cache (see
   * `hold`). Cheap: the room runs it every tick and every sweep. Returns
   * the cache's opening, if a hold just ran out and asked the database
   * (resolved once it has answered). */
  step(now: number): Promise<void> | undefined {
    this.fill(now);
    const dt = Math.min(HOLD_STEP_MAX_MS, Math.max(0, now - this.heldAt));
    this.heldAt = now;
    return this.cache ? this.hold(this.cache, dt, now) : undefined;
  }

  /** The room's 30 s sweep: the cache as `step`, drops past their life go
   * back to their owners, and takedowns the database didn't answer are
   * asked again. Resolves once the database has answered. */
  async sweep(now: number): Promise<void> {
    const opening = this.step(now);
    const asks: Promise<void>[] = [];
    for (const u of this.unasked.values()) {
      if (this.asking.has(u.id)) continue;
      if (now - u.since > WILDS_DROP.lifeMs) this.unasked.delete(u.id);
      else asks.push(this.askDrop(u));
    }
    await Promise.all([...asks, this.giveBack(now), opening]);
  }

  // --- Taken down.

  /** `d.victim` was taken down (or left mid-fight): while the event's on,
   * the database drops one random card from its bag where it fell, and
   * everyone hears of it. Resolves once the database has answered (an
   * unanswered one is asked again on the sweep). */
  async takedown(d: WildsDown, now: number): Promise<void> {
    const e = this.claim;
    if (!e || now < e.startsAt || now >= e.endsAt) return;
    const u: Unasked = {
      id: this.newId(),
      event: e.event,
      victim: d.victim,
      victimId: d.victimId,
      killer: d.killer,
      x: round(d.at.x),
      z: round(d.at.z),
      since: now,
    };
    this.unasked.set(u.id, u);
    await this.askDrop(u);
  }

  private async askDrop(u: Unasked): Promise<void> {
    this.asking.add(u.id);
    this.inFlight++;
    const reply = await this.deps.db
      .drop({
        id: u.id,
        event: u.event,
        victim: u.victim,
        killer: u.killer,
        x: u.x,
        z: u.z,
      })
      .finally(() => {
        this.inFlight--;
        this.asking.delete(u.id);
      });
    if (!reply || !this.unasked.has(u.id)) return;
    this.unasked.delete(u.id);
    if (!reply.drop || this.drops.has(u.id)) return;
    const now = this.clock();
    const killer = this.deps.peer(u.killer);
    const drop: HeldDrop = {
      id: u.id,
      item: reply.drop.item,
      level: reply.drop.level,
      x: u.x,
      z: u.z,
      firstFor: killer?.id ?? null,
      firstUntil: now + WILDS_DROP.killerFirstMs,
      expiresAt: now + WILDS_DROP.lifeMs,
      owner: u.victim,
      killer: killer ? u.killer : null,
    };
    this.drops.set(drop.id, drop);
    this.deps.emit(
      all({ t: "wildsDrop", drop: groundView(drop), from: u.victimId }),
    );
    this.deps.emit(
      to(u.victim, { t: "wildsLost", item: drop.item, level: drop.level }),
    );
  }

  /**
   * `uid` reaches for drop `id`: on its feet, in reach, and (for the
   * first WILDS_DROP.killerFirstMs) only the one who took its owner down.
   * The database moves it into their bag if there's room. Refused (to
   * them alone): `gone` (taken, given back, past its life), `down`, `far`,
   * `not-yet` (the killer's moment, someone else's take still out, or the
   * database didn't answer: try again), `bag-full`.
   */
  async take(uid: string, id: string, now: number): Promise<void> {
    const refuse = (why: WildsLootRefusal) =>
      this.deps.emit(to(uid, { t: "wildsRefused", id, why }));
    const d = this.drops.get(id);
    if (!d || now >= d.expiresAt || this.returning.has(id))
      return refuse("gone");
    const p = this.deps.peer(uid);
    if (!p) return;
    if (p.down) return refuse("down");
    if (Math.hypot(p.x - d.x, p.z - d.z) > WILDS_DROP.reach + LOOT_REACH_SLACK)
      return refuse("far");
    if (d.killer !== null && d.killer !== uid && now < d.firstUntil)
      return refuse("not-yet");
    if (this.taking.has(id)) return refuse("not-yet");
    this.taking.add(id);
    this.inFlight++;
    const reply = await this.deps.db.take(id, uid).finally(() => {
      this.inFlight--;
      this.taking.delete(id);
    });
    if (!reply) return refuse("not-yet");
    if (!reply.ok && reply.why === "bag-full") return refuse("bag-full");
    // Taken (by them, or it went some other way): off the ground.
    this.drops.delete(id);
    if (reply.ok) {
      const by = this.deps.peer(uid)?.id ?? null;
      this.deps.emit(all({ t: "wildsGone", id, by }));
      this.deps.emit(
        to(uid, { t: "wildsTaken", item: reply.item, level: reply.level }),
      );
    } else {
      this.deps.emit(all({ t: "wildsGone", id, by: null }));
      refuse("gone");
    }
  }

  /** Drops past their life go back to their owners. A failed ask keeps
   * them for the next sweep. */
  private async giveBack(now: number): Promise<void> {
    const ids: string[] = [];
    for (const d of this.drops.values())
      if (
        now >= d.expiresAt &&
        !this.taking.has(d.id) &&
        !this.returning.has(d.id)
      )
        ids.push(d.id);
    if (!ids.length) return;
    for (const id of ids) this.returning.add(id);
    this.inFlight++;
    const reply = await this.deps.db.giveBack(ids).finally(() => {
      this.inFlight--;
      for (const id of ids) this.returning.delete(id);
    });
    if (!reply) return;
    const back = new Set(reply.returned);
    // Those not given back were taken or returned already: gone either way.
    for (const id of ids) {
      if (!this.drops.delete(id)) continue;
      this.deps.emit(
        all({
          t: "wildsGone",
          id,
          by: null,
          ...(back.has(id) ? { back: true as const } : {}),
        }),
      );
    }
  }

  // --- The Hunt Crystal.

  /**
   * The crystal at `now`: filled on at the rate it had since it was last
   * looked at, a cache brought out once it's full, and its rate set by
   * who's listening now (none while its cache is out). Each herzie here
   * playing music, with a ticket for the event, counts. A new event's
   * crystal starts dull (or as a sleep left it), with nothing out; there's
   * none between events. Everyone's told of each change (`told`: there's
   * one already), and it's kept for a sleep.
   */
  private fill(now: number, told = false): void {
    const e = this.claim;
    const event = e && now >= e.startsAt && now < e.endsAt ? e.event : null;
    if ((this.hunt?.event ?? null) !== event) {
      const saved = this.saved?.event === event ? this.saved : undefined;
      this.saved = undefined;
      this.hunt =
        event === null
          ? null
          : {
              event,
              charge: saved?.charge ?? 0,
              rate: 0,
              at: now,
              listeners: 0,
              k: saved?.k ?? 0,
            };
      this.setCache(saved?.cache && event ? { ...saved.cache, event } : null);
      told = true;
    }
    const h = this.hunt;
    if (h) {
      if (!this.cache)
        h.charge = Math.min(1, h.charge + h.rate * Math.max(0, now - h.at));
      h.at = Math.max(h.at, now);
      if (!this.cache && h.charge >= 1) {
        const spot = wildsCacheSpot(h.event, h.k++);
        this.setCache({
          id: wildsCacheId(h.event, h.at, this.deps.shard),
          ...spot,
          event: h.event,
        });
        told = true;
      }
      let listeners = 0;
      for (const [uid] of this.deps.here())
        if (this.tuned.has(uid) && this.claims.get(uid)?.event === h.event)
          listeners++;
      const rate = this.cache ? 0 : huntRate(listeners);
      if (listeners !== h.listeners || rate !== h.rate) {
        h.listeners = listeners;
        h.rate = rate;
        told = true;
      }
    }
    if (!told) return;
    this.deps.emit(all({ t: "wildsHunt", hunt: this.huntView(now) }));
    if (h)
      this.deps.store?.save({
        event: h.event,
        charge: h.charge,
        k: h.k,
        cache: this.cache && cacheView(this.cache),
      });
  }

  /** The cache out was opened (or found opened): the crystal starts again
   * from dull, as of when it was last looked at. */
  private spend(): void {
    const h = this.hunt;
    if (!h) return;
    h.charge = 0;
    this.fill(h.at, true);
  }

  /** The crystal as the room tells it, at `now`. */
  private huntView(now: number): WildsHunt | null {
    const h = this.hunt;
    if (!h) return null;
    const at = Math.max(h.at, now);
    return {
      charge: Math.round(huntCharge(h, at) * 1e4) / 1e4,
      rate: h.rate,
      at,
      listeners: h.listeners,
    };
  }

  /** The cache out is now `next` (null: none): everyone's told, and a new
   * one's ring starts empty (its `wildsCache` says so). */
  private setCache(next: Cache | null): void {
    if ((next?.id ?? null) === (this.cache?.id ?? null)) return;
    this.cache = next;
    this.letGo();
    this.deps.emit(all({ t: "wildsCache", cache: next && cacheView(next) }));
  }

  // --- Caches.

  /**
   * Who's holding cache `c`, `dt` ms on. Each herzie up within
   * WILDS_CACHE_HOLD_RADIUS holds it (once in, it may stand a little past
   * the edge); out of the ring, down or gone from the room, its hold is
   * over and starts from nothing next time. Two or more holding: contested,
   * nobody's counts on. One alone: theirs does, and at WILDS_CACHE_HOLD_MS
   * the database is asked to open it for them (one ask at a time; holds
   * stand still while it's out). Changes are told to the room, at most
   * every HOLD_TELL_MS; the counting itself isn't (the app counts on from
   * what it was told).
   */
  private hold(c: Cache, dt: number, now: number): Promise<void> | undefined {
    const step = ++this.steps;
    for (const [uid, p] of this.deps.here()) {
      const h = this.holds.get(uid);
      const reach = WILDS_CACHE_HOLD_RADIUS + (h ? LOOT_REACH_SLACK : 0);
      if (p.down || Math.hypot(p.x - c.x, p.z - c.z) > reach) continue;
      if (!h) {
        this.holds.set(uid, { id: p.id, ms: 0, since: step, seen: step });
        this.holdUntold = true;
        continue;
      }
      h.seen = step;
      if (h.id !== p.id) {
        h.id = p.id;
        this.holdUntold = true;
      }
    }
    for (const [uid, h] of this.holds)
      if (h.seen !== step) {
        this.holds.delete(uid);
        this.holdUntold = true;
      }
    const contested = this.holds.size > 1;
    if (contested !== this.contested) {
      this.contested = contested;
      this.holdUntold = true;
    }
    let opening: Promise<void> | undefined;
    if (!contested && !this.opening)
      for (const [uid, h] of this.holds) {
        // Stepping in counts from the next step on.
        if (h.since !== step) h.ms = Math.min(WILDS_CACHE_HOLD_MS, h.ms + dt);
        if (h.ms >= WILDS_CACHE_HOLD_MS) opening = this.open(uid, c);
      }
    if (this.holdUntold && now - this.holdToldAt >= HOLD_TELL_MS) {
      this.holdUntold = false;
      this.holdToldAt = now;
      this.deps.emit(all({ t: "wildsHold", id: c.id, ...this.holdView(now) }));
    }
    return opening;
  }

  /** The holds as the room tells them, as they stood at `at`. */
  private holdView(at: number): WildsCacheHold {
    const holders: WildsCacheHold["holders"] = [];
    for (const h of this.holds.values()) holders.push({ id: h.id, ms: h.ms });
    return { holders, contested: this.contested, at };
  }

  /** Nobody's holding anything (the cache went, or a new one came). */
  private letGo(): void {
    this.holds.clear();
    this.contested = false;
    this.holdUntold = false;
  }

  /**
   * `uid` held cache `c` out: the database opens it once. The first gets
   * its loot (as pending drops, picked up the usual way), and everyone
   * hears who. No answer: refused `not-yet`, the cache stays and their
   * hold drops back HOLD_RETRY_MS (to ask again once they've held that
   * much more). Opened already (the database says so): `gone`.
   */
  private async open(uid: string, c: Cache): Promise<void> {
    const refuse = (why: WildsLootRefusal) =>
      this.deps.emit(to(uid, { t: "wildsRefused", id: c.id, why }));
    this.opening = c.id;
    this.inFlight++;
    const reply = await this.deps.db
      .cache({ id: c.id, event: c.event, uid, x: c.x, z: c.z })
      .finally(() => {
        this.inFlight--;
        this.opening = null;
      });
    // Still the one out (not already replaced by the next)?
    const current = this.cache?.id === c.id;
    if (!reply) {
      const h = current ? this.holds.get(uid) : undefined;
      if (h) {
        h.ms = WILDS_CACHE_HOLD_MS - HOLD_RETRY_MS;
        this.holdUntold = true;
      }
      return refuse("not-yet");
    }
    if (current) {
      this.cache = null;
      this.letGo();
    }
    if (reply.opened) {
      const by = this.deps.peer(uid);
      if (current)
        this.deps.emit(
          all({
            t: "wildsCache",
            cache: null,
            ...(by ? { by: by.id, byName: by.name } : {}),
          }),
        );
      this.deps.emit(
        to(uid, { t: "loot", drops: reply.drops, at: { x: c.x, z: c.z } }),
      );
    } else {
      if (current) this.deps.emit(all({ t: "wildsCache", cache: null }));
      refuse("gone");
    }
    // Its hunt's over: the crystal goes dull, and fills again from there.
    if (current) this.spend();
  }
}

function isClaim(c: unknown): c is WildsClaim {
  const w = c as Partial<WildsClaim> | null | undefined;
  return (
    !!w &&
    typeof w.event === "string" &&
    Number.isFinite(w.startsAt) &&
    Number.isFinite(w.endsAt)
  );
}

function groundView(d: HeldDrop): WildsGroundDrop {
  return {
    id: d.id,
    item: d.item,
    level: d.level,
    x: d.x,
    z: d.z,
    firstFor: d.firstFor,
    firstUntil: d.firstUntil,
    expiresAt: d.expiresAt,
  };
}

function cacheView(c: Cache): WildsCacheView {
  return { id: c.id, x: c.x, z: c.z };
}
