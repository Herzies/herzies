import type { ActiveMultiplier } from "@herzies/shared";
import { cn } from "../lib/utils";
import { HEADER_ICON_HIT } from "./headerIconHit";
import { Tooltip } from "./Tooltip";

/** Wide enough that the name/bonus columns don't sit on top of each other. */
const CARD_WIDTH = 150;

/**
 * Header icon that reveals the active XP modifiers on hover, so the list
 * doesn't take up space on the home screen itself. `null` means the server
 * hasn't sent multipliers (logged out), which differs from an empty list
 * (logged in, nothing active right now).
 *
 * Rides on `Tooltip` rather than the anchored `HoverPreview` so it tracks the
 * cursor like every other tooltip in the header — the bubble already supplies
 * the panel chrome, so the content below is bare rows.
 */
export function ModifiersButton({
  multipliers,
}: {
  multipliers: ActiveMultiplier[] | null;
}) {
  const hasActive = !!multipliers && multipliers.length > 0;

  const card = (
    <div className="text-[10px]" style={{ minWidth: CARD_WIDTH }}>
      <div className="mb-0.5 text-ui-sm font-bold text-text">Modifiers</div>
      {!multipliers ? (
        <div className="text-text-dim">Log in to get bonuses</div>
      ) : multipliers.length === 0 ? (
        <div className="text-text-dim">No active bonuses</div>
      ) : (
        multipliers.map((m) => (
          <div key={m.name} className="flex justify-between gap-2">
            <span className="text-yellow">★ {m.name}</span>
            <span className="text-green">+{Math.round(m.bonus * 100)}%</span>
          </div>
        ))
      )}
    </div>
  );

  return (
    <Tooltip label={card}>
      <button
        type="button"
        className={cn(
          HEADER_ICON_HIT,
          "flex h-5 w-5 cursor-default items-center justify-center rounded-lg border-none bg-transparent p-0",
          hasActive ? "text-yellow" : "text-text-dim hover:text-text",
        )}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-label="Modifiers"
          role="img"
        >
          <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
          <path d="M20 3v4" />
          <path d="M22 5h-4" />
        </svg>
      </button>
    </Tooltip>
  );
}
