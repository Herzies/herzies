import {
  type HerzieClass,
  type ItemUnit,
  LOADOUT_SWITCH_GAP_MS,
  type LoadoutIndex,
  type LoadoutState,
} from "@herzies/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useInDuel } from "../components/town/duel/store";
import { useHomeMode } from "../components/town/homeMode";
import { townSave } from "../components/town/runtime";
import {
  loadoutRefusalText,
  predictLoadoutSwitch,
  switchReportLine,
} from "../lib/loadouts";
import { notify } from "../lib/notices";
import { herzies } from "../tauri-bridge";

/** How long a switch the server took is shown as done without the loadouts
 * that say so having arrived, before deferring to what the app holds. */
const PENDING_MAX_MS = 2_000;

/** Past the server's least gap between switches (LOADOUT_SWITCH_GAP_MS), for
 * the clocks and the trip there: a click as soon as the tabs come back on is
 * never "too fast". */
const SETTLE_MS = LOADOUT_SWITCH_GAP_MS + 250;

/**
 * Switching loadouts from the Deck's 1 | 2 tabs. The tab and the gear move
 * at once: the copies through the same optimistic layer as an equip
 * (`onPredictUnits`, predicted with `predictLoadoutSwitch`), the tab through
 * `pending` until the server's loadouts agree. One switch at a time, and the
 * tabs stay off until the server would take the next one (`settling`).
 *
 * Not in a fight: a duel (from the accept on), the boss's cave or the
 * Tower. The server's duel stats were taken at the accept anyway; this keeps
 * the gear from changing under you mid-fight.
 */
export function useLoadoutSwitch({
  loadouts,
  units,
  stage,
  herzieClass,
  capacity,
  onPredictUnits,
  onLog,
}: {
  loadouts: LoadoutState | null | undefined;
  units: readonly ItemUnit[];
  stage: number;
  herzieClass: HerzieClass | null;
  /** Bag slots (`bankCapacity`): a switch whose refused pieces wouldn't fit
   * is refused here, as the server would. */
  capacity: number;
  onPredictUnits: (
    update: (units: readonly ItemUnit[]) => ItemUnit[],
    settled: Promise<unknown>,
  ) => void;
  onLog?: (msg: string) => void;
}) {
  const [pending, setPending] = useState<LoadoutIndex | null>(null);
  /** From a click until the server's gap since that switch has passed. */
  const [settling, setSettling] = useState(false);
  const inDuel = useInDuel();
  // Re-rendered on going into (or out of) a fight's island; which one is
  // townSave's to say.
  useHomeMode();
  const blocked = inDuel
    ? "Not during a duel"
    : townSave.map === "bossroom"
      ? "Not in the boss's cave"
      : townSave.map === "tower"
        ? "Not in the Tower"
        : !loadouts
          ? "Loading loadouts…"
          : null;

  const serverActive = loadouts?.active ?? null;
  useEffect(() => {
    if (pending !== null && serverActive === pending) setPending(null);
  }, [pending, serverActive]);
  // A switch the server took whose loadouts never came back: don't hold the
  // tab forever.
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      clearTimeout(fallback.current ?? undefined);
      clearTimeout(settle.current ?? undefined);
    },
    [],
  );

  const latest = useRef({
    loadouts,
    units,
    stage,
    herzieClass,
    capacity,
    pending,
    settling,
  });
  latest.current = {
    loadouts,
    units,
    stage,
    herzieClass,
    capacity,
    pending,
    settling,
  };

  const switchTo = useCallback(
    (to: LoadoutIndex) => {
      const now = latest.current;
      if (!now.loadouts || now.pending !== null || now.settling) return;
      if (now.loadouts.active === to) return;
      if (blocked) {
        notify(blocked);
        return;
      }
      const from = now.loadouts;
      const prediction = predictLoadoutSwitch(
        now.units,
        from,
        now.stage,
        now.herzieClass,
        now.capacity,
      );
      if (prediction.bagFull) {
        notify(loadoutRefusalText("bag-full"));
        return;
      }
      setPending(to);
      setSettling(true);
      // Set here too, so a second click before the re-render is dropped.
      latest.current.settling = true;
      const call = herzies.switchLoadout(to);
      onPredictUnits(
        (base) =>
          predictLoadoutSwitch(base, from, now.stage, now.herzieClass).units,
        call,
      );
      call.then(
        (reply) => {
          const line = switchReportLine(reply.report);
          if (line) {
            notify(line, { kind: "info" });
            onLog?.(`Loadout ${to}: ${line}`);
          }
          clearTimeout(fallback.current ?? undefined);
          fallback.current = setTimeout(() => setPending(null), PENDING_MAX_MS);
          clearTimeout(settle.current ?? undefined);
          settle.current = setTimeout(() => setSettling(false), SETTLE_MS);
        },
        (e: unknown) => {
          setPending(null);
          setSettling(false);
          notify(
            loadoutRefusalText(e instanceof Error ? e.message : String(e)),
          );
        },
      );
    },
    [blocked, onPredictUnits, onLog],
  );

  return {
    /** The loadout shown as worn: the one being switched to, while it is. */
    active: pending ?? serverActive ?? 1,
    switching: pending !== null || settling,
    /** Why switching is off right now, or null. */
    blocked,
    switchTo,
  };
}
