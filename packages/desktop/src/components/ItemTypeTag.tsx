import { getItemType, ITEM_TYPE_LABELS, type ItemDef, type ItemType } from "@herzies/shared";
import { cn } from "../lib/utils";
import { Tooltip } from "./Tooltip";

const ITEM_TYPE_TEXT_CLASSES: Record<ItemType, string> = {
  skin: "text-purple",
  wearable: "text-cyan",
  modifier: "text-yellow",
  artefact: "text-text-dim",
};

const ITEM_TYPE_PILL_CLASSES: Record<ItemType, string> = {
  skin: "bg-purple/15 text-purple",
  wearable: "bg-cyan/15 text-cyan",
  modifier: "bg-yellow/15 text-yellow",
  artefact: "bg-text-dim/15 text-text-dim",
};

/** Labels an item's type (skin / wearable / modifier / artefact). */
export function ItemTypeTag({
  item,
  className,
  /** "pill" for a standalone badge (e.g. over a preview); "text" to sit
   * inline in an existing metadata line (e.g. next to the rarity label). */
  variant = "pill",
}: {
  item: Pick<ItemDef, "equipable" | "equipSlot" | "modifier">;
  className?: string;
  variant?: "pill" | "text";
}) {
  const type = getItemType(item);
  return (
    <span
      className={cn(
        variant === "pill"
          ? cn("rounded-full px-1.5 py-px text-ui-sm", ITEM_TYPE_PILL_CLASSES[type])
          : ITEM_TYPE_TEXT_CLASSES[type],
        className,
      )}
    >
      {ITEM_TYPE_LABELS[type]}
    </span>
  );
}

/** Labels a modifier item's specific effect (e.g. "Exp boost"); hover for detail. Renders nothing on non-modifier items. */
export function ModifierEffectTag({
  item,
  className,
}: {
  item: Pick<ItemDef, "modifier">;
  className?: string;
}) {
  if (!item.modifier) return null;
  return (
    <Tooltip label={item.modifier.tooltip} align="left">
      <span
        className={cn(
          "rounded-full bg-yellow/15 px-1.5 py-px text-ui-sm text-yellow",
          className,
        )}
      >
        {item.modifier.label}
      </span>
    </Tooltip>
  );
}
