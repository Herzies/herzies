import { getItem } from "@herzies/shared";
import type { ServerMessage } from "@herzies/shared/town-net";
import {
  huntCharge,
  WILDS_CACHE_HOLD_MS,
  WILDS_DROP,
  type WildsCacheHold,
  type WildsCacheView,
  type WildsHunt,
} from "@herzies/shared/wilds-loot";
import { useSyncExternalStore } from "react";
import { notify } from "../../../lib/notices";
import { herzies } from "../../../tauri-bridge";
import { pushLootLog } from "../combat/lootFeed";

/**
 * The Wilds' loot as the client holds it: the cards lying where herzies
 * were taken down, the Hunt Crystal, the cache that's out, and who's
 * holding it. Written by {@link handleWildsLootMessage} from the socket;
 * read by the frame loop (WildsLoot.tsx and HuntCrystal.tsx draw it) and
 * through {@link useWildsLoot} (the HUD's CacheHud).
 *
 * A card stays where it lies until you choose to take it: standing within
 * reach of one you may take, the prompt offers it ({@link cardInReach};
 * "Pick up … [E]", see TownCanvas) and E asks the room for it, at most
 * once a while. Walking past leaves it there for whoever wants it. The
 * cache isn't asked for at all: it's held. Stand on your feet in its ring
 * long enough, alone, and the room opens it for you (the rule's in shared
 * wilds-loot.ts); the room tells everyone who's holding it on each change
 * ({@link CacheHold}) and the app counts on from there ({@link heldBy}).
 * Who gets what is the room's call alone (it judges reach, the killer's
 * first claim and who held the cache, and the database whether there's
 * room in the bag): nothing here grants anything. What a cache holds
 * comes as an ordinary `loot`, tossed out of it and picked up like a Tower
 * mob's (see combat/fight.ts and LootDrops).
 *
 * Framework-free apart from the hook.
 */

/** A card on the ground, its times on this machine's clock
 * (performance.now() ms). */
export type GroundCard = {
  id: string;
  item: string;
  level: number;
  x: number;
  z: number;
  /** Until `firstUntil` only entity `firstFor` (who took its owner down)
   * may take it. Null: anyone. */
  firstFor: number | null;
  firstUntil: number;
  /** When it goes back to its owner. */
  expiresAt: number;
  /** When it turned up here (it pops in). */
  at: number;
};

/** The cache that's out, and when it was seen (performance.now() ms). */
export type CacheSpot = WildsCacheView & { at: number };

/** The Hunt Crystal as the room last told it, `at` on this machine's
 * clock (see {@link huntNow}). */
export type HuntMeter = WildsHunt;

/** Who's holding the cache, as the room last told it (see
 * WildsCacheHold), `at` on this machine's clock. */
export type CacheHold = WildsCacheHold;

/** What the store needs from the connection. */
export type WildsLootContext = {
  /** A server time as performance.now() ms. */
  toLocal: (serverTime: number) => number;
  /** Your entity id in the room. */
  you: () => number | null;
  /** The map the welcome is for. */
  map: () => string;
  /** Where your herzie stands (for which way a cache is). */
  me: () => { x: number; z: number };
};

export const wildsLoot = {
  /** Your entity id on the Wilds (null elsewhere). */
  you: null as number | null,
  /** By drop id. */
  drops: new Map<string, GroundCard>(),
  cache: null as CacheSpot | null,
  /** Who's holding the cache out (null: nobody). */
  hold: null as CacheHold | null,
  /** The Hunt Crystal (null: no event on, or not on the Wilds). */
  hunt: null as HuntMeter | null,
  /** When a cache last turned up while you were there (performance.now()
   * ms): the crystal's burst. Not one that was out when you came. */
  huntOnAt: Number.NEGATIVE_INFINITY,
  /** The last cache opened while you were there: where it stood and when
   * (performance.now() ms), for its treasure crystal bursting. */
  opened: null as { x: number; z: number; at: number } | null,
};

/** Cards asked for and not answered: not asked again until then
 * (performance.now() ms), by drop id. */
const holds = new Map<string, number>();
/** When you were last told someone's opening the cache (it's said once
 * a while, not each time they step in). */
let warnedAt = Number.NEGATIVE_INFINITY;

/** No answer in this long: ask again. */
export const ASK_AGAIN_MS = 2_000;
/** Someone else's hold is said at most this often. */
export const HOLD_WARN_MS = 20_000;

// --- Change -----------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version++;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Re-renders when a card or the cache comes or goes. */
export function useWildsLoot(): number {
  return useSyncExternalStore(subscribe, () => version);
}

// --- Reading ----------------------------------------------------------------

/** Whether `you` may take card `d` at `now`: nobody's first claim on it,
 * or yours, or it's over. */
export function takeable(
  d: GroundCard,
  you: number | null,
  now: number,
): boolean {
  return d.firstFor === null || d.firstFor === you || now >= d.firstUntil;
}

