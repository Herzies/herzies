import {
  DEFAULT_Y_ANGLE,
  MADAS_EQUIPPED,
  MADAS_NAME,
  MADAS_SEED,
  MADAS_STAGE,
  SpeechBubble,
  useChatter,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { useEffect, useState } from "react";
import { useHerzieStage } from "../lib/overlayStage";
import { useWildsService, useWildsUpcoming } from "./town/airship/service";
import { skyNow } from "./town/airship/skyClock";
import { useWildsLoot, wildsLoot } from "./town/wilds/loot";
import { madasLines } from "./town/wilds/madas";

/** How often his lines are worked out again: the countdown in them is to
 * the second (useChatter keeps them through a ref, so this doesn't restart
 * him mid-sentence). */
const TICK_MS = 1000;

/**
 * Madas, in the Wilds' safe camp: gone funny over gold, but he knows where
 * the cache is (what the room says, when you're there to hear it) and when
 * the next turns up.
 */
export function MadasPanel({ paused }: { paused: boolean }) {
  const service = useWildsService();
  const upcoming = useWildsUpcoming();
  useWildsLoot();
  const [now, setNow] = useState(() => skyNow());
  useEffect(() => {
    if (paused) return;
    setNow(skyNow());
    const id = setInterval(() => setNow(skyNow()), TICK_MS);
    return () => clearInterval(id);
  }, [paused]);
  const { line, typed, advance } = useChatter(
    madasLines(service, upcoming, wildsLoot.cache, now),
    !paused,
  );
  const { stage: onStage } = useHerzieStage();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-center text-[16px] font-bold text-[#d9d4cc]">
        {MADAS_NAME}
      </div>
      {/* Staged as the others are: square on, his line at his feet. */}
      <div className="relative flex h-[190px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <HerzieView
            onStage={onStage}
            userId={MADAS_SEED}
            stage={MADAS_STAGE}
            zoom={0.8}
            size={5}
            cols={64}
            equipped={MADAS_EQUIPPED}
            animate={false}
            defaultAngle={-DEFAULT_Y_ANGLE}
            draggable={false}
            paused={paused}
            ariaLabel={MADAS_NAME}
          />
        </div>
        <button
          type="button"
          aria-label={`Talk to ${MADAS_NAME}`}
          onClick={advance}
          className="absolute inset-0 z-[2] cursor-pointer border-none bg-transparent p-0"
        />
        <SpeechBubble line={line} typed={typed} />
      </div>
    </div>
  );
}
