import type { HerzieModel } from "@herzies/shared/gl";
import { bossFight } from "./combat/fight";
import { getVitals } from "./vitals";
import { myWildsDown } from "./wilds/store";

/**
 * A herzie knocked out: it falls over and lies where it fell, greyed, until
 * it's back up (a Bard plays it up, it respawns, or the Wilds' camp stands
 * it up). Shared by your herzie (Player) and everyone else's
 * (RemotePlayers), so a Bard can find the body.
 */

/** How far it tips over, radians: on its side, not flat out of sight. */
const LIE = 1.2;
/** How fast it falls and gets back up, per second (a fall takes 0.4 s). */
const RATE = 2.5;

/** Whether your herzie is down, wherever that is: out of health (the Tower,
 * the cave at any stage, the Town) or taken down in the Wilds. It lies
 * where it fell, and doesn't walk, turn, jump, cast or emote until it's back
 * up; the camera's still yours. */
export function youDown(): boolean {
  return !!getVitals()?.down || myWildsDown();
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
  // Toppling: slow off its feet, quickest as it hits the floor (and so,
  // getting up, a push off the floor that slows as it rights itself).
  herzie.root.rotation.z = k * k * LIE;
  herzie.setTint(k * 0.7, 1);
  return k;
}
