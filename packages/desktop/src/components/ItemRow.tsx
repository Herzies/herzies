import { getItem } from "@herzies/shared";
import { cn } from "../lib/utils";
import type { TabColour } from "./TabButton";

/** One inventory/store row: name + subtitle on the left, an optional action on the right. */
export function ItemRow({
  itemId,
  onInspect,
  inspectTitle = "Inspect item",
  colour = "cyan",
  subtitle,
  action,
}: {
  itemId: string;
  onInspect: (itemId: string) => void;
  inspectTitle?: string;
  colour?: TabColour;
  subtitle: React.ReactNode;
  action?: React.ReactNode;
}) {
  const def = getItem(itemId);
  const name = def?.name ?? itemId;

  return (
    <div className="flex items-center justify-between gap-2 border-b border-[#222] py-1.5">
      <button
        type="button"
        onClick={() => onInspect(itemId)}
        className="group min-w-0 flex-1 cursor-pointer text-left"
        title={inspectTitle}
      >
        <div
          className={cn("truncate text-ui text-text", {
            "group-hover:text-cyan": colour === "cyan",
            "group-hover:text-green": colour === "green",
            "group-hover:text-yellow": colour === "yellow",
            "group-hover:text-red": colour === "red",
          })}
        >
          {name}
        </div>
        <div className="text-[10px] text-text-dim">{subtitle}</div>
      </button>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
