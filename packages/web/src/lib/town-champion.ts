import { createHmac } from "node:crypto";
import {
  type ClassRole,
  type CreatureParams,
  generateCreatureParams,
  normalizeEquipped,
} from "@herzies/shared";
import { AWARD_ROLES } from "@herzies/shared/combat";
import { createAdminClient } from "@/lib/supabase-admin";

/** Never put on the statue: the owner's own herzie (as in `town-ticket`). */
const CHAMPION_SKIP = ["920a6cf8-3f1c-4274-b549-39d976ee6ee0"];

export type ShowcaseChampion = {
  look: {
    seed: string;
    stage: number;
    equipped: Record<string, unknown>;
    body: CreatureParams;
  };
  name: string;
};

/** The statue's herzies, by the award each won. A role nobody's won yet is
 * left out. */
export type ShowcaseChampions = Partial<Record<ClassRole, ShowcaseChampion>>;

/**
 * Who the front page's statue shows: each award's winner at the latest
 * fallen boss that had one (00168 boss_champion_json), in its own body and
 * gear but without a name. Its seed is its friend code, so the statue gets
 * a stand-in seed and the body it rolls as numbers (see the Town server's
 * standInSeed). Empty when there are none, or the database can't be
 * reached (the page still renders).
 */
export async function showcaseChampions(): Promise<ShowcaseChampions> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return {};
  try {
    const { data, error } = await createAdminClient().rpc(
      "boss_champion_json",
      {
        p_skip: CHAMPION_SKIP,
      },
    );
    if (error || !data) return {};
    const winners = data as Record<
      ClassRole,
      { seed: string; stage: number; equipped: unknown } | null
    >;
    const champions: ShowcaseChampions = {};
    for (const role of AWARD_ROLES) {
      const c = winners[role];
      if (!c) continue;
      // Ground accessories stay home, as for a herzie out walking.
      const {
        ground_left: _l,
        ground_right: _r,
        ...equipped
      } = normalizeEquipped(c.equipped);
      const seed = `W-${createHmac("sha256", key).update(`statue:${c.seed}`).digest("hex").slice(0, 16)}`;
      champions[role] = {
        look: {
          seed,
          stage: c.stage,
          equipped,
          body: generateCreatureParams(c.seed),
        },
        name: "",
      };
    }
    return champions;
  } catch {
    return {};
  }
}
