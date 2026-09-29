import type { ItemUpgradeResult } from "@herzies/shared";
import { useCallback, useRef, useState } from "react";

/** However fast the server answers, the "Upgrading…" state holds at least
 * this long — a safe roll that resolves in 80ms would otherwise flicker past
 * without ever reading as a roll. */
export const MIN_ROLL_MS = 1200;

export type UpgradeRollPhase =
  | { status: "idle" }
  | { status: "rolling" }
  | { status: ItemUpgradeResult; newLevel: number }
  | { status: "error"; message: string };

export type UpgradeRollFn = (
  targetUnitId: string,
  protectionItemId: string | null,
) => Promise<{ result: ItemUpgradeResult; newLevel: number }>;

/** The dice upgrade window's state machine: idle → rolling → upgraded | kept
 * | destroyed (or error), then back to idle on `reset`. The roll itself is
 * the server's; this only paces how its answer is revealed. */
export function useUpgradeRoll(roll: UpgradeRollFn, minMs = MIN_ROLL_MS) {
  const [phase, setPhase] = useState<UpgradeRollPhase>({ status: "idle" });
  // A second click while one roll is in flight must not start another.
  const inFlight = useRef(false);

  const start = useCallback(
    async (targetUnitId: string, protectionItemId: string | null) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPhase({ status: "rolling" });
      const minWait = new Promise((r) => setTimeout(r, minMs));
      try {
        const [out] = await Promise.all([
          roll(targetUnitId, protectionItemId),
          minWait,
        ]);
        setPhase({ status: out.result, newLevel: out.newLevel });
      } catch (e: unknown) {
        await minWait;
        setPhase({
          status: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        inFlight.current = false;
      }
    },
    [roll, minMs],
  );

  const reset = useCallback(() => setPhase({ status: "idle" }), []);

  return { phase, start, reset };
}
