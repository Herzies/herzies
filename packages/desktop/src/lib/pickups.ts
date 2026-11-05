import { logActivity } from "./activity";
import { notify, revise } from "./notices";

/**
 * Saying that something went into the bag, the moment it does (before the
 * server has confirmed: the bag is updated optimistically too).
 *
 * A run of pickups is one line, not one each, after how loot feeds merge a
 * burst: a spirit handing over five finds would otherwise push lines off
 * the screen before they could be read. Each pickup restarts the line with
 * a pulse, in time with its sound, and names the latest (the spirit hands
 * over the grandest last): `Picked up "Ghost"`, then `Picked up "Ghost" ×3`
 * or `Picked up "Blood Moon" and 4 more`.
 *
 * The line is said at once, but it stays honest: a pickup the server turns
 * down is taken back out of it (`refuse`), and only a confirmed one goes in
 * the activity log (`confirm`), which is the record.
 */

/** Pickups this close together are one run. */
const RUN_MS = 1_600;

type Run = { key: string; names: string[]; last: number };

let run: Run | null = null;
let runs = 0;

/** What a run says. */
export function pickupLine(names: readonly string[]): string {
  const latest = names[names.length - 1];
  if (names.length === 1) return `Picked up "${latest}"`;
  if (names.every((n) => n === latest))
    return `Picked up "${latest}" ×${names.length}`;
  return `Picked up "${latest}" and ${names.length - 1} more`;
}

/** A pickup that's been said, waiting on the server. Each settles once. */
export type Pickup = {
  /** The server has it: into the activity log. */
  confirm(): void;
  /** The server turned it down: out of the line again (and the line down,
   * if it was all there was). */
  refuse(): void;
};

/** `name` went into the bag just now. `log` is the activity log's line, if
 * not the usual `Picked up "<name>"`. */
export function announcePickup(
  name: string,
  opts: { log?: string; now?: number } = {},
): Pickup {
  const now = opts.now ?? Date.now();
  if (!run || now - run.last > RUN_MS)
    run = { key: `pickup:${++runs}`, names: [], last: now };
  const mine: Run = run;
  mine.names.push(name);
  mine.last = now;
  notify(pickupLine(mine.names), { kind: "success", key: mine.key });
  let settled = false;
  return {
    confirm() {
      if (settled) return;
      settled = true;
      logActivity(opts.log ?? `Picked up "${name}"`);
    },
    refuse() {
      if (settled) return;
      settled = true;
      const i = mine.names.lastIndexOf(name);
      if (i >= 0) mine.names.splice(i, 1);
      revise(mine.key, mine.names.length > 0 ? pickupLine(mine.names) : null);
    },
  };
}

/** Tests: start clean. */
export function resetPickups(): void {
  run = null;
}
