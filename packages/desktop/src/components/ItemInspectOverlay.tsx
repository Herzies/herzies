import {
  getItem,
  getItemSet,
  type Inventory,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  ItemPreview,
  RARITY_LABELS,
} from "@herzies/shared";
import { useEffect } from "react";
import { cn } from "../lib/utils";
import { ItemTypeTag, ModifierEffectTag, SetTag } from "./ItemTypeTag";

export default function ItemInspectOverlay({
  itemId,
  onClose,
  meta,
  footer,
  inventory,
}: {
  itemId: string;
  onClose: () => void;
  /** Extra line shown next to the rarity label (e.g. owned quantity). */
  meta?: React.ReactNode;
  /** Actions rendered below the description (e.g. equip / sell controls). */
  footer?: React.ReactNode;
  /** Owned quantities, used to show set-completion progress (e.g. "Prismatic set 1/2"). */
  inventory?: Inventory | null;
}) {
  const item = getItem(itemId);
  const set = getItemSet(itemId);
  const ownedCount =
    set?.itemIds.filter((id) => (inventory?.[id] ?? 0) > 0).length ?? 0;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!item) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[260px] max-w-full border border-border bg-bg-panel p-4 text-center"
      >
        <div className="relative mb-4 flex justify-center">
          <div className="absolute top-0 left-0 flex gap-1">
            <ItemTypeTag item={item} />
            <ModifierEffectTag item={item} />
          </div>
          <div className="absolute top-0 right-0 flex">
            <SetTag itemId={itemId} />
          </div>
          <ItemPreview item={item} box={150} />
        </div>
        <div className="text-sm font-bold">"{item.name}"</div>
        <div
          className="mb-1 text-ui-sm"
          style={{ color: ITEM_RARITY_COLORS[item.rarity] }}
        >
          {RARITY_LABELS[item.rarity]}
          {meta ? <> · {meta}</> : null}
        </div>
        <div className="text-ui text-text-dim">{item.description}</div>
        {set && (
          <div className="mt-2 border-t border-border pt-2 text-left text-ui-sm">
            <div className="font-bold text-text">
              {set.name} set {ownedCount}/{set.itemIds.length}
            </div>
            <div className="my-1 text-text-dim">Set effect: {set.effect}</div>
            {set.itemIds.map((id) => (
              <div
                key={id}
                className={cn(
                  (inventory?.[id] ?? 0) > 0 ? "text-white" : "text-text-dim",
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
    </div>
  );
}
