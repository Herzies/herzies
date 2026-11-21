import { getTitle, RARITY_COLORS } from "@herzies/shared";
import { cn } from "../../lib/utils";

/** A worn title as it's drawn: its name, in its rarity's colour. Null for
 * none (or one this app doesn't know yet). */
export function titleLook(
  id: string | null | undefined,
): { name: string; color: string } | null {
  const t = getTitle(id);
  return t ? { name: t.name, color: RARITY_COLORS[t.rarity] } : null;
}

/** The title under a name (titles.ts), small and in its rarity's colour;
 * nothing without one. */
export function TitleLine({
  id,
  className,
}: {
  id: string | null | undefined;
  className?: string;
}) {
  const t = titleLook(id);
  if (!t) return null;
  return (
    <div
      className={cn("truncate leading-tight", className)}
      style={{ color: t.color }}
    >
      {t.name}
    </div>
  );
}
