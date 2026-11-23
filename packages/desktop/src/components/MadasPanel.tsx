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
import { useRef } from "react";
import { useHerzieStage } from "../lib/overlayStage";
import { MADAS_LINES } from "./town/wilds/madas";

/**
 * Madas, in the Wilds' safe camp: gone funny over gold, and all he does is
 * explain the treasure hunt, one line after another in order (a click
 * moves him on), round again from the top once he's done.
 */
export function MadasPanel({ paused }: { paused: boolean }) {
  const next = useRef(0);
  const { line, typed, advance } = useChatter(MADAS_LINES, !paused, (lines) => [
    lines[next.current++ % lines.length],
  ]);
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
            bleed
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
