import { LOW_HP_FRACTION } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { goToMap } from "./town/runtime";
import { refreshVitals, setVitals, useLiveHp } from "./town/vitals";

/** Seconds to a full bar, shown while resting. */
const label = (hp: number, max: number) => `${Math.ceil(hp)} / ${max}`;

/**
 * The herzie's health bar over the Town, and the screen that comes up when
 * it runs out. The bar stays out of the way while health is full outside of
 * a fight.
 */
export function TownVitals({
  inFight,
  chatOverlay = false,
}: {
  /** On a combat map: show the bar even at full health. */
  inFight: boolean;
  chatOverlay?: boolean;
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
            "pointer-events-none absolute left-1/2 z-30 -translate-x-1/2",
            // In a fight the boss's bar is up top; yours sits low.
            inFight ? "bottom-3 w-64" : "top-2 w-44",
            "rounded bg-black/55 px-1.5 py-1 text-[10px] text-white/85 tabular-nums",
          )}
        >
          <div className="mb-0.5 flex justify-between">
            <span>HP</span>
            <span>{label(hp, maxHp)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-sm bg-white/15">
            <div
              className={cn(
                "h-full transition-[width] duration-300",
                low ? "bg-red-400" : "bg-emerald-400",
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
