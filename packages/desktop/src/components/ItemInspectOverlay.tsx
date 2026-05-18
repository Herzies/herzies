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
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1a1a1a",
          border: "1px solid #333",
          padding: 16,
          maxWidth: 260,
          textAlign: "center",
        }}
      >
        <div
          style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}
        >
          <ItemDisplay item={item} size={9} />
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: "bold",
            color: ITEM_RARITY_COLORS[item.rarity],
          }}
        >
          {item.name}
        </div>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
          {RARITY_LABELS[item.rarity]}
        </div>
        <div style={{ fontSize: 11, color: "#aaa" }}>{item.description}</div>
      </div>
    </div>
  );
}
