import { cn } from "../lib/utils";

/** The little "GM" badge left of a game master's name (00133), in Town and
 * in chat. Read out as "Game master". */
export function GmMark({ className }: { className?: string }) {
  return (
    <abbr
      title="Game master"
      aria-label="Game master"
      className={cn(
        "mr-1 inline-block select-none rounded-[3px] bg-[#ffd84a] px-[3px] align-[1px] text-[8px] font-bold not-italic leading-[11px] tracking-wide text-black no-underline",
        className,
      )}
    >
      GM
    </abbr>
  );
}
