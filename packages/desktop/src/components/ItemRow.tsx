import { getItem, getItemType } from "@herzies/shared";
import { cn } from "../lib/utils";
import { ITEM_TYPE_TEXT_CLASSES } from "./ItemTypeTag";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
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
  const type = def ? getItemType(def) : null;

  return (
    <div className="flex items-center justify-between gap-2 border-b border-[#222] py-1.5">
      <button
        type="button"
        onClick={() => onInspect(itemId)}
        className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        title={inspectTitle}
      >
        {type && (
          <ItemTypeIcon
            type={type}
            className={cn("h-4 w-4 shrink-0", ITEM_TYPE_TEXT_CLASSES[type])}
          />
        )}
        <div className="min-w-0 flex-1">
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
        </div>
      </button>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
