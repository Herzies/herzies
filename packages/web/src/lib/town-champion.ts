import { createHmac } from "node:crypto";
import { normalizeEquipped } from "@herzies/shared";
import { createAdminClient } from "@/lib/supabase-admin";

/** Never put on the statue: the owner's own herzie (as in `town-ticket`). */
const CHAMPION_SKIP = ["920a6cf8-3f1c-4274-b549-39d976ee6ee0"];

export type ShowcaseChampion = {
  look: { seed: string; stage: number; equipped: Record<string, unknown> };
  name: string;
};

/**
 * Who the front page's statue shows: the last boss fight's champion, as the
 * Town has it, but in a made-up body and without a name. A herzie's real
 * body is made from its friend code, so showing it in public would give the
 * code away (see the Town server's standInSeed). Null when there's none, or
 * the database can't be reached (the page still renders).
 */
export async function showcaseChampion(): Promise<ShowcaseChampion | null> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  try {
    const { data, error } = await createAdminClient().rpc(
      "boss_champion_json",
      {
        p_skip: CHAMPION_SKIP,
      },
    );
    if (error || !data) return null;
    const c = data as { seed: string; stage: number; equipped: unknown };
    // Ground accessories stay home, as for a herzie out walking.
    const {
      ground_left: _l,
      ground_right: _r,
      ...equipped
    } = normalizeEquipped(c.equipped);
    const seed = `W-${createHmac("sha256", key).update(`statue:${c.seed}`).digest("hex").slice(0, 16)}`;
    return { look: { seed, stage: c.stage, equipped }, name: "" };
  } catch {
    return null;
  }
}
