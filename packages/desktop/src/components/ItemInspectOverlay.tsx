import {
  getItem,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  ItemDisplay,
  RARITY_LABELS,
} from "@herzies/shared";
import { useEffect } from "react";

export default function ItemInspectOverlay({
  itemId,
  onClose,
}: {
  itemId: string;
  onClose: () => void;
}) {
  const item = getItem(itemId);

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
        className="max-w-[260px] border border-border bg-bg-panel p-4 text-center"
      >
        <div className="mb-2 flex justify-center">
          <ItemDisplay item={item} size={9} />
        </div>
        <div
          className="text-sm font-bold"
          style={{ color: ITEM_RARITY_COLORS[item.rarity] }}
        >
          {item.name}
        </div>
        <div className="mb-1 text-ui text-text-dim">
          {RARITY_LABELS[item.rarity]}
        </div>
        <div className="text-ui text-text-dim">{item.description}</div>
      </div>
    </div>
  );
}
