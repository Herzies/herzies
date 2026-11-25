import {
  TOWER_BOON_DEFS,
  TOWER_BOON_IDS,
  type TowerBoon,
  type TowerBoonId,
  towerBoonTotals,
} from "@herzies/shared/tower";

/** A boon's total as a bonus: a share as "+15%", crit chance as points. */
function shown(id: TowerBoonId, total: number): string {
  return id === "crit" ? `+${total}` : `+${Math.round(total * 100)}%`;
}

/** What a climb's boons add up to, a line each by name ("Heavy Hitter
 * +20%"), in the shared order: for the Tower's floor card and the Tower
 * Guard. */
export function boonParts(boons: readonly TowerBoon[]): string[] {
  if (!boons.length) return [];
  const totals = towerBoonTotals(boons);
  return TOWER_BOON_IDS.filter((id) => totals[id] > 0).map(
    (id) => `${TOWER_BOON_DEFS[id].name} ${shown(id, totals[id])}`,
  );
}
