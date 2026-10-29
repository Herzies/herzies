import { getItem, parseBossRewardPools, TREAT_ITEM_ID } from "@herzies/shared";
import type { createAdminClient } from "@/lib/supabase-admin";

type Admin = ReturnType<typeof createAdminClient>;
type Config = Record<string, unknown>;

/** A normalized config, or the reason it was refused. */
export type ConfigResult = { config: Config } | { error: string };

/**
 * Whether an occurrence has everything it needs to go live. Mirrors the SQL
 * event_config_complete (00081) that the series materializer uses — keep the
 * two in step.
 */
export function isEventConfigComplete(type: string, config: Config): boolean {
  if (type === "song_hunt") {
    return (
      typeof config.trackTitle === "string" &&
      config.trackTitle !== "" &&
      typeof config.trackArtist === "string" &&
      config.trackArtist !== "" &&
      Array.isArray(config.hints) &&
      config.hints.length > 0
    );
  }
  if (type === "merchant" || type === "treat_trader") {
    return Array.isArray(config.stock) && config.stock.length > 0;
  }
  return true;
}

/** Every id that is missing from the items catalog. */
async function missingItems(admin: Admin, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data } = await admin.from("items").select("id").in("id", ids);
  return ids.filter((i) => !data?.some((row) => row.id === i));
}

/** The Tower's default reward for a month's best climber (00121). */
export const TOWER_DEFAULT_REWARD = "power-dice-3";

/**
 * Validate a Tower config: what the month's best climber gets from the
 * Tower Guard (`topRewardItemId`, Power Dice 3 unless set) and the herzie
 * names never ranked for it (`excludeHerzies`).
 */
export async function validateTowerConfig(
  admin: Admin,
  config: Config,
): Promise<ConfigResult> {
  const reward =
    typeof config.topRewardItemId === "string" && config.topRewardItemId
      ? config.topRewardItemId
      : TOWER_DEFAULT_REWARD;
  if ((await missingItems(admin, [reward])).length > 0) {
    return { error: `Unknown item: ${reward}` };
  }
  const raw = config.excludeHerzies ?? [];
  if (!Array.isArray(raw) || raw.some((n) => typeof n !== "string")) {
    return { error: "excludeHerzies must be a list of herzie names" };
  }
  const excludeHerzies = [
    ...new Set((raw as string[]).map((n) => n.trim()).filter(Boolean)),
  ];
  return { config: { topRewardItemId: reward, excludeHerzies } };
}

const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * Validate a boss_fight config. For a series template, genres and HP may be
 * left out — the materializer rolls genres and scales HP with player count.
 *
 * Reward items are never auto-created: settle_boss_fight grants them long
 * after the form is closed, and a typo would only surface as a failed payout.
 */
export async function validateBossConfig(
  admin: Admin,
  config: Config,
  { template = false }: { template?: boolean } = {},
): Promise<ConfigResult> {
  // No genres: the boss hates all music (a hatedGenres sent anyway is
  // dropped).
  const hasHp = config.maxHp != null && config.maxHp !== "";
  const maxHp = Number(config.maxHp);
  if ((!hasHp && !template) || (hasHp && !(maxHp > 0))) {
    return { error: "maxHp must be a positive number" };
  }

  // The raid (00122): health per herzie in the roster, and how strong its
  // minions are (a Tower floor). Both optional: the defaults are tuned.
  const hasPer = config.hpPerPlayer != null && config.hpPerPlayer !== "";
  const hpPerPlayer = Number(config.hpPerPlayer);
  if (hasPer && !(hpPerPlayer >= 100 && hpPerPlayer <= 10_000_000)) {
    return { error: "hpPerPlayer must be between 100 and 10,000,000" };
  }
  const hasFloor = config.minionFloor != null && config.minionFloor !== "";
  const minionFloor = Number(config.minionFloor);
  if (hasFloor && !isPositiveInt(minionFloor)) {
    return { error: "minionFloor must be a whole number from 1" };
  }

  if (typeof config.rewardItemId !== "string" || !config.rewardItemId) {
    return { error: "rewardItemId is required" };
  }
  // Pools (00124_boss_reward_pools.sql): catalog items only, checked
  // against the items table too, since that's what the payout reads.
  const parsed = parseBossRewardPools(
    config.rewardPools,
    (id) => !!getItem(id),
  );
  if ("error" in parsed) return parsed;
  const rewardPools = parsed.pools;

  const missing = await missingItems(admin, [
    config.rewardItemId,
    ...rewardPools.flatMap((p) => p.itemIds),
  ]);
  if (missing.length > 0) {
    return { error: `Unknown item: ${missing.join(", ")}` };
  }

  return {
    config: {
      rewardItemId: config.rewardItemId,
      ...(hasHp ? { maxHp } : {}),
      ...(hasPer ? { hpPerPlayer } : {}),
      ...(hasFloor ? { minionFloor } : {}),
      ...(rewardPools.length > 0 ? { rewardPools } : {}),
    },
  };
}

/** Never sold by a visitor: the spirits are money-only (Stripe products),
 * and the Treat is the treat_trader's currency. */
const UNSELLABLE_ITEM_IDS = new Set(["ghost", "spirit-orb", TREAT_ITEM_ID]);

/**
 * Validate a merchant's stock: George's (coins) or Nandor's (treats), which
 * share a shape. An empty list is allowed — the occurrence just stays a draft
 * until something is stocked.
 */
export async function validateMerchantConfig(
  admin: Admin,
  config: Config,
): Promise<ConfigResult> {
  const raw = config.stock ?? [];
  if (!Array.isArray(raw)) return { error: "stock must be a list" };

  const stock: Config[] = [];
  const seen = new Set<string>();
  for (const entry of raw as Config[]) {
    const itemId = entry?.itemId;
    if (typeof itemId !== "string" || !itemId) {
      return { error: "Every stock line needs an item" };
    }
    if (UNSELLABLE_ITEM_IDS.has(itemId)) {
      return { error: `"${itemId}" can't be sold here` };
    }
    if (seen.has(itemId)) {
      return { error: `"${itemId}" is stocked twice` };
    }
    seen.add(itemId);
    if (!isPositiveInt(entry.price)) {
      return { error: `Price for "${itemId}" must be a positive whole number` };
    }
    for (const key of ["perPlayerLimit", "totalStock"] as const) {
      const v = entry[key];
      if (v != null && !isPositiveInt(v)) {
        return {
          error: `${key} for "${itemId}" must be a positive whole number or empty`,
        };
      }
    }
    stock.push({
      itemId,
      price: entry.price,
      ...(entry.perPlayerLimit != null
        ? { perPlayerLimit: entry.perPlayerLimit }
        : {}),
      ...(entry.totalStock != null ? { totalStock: entry.totalStock } : {}),
    });
  }

  const missing = await missingItems(admin, [...seen]);
  if (missing.length > 0) {
    return { error: `Unknown item: ${missing.join(", ")}` };
  }

  return { config: { stock } };
}
