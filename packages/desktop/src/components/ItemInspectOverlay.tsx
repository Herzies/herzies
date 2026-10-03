import {
  type Equipped,
  equippedItemIds,
  getItem,
  getItemSet,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  ItemPreview,
  RARITY_LABELS,
} from "@herzies/shared";
import { useEffect } from "react";
import { cn } from "../lib/utils";
import {
  ItemStatLines,
  ItemTypeTag,
  ModifierEffectTag,
  SetTag,
} from "./ItemTypeTag";

/** The full item preview card — art, type/set tags, name, rarity (+ optional
 * `meta`, e.g. owned quantity), stats, description, and set-completion progress.
 * Used both as the content of the click-to-inspect modal (with `footer`
 * actions) and, footer-less, as a hover preview in the inventory grid. */
export function ItemPreviewCard({
  itemId,
  meta,
  footer,
  equipped,
  level = 0,
  box = 150,
  className,
}: {
  itemId: string;
  /** Extra line shown next to the rarity label (e.g. owned quantity). */
  meta?: React.ReactNode;
  /** Actions rendered below the description (e.g. equip / sell controls). */
  footer?: React.ReactNode;
  /** Current deck, used to show set progress (e.g. "Prismatic set 1/2") —
   * a set effect is only active while its members are equipped, so owning
   * them isn't enough. */
  equipped?: Equipped | null;
  /** Current dice-upgrade level (0-MAX_ITEM_UPGRADE_LEVEL) — renders as a
   * "+N" next to the name and feeds ItemStatLines' effective totals. */
  level?: number;
  /** Art canvas footprint (px) — see `ItemPreview`'s `box`. */
  box?: number;
  className?: string;
}) {
  const item = getItem(itemId);
  const set = getItemSet(itemId);
  const equippedIds = new Set(equippedItemIds(equipped));
  const equippedCount =
    set?.itemIds.filter((id) => equippedIds.has(id)).length ?? 0;

  if (!item) return null;

  return (
    <div
      className={cn(
        "w-65 max-w-full border border-border bg-bg-panel p-2 text-center shadow-xl shadow-black/50",
        className,
      )}
    >
      <div className="relative mb-4 flex justify-center">
        <div className="absolute top-0 left-0 flex gap-1">
          <ItemTypeTag item={item} />
          <ModifierEffectTag item={item} />
        </div>
        <div className="absolute top-0 right-0 flex">
          <SetTag itemId={itemId} />
        </div>
        <ItemPreview item={item} box={box} />
      </div>
      <div className="text-sm font-bold">
        "{item.name}"{level > 0 ? ` +${level}` : ""}
      </div>
      <div
        className="my-1 text-ui-sm"
        style={{ color: ITEM_RARITY_COLORS[item.rarity] }}
      >
        {RARITY_LABELS[item.rarity]}
        {meta ? <> · {meta}</> : null}
      </div>
      <ItemStatLines item={item} level={level} className="mb-1" />
      <div className="text-ui-sm text-text-dim">{item.description}</div>
      {set && (
        <div className="mt-2 border-t border-border pt-2 text-left text-ui-sm">
          <div className="font-bold text-text">
            {set.name} set {equippedCount}/{set.itemIds.length}
          </div>
          <div className="my-1 text-text-dim">Set effect: {set.effect}</div>
          {set.itemIds.map((id) => (
            <div
              key={id}
              className={cn(
                equippedIds.has(id) ? "text-white" : "text-text-dim",
              )}
            >
              • {getItem(id)?.name ?? id}
            </div>
          ))}
        </div>
      )}
      {footer && (
        <div className="mt-3 flex flex-col items-center gap-2">{footer}</div>
      )}
    </div>
  );
}

/** The condensed hover preview for the bag and the deck: name, type, stats and
 * set progress — no art, icon, rarity or description, so it reads at a glance
 * while browsing. Right-click → Inspect opens the full card. */
export function CompactItemPreview({
  itemId,
  equipped,
  level = 0,
}: {
  itemId: string;
  /** Current deck — for set progress, as in ItemPreviewCard. */
  equipped?: Equipped | null;
  level?: number;
}) {
  const item = getItem(itemId);
  const set = getItemSet(itemId);
  if (!item) return null;
  const equippedIds = new Set(equippedItemIds(equipped));
  const setCount = set?.itemIds.filter((id) => equippedIds.has(id)).length;

  return (
    // Text only, no icon: the card's own tile is right there under the cursor.
    <div className="w-[180px] border border-border bg-bg-panel p-2 text-left shadow-xl shadow-black/50">
      <div className="text-ui font-bold leading-4 text-text">
        {item.name}
        {level > 0 ? <span className="text-cyan"> +{level}</span> : null}
      </div>
      <div className="text-ui-sm">
        <ItemTypeTag item={item} variant="text" />
      </div>
      {/* No margins, so the lines are evenly spaced. */}
      <ItemStatLines item={item} level={level} dim className="text-left" />
      {set && (
        <div className="text-ui-sm text-text-dim">
          {set.name} set {setCount}/{set.itemIds.length}
        </div>
      )}
    </div>
  );
}

export default function ItemInspectOverlay({
  itemId,
  onClose,
  meta,
  footer,
  equipped,
  level,
}: {
  itemId: string;
  onClose: () => void;
  /** Extra line shown next to the rarity label (e.g. owned quantity). */
  meta?: React.ReactNode;
  /** Actions rendered below the description (e.g. equip / sell controls). */
  footer?: React.ReactNode;
  /** Current deck, used to show set progress (e.g. "Prismatic set 1/2") —
   * a set effect is only active while its members are equipped, so owning
   * them isn't enough. */
  equipped?: Equipped | null;
  /** Current dice-upgrade level — see ItemPreviewCard. */
  level?: number;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!getItem(itemId)) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70"
    >
      <div onClick={(e) => e.stopPropagation()}>
        <ItemPreviewCard
          itemId={itemId}
          meta={meta}
          footer={footer}
          equipped={equipped}
          level={level}
        />
      </div>
    </div>
  );
}
