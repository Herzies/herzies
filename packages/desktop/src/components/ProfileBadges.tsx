import type { HerzieProfile } from "@herzies/shared";
import { Tooltip } from "./Tooltip";

/** Good Eye, Sniper's card red (`renderGoodEyeSniperFrame` in
 * shared/src/items.ts) — song hunt wins are what that item tracks, so the
 * badge wears its colour. */
const GOOD_EYE_SNIPER_RED = "#e05050";

/** One earned badge: a small icon with the count it stands for. */
interface Badge {
  key: string;
  /** Tooltip text, already pluralized. */
  label: string;
  count: number;
  icon: React.ReactNode;
  /** Icon/count colour, as a CSS colour. */
  colour: string;
}

/** Concentric rings — song hunt wins. */
function BullseyeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      role="img"
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

/**
 * Badges earned by a herzie, shown in the top-right of the profile header.
 * Each one is icon + count, with the full sentence in a hover tooltip. Built
 * as a list so future badges are one entry rather than another layout change;
 * a badge with a zero (or missing) count isn't rendered at all.
 */
export function ProfileBadges({ profile }: { profile: HerzieProfile }) {
  const badges: Badge[] = [];

  const wins = profile.songHuntWins ?? 0;
  if (wins > 0) {
    badges.push({
      key: "song-hunts",
      label: `${wins} song hunt${wins === 1 ? "" : "s"} won`,
      count: wins,
      icon: <BullseyeIcon />,
      colour: GOOD_EYE_SNIPER_RED,
    });
  }

  if (badges.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {badges.map((badge) => (
        <Tooltip key={badge.key} label={badge.label}>
          <span
            className="flex items-center gap-0.5 text-ui-sm font-bold"
            style={{ color: badge.colour }}
          >
            {badge.icon}
            {badge.count}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}
