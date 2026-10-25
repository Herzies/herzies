import { useEffect } from "react";
import { cn } from "../lib/utils";
import { ExpBar, HpBar } from "./SquareBar";
import { refreshVitals, useLiveHp } from "./town/vitals";

/** Publishes the Town's player card's bottom edge (from the window's top)
 * as `--player-card-bottom`: the Town's big window hangs its windows under
 * it (OverlayWindow). */
const cardObserver = new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty(
    "--player-card-bottom",
    `${(entry.target as HTMLElement).getBoundingClientRect().bottom}px`,
  );
});
export function observePlayerCard(el: HTMLElement | null) {
  cardObserver.disconnect();
  if (el) cardObserver.observe(el);
}

/** The card they sit in with the name and level, top left on Home and in
 * the Town: frosted, rounded, the same width for everyone. Its tint
 * matches the chat card's where it is: PLAYER_CARD_HOME / PLAYER_CARD_TOWN. The card
 * is the backing, so nothing in it needs a text shadow (the bars' labels
 * carry one for the open world). */
export const PLAYER_CARD =
  // One width for everyone: what the longest name (20 characters at 13px
  // in the 0.6em-wide mono, 156px) needs, plus px-2 and the border. The
  // level and class line ("Lv. 999 · Record Slinger") is narrower.
  "w-[174px] rounded-xl border border-white/12 px-2 pt-1 pb-2 backdrop-blur-md [&_*]:[text-shadow:none]";
export const PLAYER_CARD_HOME = "bg-white/[0.03]";
export const PLAYER_CARD_TOWN = "bg-black/45";

/**
 * The herzie's health and experience, under its name on Home and in the
 * Town alike. (The modifiers star is on the now-playing box.)
 */
export function PlayerBars({
  level,
  progress,
  xp,
  className,
}: {
  level: number;
  /** 0..1 through the current level. */
  progress: number;
  /** Total XP, for the exp bar's tooltip. */
  xp?: number;
  className?: string;
}) {
  const live = useLiveHp();
  // Health is fetched when the Town opens; on Home first, ask for it here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, if nothing's known yet
  useEffect(() => {
    if (!live) refreshVitals();
  }, []);

  return (
    <div className={cn("flex flex-col gap-[3px]", className)}>
      {live && (
        <HpBar
          hp={live.down ? 0 : live.hp}
          maxHp={live.maxHp}
          className="min-w-0"
        />
      )}
      <ExpBar progress={progress} level={level} xp={xp} className="min-w-0" />
    </div>
  );
}
