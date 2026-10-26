import { LOW_HP_FRACTION } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { bossFight, useBossFight } from "./town/combat/fight";
import { townNet } from "./town/net/townNet";
import { goToMap } from "./town/runtime";
import { refreshVitals, setVitals, useLiveHp } from "./town/vitals";

/**
 * The red edge as health runs low, and what comes up when it runs out: in a
 * raid you're in, a banner (you lie where you fell; a Bard can play you
 * back up, or you can leave the fight and its reward); anywhere else, the
 * screen that sends you home to rest.
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
  useBossFight();
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

  const raid = bossFight.raid;
  const waiting =
    down && raid?.stage === "fight" && raid.you === "in" && !bossFight.closing;

  const respawn = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    // Out of the raid first, so the room stops waiting for you (respawning
    // takes you out in the database too).
    if (waiting) townNet().sendForfeit();
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
      {waiting ? (
        <div
          role="alert"
          className="pointer-events-auto absolute bottom-24 left-1/2 z-40 w-[min(24rem,90%)] -translate-x-1/2 rounded border border-white/15 bg-black/60 px-3 py-2 text-center text-ui text-text shadow-lg backdrop-blur-md"
        >
          <div className="font-bold">You're knocked out</div>
          <p className="text-[11px] text-text-dim">
            A Bard can play you back up. Stay put — they'll come to you.
          </p>
          <button
            type="button"
            className="btn mt-1.5 text-[11px]"
            onClick={respawn}
            disabled={busy}
          >
            {busy ? "Leaving…" : "Leave the fight (no reward)"}
          </button>
          {failed ? (
            <p className="text-[10px] text-text-dim">
              Couldn't reach the server. Try again.
            </p>
          ) : null}
        </div>
      ) : down ? (
        // As the boss fight's end screen: the window fills the Town down to
        // the bottom margin, the world blurred out behind it.
        <div
          className="absolute inset-x-3 top-[38px] z-50 flex"
          style={{ bottom: "0.75rem" }}
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
              Your herzie ran out of health. A Bard can play it back up where
              it fell — or rest to get up on your own.
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
