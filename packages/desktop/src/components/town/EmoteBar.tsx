import { getEmote } from "@herzies/shared";
import { cn } from "../../lib/utils";
import { Tooltip } from "../Tooltip";
import { useCombat } from "./combat/state";
import { playEmote, useAltHeld, useOwnedEmotes } from "./emotes";

/**
 * The Alt bar: shown while Alt is held, just over the hotbar. One slot per
 * emote you own, in catalog order, on Alt+1, Alt+2… (input.ts); a click
 * plays one too. With none it says where to get them, and while aiming
 * (combat mode, where emotes don't play) it says that instead.
 */
export function EmoteBar({ className }: { className?: string }) {
  const held = useAltHeld();
  const owned = useOwnedEmotes();
  const aiming = useCombat();
  if (!held) return null;
  const note = aiming
    ? "Can't emote while aiming"
    : owned.length === 0
      ? "No emotes yet. Find them in Premium."
      : null;
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-30 flex justify-center gap-1",
        className,
      )}
    >
      {note ? (
        <div className="whitespace-nowrap rounded border border-white/20 bg-black/55 px-2 py-1 text-[11px] text-white/80">
          {note}
        </div>
      ) : (
        owned.map((id, i) => {
          const emote = getEmote(id);
          const key = String(i + 1);
          return (
            <Tooltip key={id} label={`${emote?.name ?? id} (Alt+${key})`}>
              <button
                type="button"
                aria-label={`Alt+${key}: ${emote?.name ?? id}`}
                // Keep the focus where it was: a focused button would take
                // the next Space as a click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => playEmote(id)}
                className="pointer-events-auto relative flex size-9 cursor-pointer items-end justify-center rounded border border-white/20 bg-black/55 p-0 pb-1"
              >
                <span className="absolute top-0 left-0.5 text-[9px] leading-none text-white/70">
                  {key}
                </span>
                <span className="text-[10px] leading-none text-white">
                  {emote?.name ?? id}
                </span>
              </button>
            </Tooltip>
          );
        })
      )}
    </div>
  );
}
