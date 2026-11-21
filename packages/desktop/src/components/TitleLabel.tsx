import { getTitle, RARITY_COLORS } from "@herzies/shared";
import type { CSSProperties } from "react";
import { isGrandRarity } from "../lib/titles";
import { cn } from "../lib/utils";

/** A worn title as it reads under a name: in its rarity's colour, with a
 * slow glint across the legendary and mythic ones. Nothing for no title (or
 * one this app doesn't know yet). */
export function TitleLabel({
  id,
  className,
}: {
  id: string | null | undefined;
  className?: string;
}) {
  const def = getTitle(id);
  if (!def) return null;
  const colour = RARITY_COLORS[def.rarity];
  return (
    <span
      className={cn(isGrandRarity(def.rarity) && "title-glint", className)}
      // The glint is drawn from --title-colour (see globals.css).
      style={{ color: colour, "--title-colour": colour } as CSSProperties}
    >
      {def.name}
    </span>
  );
}
