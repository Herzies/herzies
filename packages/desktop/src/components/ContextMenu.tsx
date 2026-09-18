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
 * an outside click or Escape — callers own opening it (e.g. from
 * `onContextMenu`). */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  closeOnScroll = true,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Close when anything scrolls, since the menu doesn't follow its anchor.
   * Set false where the container scrolls itself (the chat feed auto-scrolls
   * to the newest message), which would otherwise dismiss the menu on its
   * own a moment after it opened. */
  closeOnScroll?: boolean;
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
    if (closeOnScroll) window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, closeOnScroll]);

  const left = Math.min(x, window.innerWidth - MENU_WIDTH - EDGE_PADDING);
  const top = Math.min(
    y,
    window.innerHeight - items.length * ITEM_HEIGHT - EDGE_PADDING,
  );

  return createPortal(
    <div
      ref={ref}
      // z-250 clears the expanded chat panel (z-201) and its backdrop, which
      // the menu now opens over when a username is clicked.
      className="fixed z-250 min-w-[120px] border border-border bg-bg-panel py-1 text-ui shadow-lg"
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
