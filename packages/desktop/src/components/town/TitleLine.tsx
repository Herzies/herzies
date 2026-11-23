import { getTitle, RARITY_COLORS } from "@herzies/shared";
import { cn } from "../../lib/utils";

/** The colour a worn title is drawn in on a card or a profile: common's
 * grey, whatever its rarity, so a name reads first and a title second (the
 * rarity shows in the Titles tab, and on the toast when it's earned). Over
 * a head it's the name's white, small enough to read second anyway. */
export const WORN_TITLE_COLOUR = RARITY_COLORS.common;

/** A worn title's name. Null for none (or one this app doesn't know yet). */
export function titleName(id: string | null | undefined): string | null {
  return getTitle(id)?.name ?? null;
}

/** The title under a name on a card (the duel's, a player's menu), small
 * and grey; nothing without one. */
export function TitleLine({
  id,
  className,
}: {
  id: string | null | undefined;
  className?: string;
}) {
  const name = titleName(id);
  if (!name) return null;
  return (
    <div
      className={cn("truncate leading-tight", className)}
      style={{ color: WORN_TITLE_COLOUR }}
    >
      {name}
    </div>
  );
}
