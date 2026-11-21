/**
 * The Town server's line to `town-vitals`: signed with the ticket secret,
 * since the Worker has no database access. Failures are logged and dropped;
 * what's lost is a few seconds of bench regen, and a fight's HP re-sends on
 * the next report.
 */
import {
  type BossPlace,
  type LootDrop,
  signVitalsRequest,
} from "@herzies/shared/town-net";
import type { DuelResult } from "./duel";
import type { FightReport, RaidReply } from "./fight";
import type { Env } from "./room";

/** A report: a fight's (see FightReport: HP, boss damage, skill XP, the
 * end screen, the Tower, and the raid's lock, revives, outs and wipe) and/or
 * bench rest. */
export type VitalsReport = {
  action: "report";
  /** Extra HP earned resting on a bench. */
  rest?: { uid: string; bonus: number }[];
  /** Who's on the Wilds for `event` now (the room's 30 s sweep): each
   * gets the Wilds' listening bonus for WILDS_PRESENCE_MS. */
  wilds?: { event: string; uids: string[] };
} & Partial<FightReport>;

/** What `town-vitals` answers. Only the boss part is read: `loot` is set
 * on the report that found the boss dead (see 00105). */
export type VitalsReply = {
  boss?: {
    hp: number;
    killed: boolean;
    loot?: Record<string, LootDrop[]> | null;
  } | null;
  /** Where the reported skills stand now, after the XP. */
  skills?: {
    levels: { uid: string; skill: string; level: number }[];
  } | null;
  /** The end screen's table, if it was asked for: the top ten, and each
   * asked-about herzie's place by user id (none if they dealt nothing). */
  results?: { top: BossPlace[]; you: Record<string, BossPlace> } | null;
  /** What the Tower batch's kills dropped, and its chest held (both empty
   * on a replay: they were handed out the first time). */
  tower?: { drops: LootDrop[]; chest?: LootDrop[] } | null;
  /** The raid as the database holds it: its lock, refused revives, and
   * who's out (00122). */
  raid?: RaidReply | null;
};

/** Send a report. Resolves with the reply if `town-vitals` took it, else
 * null. A room with no `TOWN_VITALS_URL` (local dev, most tests) reports
 * nothing. */
export async function postVitals(
  env: Pick<Env, "TOWN_TICKET_SECRET" | "TOWN_VITALS_URL">,
  report: VitalsReport,
): Promise<VitalsReply | null> {
  return (await signedPost(env, report)) as VitalsReply | null;
}

/** What `town-vitals` says about a fighter's `eat`: whether a copy was
 * used up, and how much it heals. */
export type EatReply = { ok: boolean; heal: number; reason: string | null };

/** Use up one `item` from `uid`'s bank (00113 eat_item, HP untouched: the
 * fight heals). Null when it couldn't be asked, which eats nothing. Never
 * retried, so a lost reply can't eat twice. */
export async function eatInDb(
  env: Pick<Env, "TOWN_TICKET_SECRET" | "TOWN_VITALS_URL">,
  uid: string,
  item: string,
): Promise<EatReply | null> {
  const reply = (await signedPost(env, {
    action: "eat",
    uid,
    item,
  })) as Partial<EatReply> | null;
  if (!reply) return null;
  return {
    ok: !!reply.ok,
    heal: Number(reply.heal) || 0,
    reason: reply.reason ?? null,
  };
}

/** A Bard's resurrect outside a raid: bring `uid` back with `health`. True
 * if the database did (they were down); false or null otherwise. Never
 * retried: a resurrect that didn't land is played again. */
export async function reviveInDb(
  env: Pick<Env, "TOWN_TICKET_SECRET" | "TOWN_VITALS_URL">,
  uid: string,
  health: number,
): Promise<boolean> {
  const reply = (await signedPost(env, {
    action: "revive",
    uid,
    health,
  })) as { ok?: boolean } | null;
  return !!reply?.ok;
}

/** A finished duel, for its tallies and titles. Fire-and-forget: the edge
 * function is replay-safe on the duel's id, and a duel lost in the post
 * costs nothing but a title's progress. */
export async function postDuel(
  env: Pick<Env, "TOWN_TICKET_SECRET" | "TOWN_VITALS_URL">,
  result: DuelResult,
): Promise<void> {
  await signedPost(env, { action: "duel", ...result });
}

/** A card a herzie taken down on the Wilds dropped, as the database holds
 * it in escrow. */
export type WildsEscrow = { id: string; item: string; level: number };

/** `town-vitals` on a take: in the taker's bag, or why not. */
export type WildsTakeReply =
  | { ok: true; item: string; level: number }
  | { ok: false; why: "bag-full" | "gone" };

/** `town-vitals` on opening a cache: the opener's loot (pending drops),
 * or `opened` false (and nothing) if it was opened already. */
