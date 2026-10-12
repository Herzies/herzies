import { LOW_HP_FRACTION } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { goToMap } from "./town/runtime";
import { refreshVitals, setVitals, useLiveHp } from "./town/vitals";

/**
 * The herzie's health in the Town's top right corner, opposite its name,
 * and the screen that comes up when it runs out. Out of the way while
 * health is full outside of a fight.
 */
export function TownVitals({
  inFight,
  chatOverlay = false,
  belowNotice = false,
}: {
  /** On a combat map: show the bar even at full health. */
  inFight: boolean;
  chatOverlay?: boolean;
  /** A notice is across the top: sit below it, as the name does. */
  belowNotice?: boolean;
}) {
  const live = useLiveHp();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Health works without multiplayer, which is what hands it out with
  // tickets: ask when the Town opens, and again after each fight (the room
  // has been keeping the count, and the database has the truth).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on entering or leaving a fight
  useEffect(() => {
    refreshVitals();
  }, [inFight]);

  if (!live) return null;
  const { hp, maxHp, down } = live;
  const frac = Math.max(0, Math.min(1, hp / maxHp));
  const low = frac < LOW_HP_FRACTION;

  const respawn = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const r = await herzies.townVitals("respawn");
      setVitals(r.vitals);
      goToMap("home");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {(inFight || frac < 1) && !down ? (
        <div
          role="progressbar"
          aria-label="Health"
          aria-valuemin={0}
          aria-valuemax={maxHp}
          aria-valuenow={Math.round(hp)}
          className={cn(
            "pointer-events-none absolute right-3 z-30 w-28 tabular-nums",
            belowNotice ? "top-[3rem]" : "top-3",
          )}
        >
          <div className="mb-1 flex items-baseline justify-between text-[10px] [text-shadow:0_1px_2px_#000]">
            <span className="text-white/60">HP</span>
            <span className={low ? "text-red-300" : "text-white/90"}>
              {Math.ceil(hp)}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/15">
            <div
              className={cn(
                "h-full transition-[width] duration-300",
                low ? "bg-red-400/80" : "bg-emerald-400/70",
              )}
              style={{ width: `${frac * 100}%` }}
            />
          </div>
        </div>
      ) : null}
      {low && !down ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-20 motion-safe:animate-pulse",
            chatOverlay ? "" : "",
          )}
          style={{
            boxShadow: `inset 0 0 ${60 + (1 - frac) * 80}px rgba(220,38,38,${
              0.25 + (1 - frac) * 0.3
            })`,
          }}
        />
      ) : null}
      {down ? (
        <div
          role="alertdialog"
          aria-labelledby="down-title"
          className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center"
        >
          <h2 id="down-title" className="text-lg font-semibold text-white">
            Oh no! You need some rest
          </h2>
          <p className="max-w-xs text-ui text-white/60">
            Your herzie ran out of health. It will come back with half of it.
          </p>
          <button
            type="button"
            onClick={respawn}
            disabled={busy}
            className="rounded bg-white/90 px-4 py-1.5 text-ui font-medium text-black transition hover:bg-white disabled:opacity-60"
          >
            {busy ? "Respawning…" : "Respawn in town"}
          </button>
          {failed ? (
            <p className="text-[11px] text-red-300">
              Couldn't reach the server. Try again.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
