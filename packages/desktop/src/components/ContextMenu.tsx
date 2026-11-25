import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "../lib/escapeStack";

const EDGE_PADDING = 8;
const MENU_WIDTH = 120;
/** Wide enough for an item with its hint beside it. */
const MENU_WIDTH_HINTED = 200;
const ITEM_HEIGHT = 24;
const HEADING_HEIGHT = 34;

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  /** Shown but not clickable, with `hint` saying why. */
  disabled?: boolean;
  /** A short word on the right ("Get closer"). */
  hint?: string;
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
  heading,
  closeOnScroll = true,
  numbered = false,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Over the items: whose menu it is (a name, its title). */
  heading?: ReactNode;
  /** Close when anything scrolls, since the menu doesn't follow its anchor.
   * Set false where the container scrolls itself (the chat feed auto-scrolls
   * to the newest message), which would otherwise dismiss the menu on its
   * own a moment after it opened. */
  closeOnScroll?: boolean;
  /** Number the items `[1]`, `[2]`…: while open, those keys pick them,
   * ahead of anything else on them (the Town's hotbar). */
  numbered?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", handlePointerDown);
    if (closeOnScroll) window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, closeOnScroll]);
  useEscape(onClose);
  useEffect(() => {
    if (!numbered) return;
    // Capturing on window runs before the Town's own (bubbling) listener,
    // and stopping it there keeps the hotbar from also firing.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !e.code.startsWith("Digit"))
        return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      )
        return;
      const item = items[Number(e.code.slice(5)) - 1];
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat && !item.disabled) item.onClick();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [numbered, items]);

  const width = items.some((i) => i.hint) ? MENU_WIDTH_HINTED : MENU_WIDTH;
  const left = Math.min(x, window.innerWidth - width - EDGE_PADDING);
  const top = Math.min(
    y,
    window.innerHeight -
      items.length * ITEM_HEIGHT -
      (heading ? HEADING_HEIGHT : 0) -
      EDGE_PADDING,
  );

  return createPortal(
    <div
      ref={ref}
      // z-250 clears the expanded chat panel (z-201) and its backdrop, which
      // the menu now opens over when a username is clicked.
      className="fixed z-250 border border-white/15 bg-bg-panel py-1 text-ui shadow-lg"
      style={{ left, top, minWidth: width }}
    >
      {heading ? (
        <div className="mb-1 border-b border-white/10 px-3 pt-0.5 pb-1.5">
          {heading}
        </div>
      ) : null}
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          disabled={item.disabled}
          className="flex w-full cursor-pointer items-center justify-between gap-3 border-none bg-transparent px-3 py-1 text-left text-text hover:bg-white/5 disabled:cursor-default disabled:text-text-dim disabled:hover:bg-transparent"
          onClick={item.onClick}
        >
          <span>
            {numbered ? (
              <span className="mr-1.5 text-text-dim">[{i + 1}]</span>
            ) : null}
            {item.label}
          </span>
          {item.hint ? (
            <span className="text-ui-sm text-text-dim">{item.hint}</span>
          ) : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
