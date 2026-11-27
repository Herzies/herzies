import { HerzieStage } from "@herzies/shared/gl";
import { useEffect, useRef, useState } from "react";
import { followTownLook } from "../../lib/overlayStage";
import { AwardsCard } from "./AwardsCard";
import { leaveCombat } from "./combat/Combat";
import { clearBossResults, useBossResultsShown } from "./combat/results";
import { letGoOfTownInput } from "./input";

/**
 * The end of a boss fight, for whoever was in the cave: its awards show
 * (AwardsCard) — victory or defeat, the Big Hitter, Soundproof and
 * Lifesaver stepping onto their plinths one at a time, and your own
 * result under them.
 *
 * It shows just after the boss falls, before anyone goes for the loot,
 * and goes with Continue or Esc; any other key (bar Enter and Space, which
 * press the button in focus) skips to the end of the show. It fills the
 * Town from the top margin down to the bottom one, the world blurred out
 * behind it, and is only drawn while the Town is the view. While it's up
 * the HUD and the chat fade away (useBossResultsShown) and nothing in the
 * Town moves. It stays up back in town until you go on. Above all that,
 * the page's shared herzie stage would be under its background, so its
 * herzies have a stage of their own, inside it.
 */
export function BossResults({
  interactive = true,
}: {
  /** False while an overlay window covers it: keys go to the window. */
  interactive?: boolean;
} = {}) {
  const results = useBossResultsShown();
  // Its herzies' own stage, its canvas inside the overlay.
  const [stage] = useState(() => new HerzieStage());
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => followTownLook(stage), [stage]);
  useEffect(() => () => stage.dispose(), [stage]);
  const shown = results !== null;
  useEffect(() => {
    if (shown) stage.setHost(overlay.current);
  }, [shown, stage]);
  // Bumped by a key: the card skips to the end of its show.
  const [skip, setSkip] = useState(0);
  // While it's up the Town is still: whatever's held is let go, aiming
  // ends (the mouse is let go too), and keys reach it first and stop here —
  // no walking, casting or skills. Esc goes on, like Continue.
  useEffect(() => {
    if (!shown || !interactive) return;
    letGoOfTownInput();
    leaveCombat();
    // The chat steps aside too: nothing typed goes into it unseen.
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        clearBossResults();
      } else if (e.key !== "Enter" && e.key !== " ") {
        e.preventDefault();
        setSkip((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, interactive]);
  if (!results) return null;

  return (
    <div
      ref={overlay}
      className="absolute inset-x-3 top-[calc(var(--hud-top,0px)+0.75rem)] z-50 flex"
      style={{ bottom: "0.75rem" }}
    >
      {/* The window fills it, the Town blurred out behind; its content
          sits in the middle. A new fight's results start the show over. */}
      <AwardsCard
        key={results.showAt}
        results={results}
        stage={stage}
        skip={skip}
        onContinue={clearBossResults}
      />
    </div>
  );
}