export type WildsCacheReply = { opened: boolean; drops: LootDrop[] };

/** What the Wilds' loot asks the database (00154, through `town-vitals`).
 * Each resolves null when it couldn't be asked (or the reply made no
 * sense), which leaves everything as it was: every one is idempotent on
 * its ids, so the room may simply ask again. */
export type WildsLootDb = {
  /** Escrow one random card from `victim`'s bag under drop `id` (made by
   * the room). `drop` null: nothing to drop (an empty bag, or `event`
   * isn't the wilds event on now). */
  drop(r: {
    id: string;
    event: string;
    victim: string;
    killer: string | null;
    x: number;
    z: number;
  }): Promise<{ drop: WildsEscrow | null } | null>;
  /** Move escrowed drop `id` into `uid`'s bag. */
  take(id: string, uid: string): Promise<WildsTakeReply | null>;
  /** Give unclaimed drops back to their owners: the ids that went back
   * (the rest were taken or returned already). */
  giveBack(ids: string[]): Promise<{ returned: string[] } | null>;
  /** Open cache `id` for `uid`: its loot as pending drops, or `opened`
   * false if someone got there first. */
  cache(r: {
    id: string;
    event: string;
    uid: string;
    x: number;
    z: number;
  }): Promise<WildsCacheReply | null>;
};

/** The Wilds' loot's line to the database, signed like every report. */
export function wildsLootDb(
  env: Pick<Env, "TOWN_TICKET_SECRET" | "TOWN_VITALS_URL">,
): WildsLootDb {
  return {
    async drop(r) {
      const reply = (await signedPost(env, {
        action: "wildsDrop",
        ...r,
      })) as { drop?: Partial<WildsEscrow> | null } | null;
      if (!reply || reply.drop === undefined) return null;
      const d = reply.drop;
      if (d === null) return { drop: null };
      if (typeof d.item !== "string") return null;
      return {
        drop: { id: String(d.id ?? r.id), item: d.item, level: level(d.level) },
      };
    },
    async take(id, uid) {
      const reply = (await signedPost(env, {
        action: "wildsTake",
        id,
        uid,
      })) as {
        ok?: boolean;
        item?: unknown;
        level?: unknown;
        why?: unknown;
      } | null;
      if (!reply) return null;
      if (reply.ok === true && typeof reply.item === "string")
        return { ok: true, item: reply.item, level: level(reply.level) };
      if (
        reply.ok === false &&
        (reply.why === "bag-full" || reply.why === "gone")
      )
        return { ok: false, why: reply.why };
      return null;
    },
    async giveBack(ids) {
      const reply = (await signedPost(env, {
        action: "wildsReturn",
        ids,
      })) as { returned?: unknown } | null;
      if (!reply || !Array.isArray(reply.returned)) return null;
      return { returned: reply.returned.map(String) };
    },
    async cache(r) {
      const reply = (await signedPost(env, {
        action: "wildsCache",
        ...r,
      })) as { opened?: unknown; drops?: unknown } | null;
      if (!reply || typeof reply.opened !== "boolean") return null;
      const drops = Array.isArray(reply.drops)
        ? (reply.drops as LootDrop[]).filter(
            (d) => typeof d?.id === "string" && typeof d?.item === "string",
          )
        : [];
      return { opened: reply.opened, drops: reply.opened ? drops : [] };
    },
  };
}

/** An upgrade level from a reply: a whole number, 0 if it's missing. */
function level(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** POST `payload` to `town-vitals`, signed. The reply's JSON, or null on
 * any failure (logged). */
/** How long a `town-vitals` call may take before it's given up on (and
 * retried by the next report). */
const VITALS_TIMEOUT_MS = 5_000;

async function signedPost(
  env: Pick<Env, "TOWN_TICKET_SECRET" | "TOWN_VITALS_URL">,
  payload: unknown,
): Promise<unknown> {
  if (!env.TOWN_VITALS_URL) return null;
  const body = JSON.stringify(payload);
  const ts = Date.now();
  const nonce = crypto.randomUUID();
  try {
    const res = await fetch(env.TOWN_VITALS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vitals-ts": String(ts),
        "x-vitals-nonce": nonce,
        "x-vitals-sig": await signVitalsRequest(
          body,
          ts,
          nonce,
          env.TOWN_TICKET_SECRET,
        ),
      },
      body,
      // A hung request would hold up every report after it.
      signal: AbortSignal.timeout(VITALS_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.log(
        JSON.stringify({ event: "vitals-failed", status: res.status }),
      );
      return null;
    }
    return (await res.json().catch(() => ({}))) ?? {};
  } catch (e) {
    console.log(JSON.stringify({ event: "vitals-error", detail: String(e) }));
    return null;
  }
}
