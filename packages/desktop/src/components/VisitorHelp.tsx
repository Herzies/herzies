import { getItem, RARITY_COLORS as ITEM_RARITY_COLORS } from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { PixelIcon } from "./icons/PixelIcon";

export type VisitorReward = {
  /** What earns it, e.g. "Reward" or "Top 3 bonus". */
  label: string;
  itemId: string;
  /** Small dim note after the item, e.g. "46 left". */
  note?: string;
};

/** A pixel speech bubble with a "?" in it: the visitor has something to
 * tell you. 0 is the outline and the "?", 1 the bubble's dark fill. */
const BUBBLE = [
  "................",
  "..000000000000..",
  ".01111111111110.",
  ".01111000011110.",
  ".01110111101110.",
  ".01111111101110.",
  ".01111110011110.",
  ".01111101111110.",
  ".01111101111110.",
  ".01111111111110.",
  ".01111101111110.",
  ".01111111111110.",
  "..010000000000..",
  "..00............",
  "..0.............",
  "................",
];
const BUBBLE_FILL = "#0b0e16";

/** The popover's width; also what it's centred under the "?" by. */
const POPOVER_WIDTH = 220;
const EDGE_PADDING = 8;
const ANCHOR_GAP = 8;

/**
 * The "?" bubble in a visitor's header: what the visit is about and what it pays.
 * Every visitor puts its rewards here rather than in its own panel, so they
 * read the same way across Town.
 *
 * Opens on click and stays open — until a click outside it or Escape — so
 * the reward rows can be clicked: each opens that item's full preview.
 * Anchored under the icon (it lives in the header, so there's never room
 * above) and portalled, so the view's own clipping can't cut it off.
 */
export function VisitorHelp({
  text,
  rewards = [],
  label,
  colour,
}: {
  text: React.ReactNode;
  rewards?: VisitorReward[];
  /** aria-label for the "?" button. */
  label: string;
  /** The visitor's colour, for the bubble. */
  colour: string;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [inspectItemId, setInspectItemId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const open = anchor !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setAnchor(null);
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The "?" itself toggles; leave that to its own click.
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      close();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKey);
    // It doesn't follow its anchor, so a scroll anywhere closes it.
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const shown = rewards.flatMap((r) => {
    const item = getItem(r.itemId);
    return item ? [{ ...r, item }] : [];
  });

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="flex cursor-pointer border-none bg-transparent p-0 transition-[filter] duration-100 hover:brightness-150"
        aria-label={label}
        aria-expanded={open}
        onClick={() =>
          setAnchor(
            open
              ? null
              : // The icon, not the button: a flex parent can stretch the
                // button to its full height, and the popover would then open
                // far below the "?".
                (buttonRef.current?.firstElementChild?.getBoundingClientRect() ??
                  null),
          )
        }
      >
        <PixelIcon
          grid={BUBBLE}
          palette={[colour, BUBBLE_FILL]}
          className="h-5 w-5"
        />
      </button>

      {anchor &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-150 rounded border border-border bg-bg-panel p-2 text-left text-ui text-text-dim shadow-lg"
            style={{
              width: POPOVER_WIDTH,
              top: anchor.bottom + ANCHOR_GAP,
              left: Math.min(
                Math.max(
                  anchor.left + anchor.width / 2 - POPOVER_WIDTH / 2,
                  EDGE_PADDING,
                ),
                window.innerWidth - POPOVER_WIDTH - EDGE_PADDING,
              ),
            }}
          >
            <div>{text}</div>
            {shown.length > 0 && (
              <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
                {shown.map(({ label: what, item, note }) => (
                  <button
                    key={what}
                    type="button"
                    // The popover closes as the preview opens: the preview is
                    // a modal, and Escape or a click would close both anyway.
                    onClick={() => {
                      setAnchor(null);
                      setInspectItemId(item.id);
                    }}
                    className="group flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-left text-ui text-text-dim"
                  >
                    <span className="shrink-0">{what}:</span>
                    <ItemTypeIcon item={item} className="h-6 w-6 shrink-0" />
                    <span
                      className="truncate group-hover:underline"
                      style={{ color: ITEM_RARITY_COLORS[item.rarity] }}
                    >
                      {item.name}
                    </span>
                    {note && (
                      <span className="shrink-0 text-ui-sm">· {note}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}

      {inspectItemId && (
        <ItemInspectOverlay
          itemId={inspectItemId}
          onClose={() => setInspectItemId(null)}
        />
      )}
    </>
  );
}
