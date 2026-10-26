import type { HerzieModel } from "@herzies/shared/gl";
import { bossFight } from "./combat/fight";
import { getVitals } from "./vitals";

/**
 * A herzie knocked out in a raid: it lies where it fell, greyed, until a
 * Bard plays it back up (or it gives up). Shared by your herzie (Player)
 * and everyone else's (RemotePlayers), so a Bard can find the body.
 */

/** How far it tips over, radians: on its side, not flat out of sight. */
const LIE = 1.2;
/** How fast it falls and gets back up, per second. */
const RATE = 4;

/** Whether you're down where a Bard can bring you back, so you stay where
 * you fell: in a raid that's on, or anywhere outside a fight. */
export function downInRaid(): boolean {
  if (!getVitals()?.down) return false;
  return bossFight.on ? bossFight.raid?.stage === "fight" : true;
}

/** Whether herzie `id` is down in the cave. */
export function entityDown(id: number | null): boolean {
  if (id === null || !bossFight.on || bossFight.tower) return false;
  const h = bossFight.health.get(id);
  return !!h && h.hp <= 0;
}

/**
 * Eases `herzie` toward lying down (`down`) or standing, from `was` (0
 * standing to 1 down); returns where it is now. Call each frame after the
 * herzie's own update.
 */
export function applyDowned(
  herzie: HerzieModel,
  down: boolean,
  was: number,
  dt: number,
): number {
  const k = Math.max(0, Math.min(1, was + (down ? dt : -dt) * RATE));
  if (k === 0 && was === 0) return 0;
  herzie.root.rotation.z = k * LIE;
  herzie.setTint(k * 0.7, 1);
  return k;
}
