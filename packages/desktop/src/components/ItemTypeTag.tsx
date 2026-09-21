import {
  getItemSet,
  getItemType,
  ITEM_TYPE_LABELS,
  type ItemDef,
  type ItemType,
  STAT_KEYS,
  STAT_LABELS,
} from "@herzies/shared";
import { cn } from "../lib/utils";
import { Tooltip } from "./Tooltip";

export const ITEM_TYPE_TEXT_CLASSES: Record<ItemType, string> = {
  skin: "text-purple",
  sceneryCard: "text-green",
  equipable: "text-cyan",
  accessory: "text-red",
  modifier: "text-yellow",
  artefact: "text-text-dim",
};

export const ITEM_TYPE_PILL_CLASSES: Record<ItemType, string> = {
  skin: "bg-purple/15 text-purple",
  sceneryCard: "bg-green/15 text-green",
  equipable: "bg-cyan/15 text-cyan",
  accessory: "bg-red/15 text-red",
  modifier: "bg-yellow/15 text-yellow",
  artefact: "bg-text-dim/15 text-text-dim",
};

/** Labels an item's type (skin / scenery card / equipable / accessory / modifier / artefact). */
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
          ? cn(
              "rounded-full px-1.5 py-px text-ui-sm",
              ITEM_TYPE_PILL_CLASSES[type],
            )
          : ITEM_TYPE_TEXT_CLASSES[type],
        className,
      )}
    >
      {ITEM_TYPE_LABELS[type]}
    </span>
  );
}

/** Names the set an item belongs to (e.g. "Prismatic"); hover for what
 * equipping the full set does. Renders nothing for items not in a set. */
export function SetTag({
  itemId,
  className,
}: {
  itemId: string;
  className?: string;
}) {
  const set = getItemSet(itemId);
  if (!set) return null;
  return (
    <Tooltip label={set.effect}>
      <span
        className={cn(
          "rounded-full border border-border bg-bg px-1.5 py-px text-ui-sm text-text-dim",
          className,
        )}
      >
        {set.name}
      </span>
    </Tooltip>
  );
}

/** The stats an item adds to its wearer, one per line (e.g. "Sonic power:
 * +10"). Renders nothing on items without any — most have none. */
export function ItemStatLines({
  item,
  className,
}: {
  item: Pick<ItemDef, "stats">;
  className?: string;
}) {
  const keys = STAT_KEYS.filter((key) => item.stats?.[key]);
  if (keys.length === 0) return null;
  return (
    <div className={cn("text-ui-sm text-cyan", className)}>
      {keys.map((key) => (
        <div key={key}>
          {STAT_LABELS[key]}: +{item.stats?.[key]}
        </div>
      ))}
    </div>
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
    <Tooltip label={item.modifier.tooltip}>
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
