import { DEFAULT_Y_ANGLE, Herzie3D, VISITORS } from "@herzies/shared";
import { SpeechBubble, useChatter } from "./SpeechBubble";

/** Orphiez's look: a fixed seed like George's, in the teal skin, with
 * headphones on — he's listening for it everywhere. */
export const ORPHIEZ_EQUIPPED = {
  head: "headphones",
  color: "thanks-for-all-the-fish",
};

/** What Orphiez mutters while players hunt. Flavour only — never a clue:
 * the clues are the hunt's own, and deliberately hard. */
const ORPHIEZ_LINES = [
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
  const { line, typed } = useChatter(ORPHIEZ_LINES, !paused);
  const orphiez = VISITORS.song_hunt;
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <div className="text-center text-[16px] font-bold text-cyan">
        {orphiez.name}
      </div>
      <div className="relative flex h-[150px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <Herzie3D
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
        <SpeechBubble line={line} typed={typed} />
      </div>
    </div>
  );
}
