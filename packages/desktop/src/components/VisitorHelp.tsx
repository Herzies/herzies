import { getItem, RARITY_COLORS as ITEM_RARITY_COLORS } from "@herzies/shared";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { PixelIcon } from "./icons/PixelIcon";
import { HoverPreview } from "./Tooltip";

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

/**
 * The "?" bubble in a visitor's header: what the visit is about and what it pays.
 * Every visitor puts its rewards here rather than in its own panel, so they
 * read the same way across Town.
 *
 * Built on `HoverPreview`, not `Tooltip`: Tooltip is `whitespace-nowrap` and
 * chases the cursor, which is right for a short label and wrong for a
 * paragraph — a multi-line string would run off the 380px window. HoverPreview
 * already solves the anchored, sized, portalled case.
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
  const shown = rewards.flatMap((r) => {
    const item = getItem(r.itemId);
    return item ? [{ ...r, item }] : [];
  });
  return (
    <HoverPreview
      // Anchored under the icon: it lives in the header, so there is never
      // room above it.
      alwaysAbove={false}
      // estWidth/estHeight only steer placement, but they have to track the
      // real footprint or the popover is centred and fit-checked against the
      // wrong box — hence the matching w-[220px].
      estWidth={220}
      estHeight={64 + shown.length * 20}
      content={
        <div className="w-[220px] rounded border border-border bg-bg-panel p-2 text-left text-ui text-text-dim">
          <div>{text}</div>
          {shown.length > 0 && (
            <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
              {shown.map(({ label: what, item, note }) => (
                <div key={what} className="flex items-center gap-1">
                  <span className="shrink-0">{what}:</span>
                  <ItemTypeIcon item={item} className="h-4 w-4 shrink-0" />
                  <span
                    className="truncate"
                    style={{ color: ITEM_RARITY_COLORS[item.rarity] }}
                  >
                    {item.name}
                  </span>
                  {note && (
                    <span className="shrink-0 text-ui-sm">· {note}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      }
    >
      <button
        type="button"
        className="flex cursor-help border-none bg-transparent p-0 transition-[filter] duration-100 hover:brightness-150"
        aria-label={label}
      >
        <PixelIcon
          grid={BUBBLE}
          palette={[colour, BUBBLE_FILL]}
          className="h-5 w-5"
        />
      </button>
    </HoverPreview>
  );
}
