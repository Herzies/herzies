import { getItem } from "@herzies/shared";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { List } from "./List";

const EDGE_PADDING = 8;
const CURSOR_GAP = 4;
/** Positioning estimates — which side of the cursor to open on is decided
 * from these, but the box is then placed with a `translate()` by its own
 * real size, so a list narrower or shorter than the estimate still hugs the
 * cursor instead of leaving a gap (same idiom as `Tooltip`). */
const EST_WIDTH = 150;
const ROW_HEIGHT = 22;
/** py-1 top and bottom, plus the slot-name header row. */
const CHROME_HEIGHT = 8 + 18;
/** Roughly six rows before it starts scrolling — enough to browse without
 * the box growing tall enough to cover the deck it's being placed into. */
const MAX_LIST_HEIGHT = 132;

/** Floating list of the items a given deck slot can take, anchored at a
 * point (the clicked empty slot). Deliberately a sibling of `ContextMenu`
 * rather than built on it — same chrome and dismiss behaviour, but its rows
 * are an icon beside the item name and the list scrolls, which a flat list
 * of label-only menu items can't express. Portals to `document.body` so it
 * isn't clipped by the deck's own scroll container.
 *
 * `itemIds` is already filtered to what the slot accepts and what the
 * player owns unplaced; an empty list still opens the box, showing why
 * nothing can go there rather than swallowing the click. */
export function DeckSlotPicker({
  x,
  y,
  slotLabel,
  itemIds,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  /** Names the slot being filled, e.g. "Head" — the Equipment boxes look
   * alike, so without this an empty list reads as a bug. */
  slotLabel: string;
  itemIds: string[];
  onPick: (itemId: string) => void;
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
    // Capture-phase, so it also sees a scroll on some ancestor that doesn't
    // bubble — but the box doesn't follow its anchor, and scrolling the
    // list *inside* it must not dismiss it, so its own scroller is exempt.
    const handleScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  const estHeight =
    Math.min(Math.max(itemIds.length, 1) * ROW_HEIGHT, MAX_LIST_HEIGHT) +
    CHROME_HEIGHT;
  const fitsRight =
    x + CURSOR_GAP + EST_WIDTH <= window.innerWidth - EDGE_PADDING;
  const fitsBelow =
    y + CURSOR_GAP + estHeight <= window.innerHeight - EDGE_PADDING;

  return createPortal(
    <div
      ref={ref}
      // z-250 to match ContextMenu — both open over the expanded chat panel.
      className="fixed z-250 w-[150px] border border-border bg-bg-panel py-1 text-ui shadow-lg"
      style={{
        left: fitsRight ? x + CURSOR_GAP : x - CURSOR_GAP,
        top: fitsBelow ? y + CURSOR_GAP : y - CURSOR_GAP,
        transform: `translate(${fitsRight ? "0" : "-100%"}, ${fitsBelow ? "0" : "-100%"})`,
      }}
    >
      <div className="truncate px-3 pb-1 text-[10px] text-text-dim">
        {slotLabel}
      </div>
      {itemIds.length === 0 ? (
        <div className="px-3 py-1 text-ui-sm text-text-dim">
          Nothing to place
        </div>
      ) : (
        <List className="max-h-[132px]">
          {itemIds.map((itemId) => {
            const def = getItem(itemId);
            // No owned-quantity badge, unlike the bank grid: duplicates of an
            // item collapse into one row here (equip state is per item id, so
            // placing "one of your two" is the same move either way), which
            // makes the count say nothing about the click being offered — and
            // these rows are narrow enough that it would truncate the name to
            // show it.
            return (
              <button
                key={itemId}
                type="button"
                className="flex w-full cursor-pointer items-center gap-1.5 border-none bg-transparent px-3 py-1 text-left text-text hover:bg-white/5"
                onClick={() => onPick(itemId)}
              >
                {def && (
                  <ItemTypeIcon item={def} className="h-3 w-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {def?.name ?? itemId}
                </span>
              </button>
            );
          })}
        </List>
      )}
    </div>,
    document.body,
  );
}