/** The card E would pick up, standing at `me` at `now`: the nearest in
 * reach that you may take. Null: none (or you're down). */
export function cardInReach(
  me: { x: number; z: number },
  now: number,
  down: boolean,
): GroundCard | null {
  if (down) return null;
  let best: GroundCard | null = null;
  let reach: number = WILDS_DROP.reach;
  for (const d of wildsLoot.drops.values()) {
    const r = Math.hypot(d.x - me.x, d.z - me.z);
    if (r > reach || !takeable(d, wildsLoot.you, now)) continue;
    reach = r;
    best = d;
  }
  return best;
}

/** How long herzie `id` has held the cache at `now` (ms, up to
 * WILDS_CACHE_HOLD_MS), counted on from what the room last said: alone
 * it goes on, contested it stands. Null: it isn't holding it. */
export function heldBy(id: number | null, now: number): number | null {
  const h = wildsLoot.hold;
  if (!h || id === null) return null;
  for (const x of h.holders)
    if (x.id === id)
      return h.contested
        ? x.ms
        : Math.min(WILDS_CACHE_HOLD_MS, x.ms + Math.max(0, now - h.at));
  return null;
}

/** How full the Hunt Crystal is at `now` (performance.now() ms), 0 to 1,
 * counted on from what the room last said. */
export function huntNow(now: number): number {
  const h = wildsLoot.hunt;
  return h ? huntCharge(h, now) : 0;
}

/** The furthest anyone but `you` has held the cache at `now` (ms). Null:
 * nobody else is holding it. */
export function heldByOthers(you: number | null, now: number): number | null {
  const h = wildsLoot.hold;
  if (!h) return null;
  let best: number | null = null;
  for (const x of h.holders) {
    if (x.id === you) continue;
    const ms = heldBy(x.id, now) ?? 0;
    if (best === null || ms > best) best = ms;
  }
  return best;
}

/** Whether card `id` may be asked for at `now`: no ask for it still out. */
export function mayAsk(id: string, now: number): boolean {
  return now >= (holds.get(id) ?? Number.NEGATIVE_INFINITY);
}

/** Card `id` has been asked for (at `now`): not again till it's answered,
 * or a while has passed. */
export function asked(id: string, now: number): void {
  holds.set(id, now + ASK_AGAIN_MS);
}

/** Which way `to` lies from `from`, as a player reads it: "to the
 * north-east" (north is -z, the top of the map), or "close by". */
export function compassFrom(
  from: { x: number; z: number },
  to: { x: number; z: number },
): string {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 8) return "close by";
  // Clockwise from north.
  const a = Math.atan2(dx, -dz);
  const names = [
    "north",
    "north-east",
    "east",
    "south-east",
    "south",
    "south-west",
    "west",
    "north-west",
  ];
  const i = Math.round(a / (Math.PI / 4));
  return `to the ${names[(i + 8) % 8]}`;
}

/** "Lute +2", or "Lute". */
export function cardName(item: string, level: number): string {
  const name = getItem(item)?.name ?? item;
  return level > 0 ? `${name} +${level}` : name;
}

// --- Writing ----------------------------------------------------------------

function cardOf(
  d: Extract<ServerMessage, { t: "wildsDrop" }>["drop"],
  ctx: WildsLootContext,
  now: number,
): GroundCard {
  return {
    id: d.id,
    item: d.item,
    level: d.level,
    x: d.x,
    z: d.z,
    firstFor: d.firstFor,
    firstUntil: ctx.toLocal(d.firstUntil),
    expiresAt: ctx.toLocal(d.expiresAt),
    at: now,
  };
}

function dropCard(id: string) {
  wildsLoot.drops.delete(id);
  holds.delete(id);
}

function setCache(c: WildsCacheView | null, now: number) {
  const was = wildsLoot.cache;
  // Another cache (or none): nobody's holding it yet.
  if (was?.id !== c?.id) wildsLoot.hold = null;
  wildsLoot.cache =
    c === null ? null : was?.id === c.id ? was : { ...c, at: now };
}

function setHunt(h: WildsHunt | null | undefined, ctx: WildsLootContext) {
  wildsLoot.hunt = h ? { ...h, at: ctx.toLocal(h.at) } : null;
}

/** Who's holding the cache, from the room's word: its time made ours. */
function setHold(h: WildsCacheHold | null, ctx: WildsLootContext) {
  wildsLoot.hold =
    h && h.holders.length
      ? { holders: h.holders, contested: h.contested, at: ctx.toLocal(h.at) }
      : null;
}

/** Apply one server message. Returns whether it was the Wilds' loot's
 * alone (the welcome is everyone's). */
