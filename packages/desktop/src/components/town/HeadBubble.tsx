import { SpeechBubble, useTypewriter } from "@herzies/shared";
import type { ChatBubble } from "./chatBubbles";

/** A chat line over a herzie's head, typed out. Sits above its name tag
 * (inside the same `<Html>` anchor). */
export function HeadBubble({ bubble }: { bubble: ChatBubble }) {
  const { typed } = useTypewriter(bubble.text);
  return (
    <div className="mb-1 w-max max-w-[180px] whitespace-normal">
      <SpeechBubble line={bubble.text} typed={typed} tail="down" />
    </div>
  );
}
