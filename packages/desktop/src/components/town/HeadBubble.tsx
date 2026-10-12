import { SpeechBubble } from "@herzies/shared";
import type { ChatBubble } from "./chatBubbles";

/** A chat line over a herzie's head, shown whole at once. Sits above its
 * name tag (inside the same `<Html>` anchor). */
export function HeadBubble({ bubble }: { bubble: ChatBubble }) {
  return (
    <div className="mb-1 w-max max-w-[160px] whitespace-normal">
      <SpeechBubble line={bubble.text} typed={bubble.text.length} tail="down" />
    </div>
  );
}
