import { GENRES } from "@herzies/shared";
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
  if (type === "merchant") {
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
  const hatedGenres = config.hatedGenres;
  const hasGenres = Array.isArray(hatedGenres) && hatedGenres.length > 0;
  if (!hasGenres && !template) {
    return { error: "hatedGenres must be a non-empty subset of GENRES" };
  }
  if (
    hasGenres &&
    !hatedGenres.every((g) => (GENRES as readonly unknown[]).includes(g))
  ) {
    return { error: "hatedGenres must be a non-empty subset of GENRES" };
  }

  const hasHp = config.maxHp != null && config.maxHp !== "";
  const maxHp = Number(config.maxHp);
  if ((!hasHp && !template) || (hasHp && !(maxHp > 0))) {
    return { error: "maxHp must be a positive number" };
  }

  if (typeof config.rewardItemId !== "string" || !config.rewardItemId) {
    return { error: "rewardItemId is required" };
  }
  const topRewardItemId =
    typeof config.topRewardItemId === "string" && config.topRewardItemId
      ? config.topRewardItemId
      : undefined;
  const missing = await missingItems(
    admin,
    [config.rewardItemId, topRewardItemId].filter((v): v is string => !!v),
  );
  if (missing.length > 0) {
    return { error: `Unknown item: ${missing.join(", ")}` };
  }

  return {
    config: {
      ...(hasGenres ? { hatedGenres } : {}),
      rewardItemId: config.rewardItemId,
      ...(topRewardItemId ? { topRewardItemId } : {}),
      topCount: Number.isInteger(config.topCount) ? config.topCount : 3,
      ...(hasHp ? { maxHp } : {}),
    },
  };
}

/**
 * Validate George's stock. An empty list is allowed — the occurrence just
 * stays a draft until something is stocked.
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
