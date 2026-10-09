import {
  DEFAULT_Y_ANGLE,
  ORPHIEZ_EQUIPPED,
  SpeechBubble,
  useChatter,
  VISITORS,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";

/** What Orphiez mutters while players hunt. Flavour only — never a clue:
 * the clues are the hunt's own, and deliberately hard. */
export const ORPHIEZ_LINES = [
  "It went something like… no. Gone again.",
  "I had it. I had it, and then I looked back.",
  "Somewhere down there is a song that's mine.",
  "Hum anything. I'll know it when I hear it.",
  "Every clue gets me closer. Or further. Hard to tell.",
  "Don't look back. Never look back.",
  "She would have known the name.",
  "It's on the tip of my tongue. Or my strings.",
  "Play it for me? Just once more.",
  "I'd trade my lyre for one more listen.",
];

/**
 * Orphiez square-on with his muttering in a bubble at his feet — the same
 * staging George and the boss get, so every visitor in Town reads as a
 * character rather than a form. Sits at the top of the song hunt view.
 */
export function OrphiezStage({ paused }: { paused: boolean }) {
  const { line, typed, advance } = useChatter(ORPHIEZ_LINES, !paused);
  const orphiez = VISITORS.song_hunt;
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <div className="text-center text-[16px] font-bold text-cyan">
        {orphiez.name}
      </div>
      <div className="relative flex h-[150px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <HerzieView
            userId={orphiez.seed ?? "npc:orphiez"}
            stage={2}
            size={5}
            cols={64}
            equipped={ORPHIEZ_EQUIPPED}
            animate={false}
            defaultAngle={-DEFAULT_Y_ANGLE}
            draggable={false}
            paused={paused}
            ariaLabel={orphiez.name}
          />
        </div>
        {/* Clicking Orphiez hurries them along, as with George: the line
            they're on shows in full, or the next one comes now. z-[2]: over
            the canvas (its own z-index is 1), under the bubble. */}
        <button
          type="button"
          aria-label={`Talk to ${orphiez.name}`}
          onClick={advance}
          className="absolute inset-0 z-[2] cursor-pointer border-none bg-transparent p-0"
        />
        <SpeechBubble line={line} typed={typed} />
      </div>
    </div>
  );
}
