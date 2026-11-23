import {
  DEFAULT_Y_ANGLE,
  SKIPPER_EQUIPPED,
  SKIPPER_NAME,
  SKIPPER_SEED,
  SKIPPER_STAGE,
  SpeechBubble,
  useChatter,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { useEffect, useState } from "react";
import { useHerzieStage } from "../lib/overlayStage";
import { useWildsService, useWildsUpcoming } from "./town/airship/service";
import { skipperLines } from "./town/airship/skipper";
import { skyNow } from "./town/airship/skyClock";

/** How often his lines are worked out again: the countdowns in them are
 * to the second, and he only reads them when he speaks (useChatter keeps
 * them through a ref, so this doesn't restart him mid-sentence). */
const TICK_MS = 1000;

/**
 * Blåmann, Sofia III's skipper, on the pier at the home island's Sky Dock:
 * whether she's sailing, where she is and when she next leaves Town.
 */
export function SkipperPanel({ paused }: { paused: boolean }) {
  const service = useWildsService();
  const upcoming = useWildsUpcoming();
  const [now, setNow] = useState(() => skyNow());
  useEffect(() => {
    if (paused) return;
    setNow(skyNow());
    const id = setInterval(() => setNow(skyNow()), TICK_MS);
    return () => clearInterval(id);
  }, [paused]);
  const { line, typed, advance } = useChatter(
    skipperLines(service, upcoming, now),
    !paused,
  );
  const { stage: onStage } = useHerzieStage();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-center text-[16px] font-bold text-[#d9d4cc]">
        {SKIPPER_NAME}
      </div>
      {/* Staged as the others are: square on, his line at his feet. */}
      <div className="relative flex h-[190px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <HerzieView
            onStage={onStage}
            bleed
            userId={SKIPPER_SEED}
            stage={SKIPPER_STAGE}
            zoom={0.8}
            size={5}
            cols={64}
            equipped={SKIPPER_EQUIPPED}
            animate={false}
            defaultAngle={-DEFAULT_Y_ANGLE}
            draggable={false}
            paused={paused}
            ariaLabel={SKIPPER_NAME}
          />
        </div>
        <button
          type="button"
          aria-label={`Talk to ${SKIPPER_NAME}`}
          onClick={advance}
          className="absolute inset-0 z-[2] cursor-pointer border-none bg-transparent p-0"
        />
        <SpeechBubble line={line} typed={typed} />
      </div>
    </div>
  );
}