export function handleWildsLootMessage(
  m: ServerMessage,
  ctx: WildsLootContext,
): boolean {
  const now = performance.now();
  switch (m.t) {
    case "welcome":
      resetWildsLoot();
      wildsLoot.you = ctx.map() === "wilds" ? m.you : null;
      emit();
      return false;
    case "wildsLoot": {
      wildsLoot.drops.clear();
      for (const d of m.drops) wildsLoot.drops.set(d.id, cardOf(d, ctx, now));
      const fresh = m.cache !== null && m.cache.id !== wildsLoot.cache?.id;
      setCache(m.cache, now);
      setHold(m.cache && m.hold, ctx);
      setHunt(m.hunt, ctx);
      if (fresh && m.cache)
        notify(
          `The hunt is on: a cache is out ${compassFrom(ctx.me(), m.cache)}`,
          {
            kind: "info",
          },
        );
      emit();
      return true;
    }
    case "wildsHunt":
      setHunt(m.hunt, ctx);
      emit();
      return true;
    case "wildsDrop":
      wildsLoot.drops.set(m.drop.id, cardOf(m.drop, ctx, now));
      emit();
      return true;
    case "wildsGone":
      // Taken (yours says so in its `wildsTaken`) or back to its owner.
      dropCard(m.id);
      emit();
      return true;
    case "wildsCache": {
      const was = wildsLoot.cache;
      if (m.cache) {
        if (m.cache.id !== was?.id) {
          wildsLoot.huntOnAt = now;
          notify(
            `The Hunt Crystal is full! The hunt is on: a cache turned up ${compassFrom(ctx.me(), m.cache)}`,
            { kind: "success" },
          );
        }
      } else if (m.by !== undefined) {
        // Opened: its crystal bursts where it stood.
        if (was) wildsLoot.opened = { x: was.x, z: was.z, at: now };
        // By you (its loot's on its way), or by someone else.
        if (m.by === ctx.you())
          notify("You opened the cache", { kind: "success" });
        else
          notify(
            m.byName
              ? `"${m.byName}" opened the cache`
              : "Someone opened the cache",
            { kind: "info" },
          );
      }
      setCache(m.cache, now);
      emit();
      return true;
    }
    case "wildsHold": {
      const c = wildsLoot.cache;
      if (!c || c.id !== m.id) return true;
      const you = ctx.you();
      const before = heldByOthers(you, now) !== null;
      setHold(m, ctx);
      // Someone else has stepped up to open it while you're not: where
      // (said once a while, however often they step in and out).
      if (
        !before &&
        heldByOthers(you, now) !== null &&
        heldBy(you, now) === null &&
        now - warnedAt >= HOLD_WARN_MS
      ) {
        warnedAt = now;
        notify(`Someone's opening the cache ${compassFrom(ctx.me(), c)}`, {
          kind: "info",
        });
      }
      emit();
      return true;
    }
    case "wildsTaken": {
      const name = cardName(m.item, m.level);
      notify(`You took "${name}"`, { kind: "success" });
      pushLootLog(`Took "${name}" on the Wilds`);
      // The room moved it into your bag in the database, behind the app's
      // back: bring the bag up to date now, not at the next sync (up to
      // 10 s off with the window focused, a minute hidden).
      herzies.fetchInventory().catch(() => {});
      return true;
    }
    case "wildsLost": {
      const name = cardName(m.item, m.level);
      notify(`You dropped "${name}"`, { kind: "info" });
      pushLootLog(`Dropped "${name}" when taken down on the Wilds`);
      // Out of your bag the same way (into escrow on the ground).
      herzies.fetchInventory().catch(() => {});
      return true;
    }
    case "wildsRefused": {
      const d = wildsLoot.drops.get(m.id);
      const cache = wildsLoot.cache?.id === m.id;
      // A card's answered: E asks again.
      holds.delete(m.id);
      if (m.why === "gone") {
        dropCard(m.id);
        if (cache) setCache(null, now);
        emit();
      } else if (m.why === "bag-full") {
        notify(
          d
            ? `Your bag is full: no room for "${cardName(d.item, d.level)}"`
            : "Your bag is full: make room to open the cache",
        );
      } else if (d) {
        // Out of reach, or still the other's (as the room's clock has it),
        // or someone else's take is out: you asked, so say.
        notify(`Couldn't pick up "${cardName(d.item, d.level)}" just now`);
      } else if (cache) {
        // You held it out, but the room couldn't open it just now: it asks
        // again once you've held on a moment more.
        notify("The cache didn't open just yet: hold on a moment more");
      }
      return true;
    }
    default:
      return false;
  }
}

/** Off the Wilds (another island, the Town closed): its loot stays there. */
export function resetWildsLoot(): void {
  wildsLoot.you = null;
  wildsLoot.drops.clear();
  wildsLoot.cache = null;
  wildsLoot.hold = null;
  wildsLoot.hunt = null;
  wildsLoot.huntOnAt = Number.NEGATIVE_INFINITY;
  wildsLoot.opened = null;
  warnedAt = Number.NEGATIVE_INFINITY;
  holds.clear();
  emit();
}
