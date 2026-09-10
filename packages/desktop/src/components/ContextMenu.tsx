import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const EDGE_PADDING = 8;
const MENU_WIDTH = 120;
const ITEM_HEIGHT = 24;

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
}

/** Small floating menu anchored at a point (e.g. a right-click position).
 * Portals to `document.body` so it isn't clipped by any ancestor. Closes on
 * an outside click, Escape, or scroll — callers own opening it (e.g. from
 * `onContextMenu`). */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - MENU_WIDTH - EDGE_PADDING);
  const top = Math.min(
    y,
    window.innerHeight - items.length * ITEM_HEIGHT - EDGE_PADDING,
  );

  return createPortal(
    <div
      ref={ref}
      className="fixed z-150 min-w-[120px] border border-border bg-bg-panel py-1 text-ui shadow-lg"
      style={{ left, top }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className="block w-full cursor-pointer border-none bg-transparent px-3 py-1 text-left text-text hover:bg-white/5"
          onClick={item.onClick}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
