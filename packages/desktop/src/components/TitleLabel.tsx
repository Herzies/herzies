import { cn } from "../lib/utils";
import { titleName, WORN_TITLE_COLOUR } from "./town/TitleLine";

/** A worn title as it reads under a name, inline: grey like every worn
 * title (see TitleLine). Nothing for no title (or one this app
 * doesn't know yet). */
export function TitleLabel({
  id,
  className,
}: {
  id: string | null | undefined;
  className?: string;
}) {
  const name = titleName(id);
  if (!name) return null;
  return (
    <span className={cn(className)} style={{ color: WORN_TITLE_COLOUR }}>
      {name}
    </span>
  );
}
