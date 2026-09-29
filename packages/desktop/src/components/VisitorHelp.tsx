import { getItem, RARITY_COLORS as ITEM_RARITY_COLORS } from "@herzies/shared";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { HoverPreview } from "./Tooltip";

export type VisitorReward = {
  /** What earns it, e.g. "Reward" or "Top 3 bonus". */
  label: string;
  itemId: string;
  /** Small dim note after the item, e.g. "46 left". */
  note?: string;
};

/**
 * The "?" in a visitor's header: what the visit is about and what it pays.
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
}: {
  text: React.ReactNode;
  rewards?: VisitorReward[];
  /** aria-label for the "?" button. */
  label: string;
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
        className="cursor-help border-none bg-transparent text-ui text-text-dim hover:text-cyan"
        aria-label={label}
      >
        ?
      </button>
    </HoverPreview>
  );
}
