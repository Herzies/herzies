import { LOW_HP_FRACTION } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { HpBar } from "./SquareBar";
import { goToMap } from "./town/runtime";
import { refreshVitals, setVitals, useLiveHp } from "./town/vitals";

/**
 * The herzie's health in the Town card, above its exp. Out of the way while
 * health is full outside of a fight, or once it has run out.
 */
export function TownHpBar({ inFight }: { inFight: boolean }) {
  const live = useLiveHp();
  if (!live || live.down) return null;
  const { hp, maxHp } = live;
  if (!inFight && hp >= maxHp) return null;
  return <HpBar hp={hp} maxHp={maxHp} className="mb-px text-white/70" />;
}

/**
 * The red edge as health runs low, and the screen that comes up when it runs
 * out.
 */
export function TownVitals({
  inFight,
  chatOverlay = false,
}: {
  /** Refetch health on entering or leaving a fight. */
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
        // As the boss fight's end screen: the window fills the Town down to
        // just above the tab bar, the world blurred out behind it.
        <div
          className="absolute inset-x-3 top-3 z-50 flex"
          style={{ bottom: "calc(var(--nav-height, 0px) + 0.75rem)" }}
        >
          <section
            role="alertdialog"
            aria-labelledby="down-title"
            className="relative flex min-h-0 w-full flex-col items-center justify-center gap-2 overflow-y-auto rounded border border-white/15 bg-black/45 px-4 py-3 text-center text-ui text-text shadow-lg backdrop-blur-md"
          >
            <h2 id="down-title" className="text-xl font-bold text-text">
              Oh no! You need some rest
            </h2>
            <p className="text-[10px] text-text-dim">
              Your herzie ran out of health.
            </p>
            <div className="mt-1.5 flex justify-center">
              <button
                type="button"
                className="btn"
                onClick={respawn}
                disabled={busy}
              >
                {busy ? "Respawning…" : "Respawn in town"}
              </button>
            </div>
            {failed ? (
              <p className="text-[10px] text-text-dim">
                Couldn't reach the server. Try again.
              </p>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
