import type { HerzieProfile } from "@herzies/shared";
import { Tooltip } from "./Tooltip";

/** Good Eye, Sniper's card red (`renderGoodEyeSniperFrame` in
 * shared/src/items.ts) — song hunt wins are what that item tracks, so the
 * badge wears its colour. */
const GOOD_EYE_SNIPER_RED = "#e05050";

/** The theme's --color-yellow, inlined because these badges colour an inline
 * `style` rather than a Tailwind class (see the render below). */
const RANK_ONE_YELLOW = "#facc15";

/** One earned badge: a small icon, optionally with the count it stands for. */
interface Badge {
  key: string;
  /** Tooltip text, already pluralized. */
  label: string;
  /** Rendered beside the icon. Omitted by a badge that stands for a rank
   * rather than a tally, or whose icon already carries its number. */
  count?: number;
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

/** Filled circle with a "1" knocked out of it — top of the global XP
 * leaderboard. Drawn as a filled disc with the digit in the page background
 * colour rather than a stroked ring with a glyph, so it still reads as a "1"
 * at the 12px these render at. */
function RankOneIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      aria-hidden="true"
      role="img"
    >
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="14"
        fontWeight="bold"
        fill="var(--color-bg)"
      >
        1
      </text>
    </svg>
  );
}

/**
 * Badges earned by a herzie, shown in the top-right of the profile header.
 * Each one is an icon, optionally followed by the count it stands for, with
 * the full sentence in a hover tooltip. Built as a list so future badges are
 * one entry rather than another layout change. A tally badge with a zero (or
 * missing) count isn't rendered at all; a rank badge carries no count.
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

  // rank() in herzie_ranks ties rather than breaking ties arbitrarily (see
  // migration 00056), so equal-XP herzies can all be #1 and all wear this.
  if (profile.globalRank === 1) {
    badges.push({
      key: "rank-one",
      label: "Ranked #1 globally",
      icon: <RankOneIcon />,
      colour: RANK_ONE_YELLOW,
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
