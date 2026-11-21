import { LOW_HP_FRACTION } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { PromptOverlay } from "./PromptOverlay";
import { bossFight, useBossFight } from "./town/combat/fight";
import { useBossResultsShown } from "./town/combat/results";
import { townNet } from "./town/net/townNet";
import { goToMap } from "./town/runtime";
import { refreshVitals, setVitals, useLiveHp } from "./town/vitals";

/**
 * The red edge as health runs low, and what comes up when it runs out: in a
 * raid you're in, a banner (you lie where you fell; a Bard can play you
 * back up, or you can leave the fight and its reward); anywhere else, the
 * prompt box that sends you home to rest.
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

  // The fight's end screen comes first; the rest dialog after it (and
  // after the room has closed, back in town).
  const results = useBossResultsShown();

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
      ) : down && !results && !bossFight.closing ? (
        // The app's own prompt box, up top: the Town stays in sight around
        // it. Escape doesn't dismiss it (there's nothing else to choose).
        <PromptOverlay
          title="Oh no! You need some rest"
          titleId="down-title"
          escapeDisabled
          actions={[
            {
              label: "Respawn in town",
              busyLabel: "Respawning…",
              busy,
              onClick: respawn,
            },
          ]}
        >
          Your herzie ran out of health. A Bard can play it back up where it
          fell — or rest to get up on your own.
          {failed ? (
            <p className="mt-1 text-[10px] text-text-dim">
              Couldn't reach the server. Try again.
            </p>
          ) : null}
        </PromptOverlay>
      ) : null}
    </>
  );
}
