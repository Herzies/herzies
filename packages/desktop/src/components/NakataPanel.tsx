import {
  DEFAULT_Y_ANGLE,
  type Equipped,
  NAKATA_EQUIPPED,
  NAKATA_NAME,
  NAKATA_SEED,
  NAKATA_STAGE,
  nakataLines,
  SpeechBubble,
  useChatter,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { useHerzieStage } from "../lib/overlayStage";

/**
 * Nakata, by the river: an old man who talks to cats. He only meows at you,
 * unless Sleptwell, the cat spirit, is with you; then he talks.
 */
export function NakataPanel({
  equipped,
  paused,
}: {
  /** Your deck: whether your spirit is the cat. */
  equipped?: Equipped | null;
  paused: boolean;
}) {
  const { line, typed, advance } = useChatter(
    nakataLines(equipped?.spirit),
    !paused,
  );
  const { stage: onStage } = useHerzieStage();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-center text-[16px] font-bold text-[#d9d4cc]">
        {NAKATA_NAME}
      </div>
      {/* Staged as the others are: square on, his line at his feet. */}
      <div className="relative flex h-[190px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <HerzieView
            onStage={onStage}
            userId={NAKATA_SEED}
            stage={NAKATA_STAGE}
            zoom={0.8}
            size={5}
            cols={64}
            equipped={NAKATA_EQUIPPED}
            animate={false}
            defaultAngle={-DEFAULT_Y_ANGLE}
            draggable={false}
            paused={paused}
            ariaLabel={NAKATA_NAME}
          />
        </div>
        <button
          type="button"
          aria-label={`Talk to ${NAKATA_NAME}`}
          onClick={advance}
          className="absolute inset-0 z-[2] cursor-pointer border-none bg-transparent p-0"
        />
        <SpeechBubble line={line} typed={typed} />
      </div>
    </div>
  );
}
