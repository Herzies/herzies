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
import type { Env } from "./room";

export type VitalsReport = {
  action: "report";
  /** Absolute HP for players in a fight; `heal` is how far skills may have
   * raised it since the last report taken (set_herzie_hp otherwise only
   * lowers). */
  hp?: { uid: string; hp: number; heal?: number }[];
  /** Extra HP earned resting on a bench. */
  rest?: { uid: string; bonus: number }[];
  /** Damage dealt to the boss, named by `batch` so a retry isn't counted
   * twice. */
  boss?: {
    event: string;
    batch: string;
    /** Each herzie's damage, and the HP they healed or blocked (00111). */
    damage: {
      uid: string;
      damage: number;
      healing?: number;
      blocked?: number;
    }[];
  };
  /** Skill XP earned, named by `batch` like the boss damage. */
  skills?: {
    batch: string;
    xp: { uid: string; skill: string; xp: number }[];
  };
  /** The fight is over: ask for the end screen's table, with the places of
   * these herzies (00110). */
  results?: { event: string; uids: string[] };
};

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

/** POST `payload` to `town-vitals`, signed. The reply's JSON, or null on
 * any failure (logged). */
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
