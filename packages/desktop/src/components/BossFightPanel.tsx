import type { BossFightView, Equipped, GameEvent } from "@herzies/shared";
import {
  BOSS_BODY_TYPE,
  DEFAULT_Y_ANGLE,
  generateCreatureParams,
  getItem,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  Herzie3D as SharedHerzie3D,
} from "@herzies/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { SegmentBar } from "./SegmentBar";
import { HoverPreview } from "./Tooltip";

/**
 * Time left, to the second.
 *
 * Every other countdown in the app is hour-granular and recomputed on the
 * 10s poll (formatCountdown in EventsView). That is fine for a week-long
 * hunt and wrong for a boss: the timer bar is half the tension, and a bar
 * that only moves every ten seconds looks broken.
 */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

/** "electronic" -> "electronic"; three -> "a, b and c". Reads as speech. */
function hatedPhrase(genres: string[]): string {
  if (genres.length === 0) return "all";
  if (genres.length === 1) return genres[0];
  return `${genres.slice(0, -1).join(", ")} and ${genres[genres.length - 1]}`;
}

const LINE_EVERY_MS = 10_000;
const LINE_VISIBLE_MS = 7_000;
/** Per character. ~28ms reads as deliberate rather than laggy. */
const TYPE_SPEED_MS = 28;

/**
 * What the boss says while you fight it.
 *
 * `above`/`below` gate a line to a band of remaining health (as a fraction),
 * so the boss talks its way down from dismissive to panicking rather than
 * saying the same things at 90% and 5%. Ungated lines can land at any point.
 * `{genre}` is substituted with the hated-genre phrase.
 */
const BOSS_LINES: { text: string; above?: number; below?: number }[] = [
  // Healthy — still in control, and cocky enough to give the game away.
  {
    text: "I probably shouldn't say this, but {genre} music is my Achilles heel.",
    above: 0.6,
  },
  { text: "You call that music?", above: 0.6 },
  { text: "Is that the best you've got?", above: 0.6 },

  // Any time.
  { text: "{genre} music is the worst." },
  { text: "I just want peace and quiet!" },
  { text: "Can you turn the volume down, please?" },
  { text: "Who put this playlist on?" },

  // Wearing down.
  { text: "I can feel my health declining...", below: 0.6 },
  { text: "I can't take much more of this {genre} music.", below: 0.6 },
  { text: "My horns are ringing.", below: 0.6 },

  // Nearly finished.
  { text: "Ahhhhhh!! My ears are bleeding!", below: 0.3 },
  { text: "Okay — OKAY! Enough!", below: 0.3 },
  { text: "Please. Anything but {genre}.", below: 0.3 },
];

/**
 * Cycles the boss's speech: a new line every 10s, on screen for 7s, typed out
 * a character at a time.
 *
 * Health and genre are read through refs on purpose. Both change while the
 * fight is running — HP on the 10s poll, and this component re-renders every
 * second for the countdown — so putting either in the dependency array would
 * restart the cycle mid-sentence and the boss would stutter the same opening
 * words forever.
 */
function useBossChatter(hpFraction: number, genre: string, active: boolean) {
  const [line, setLine] = useState<string | null>(null);
  const [typed, setTyped] = useState(0);

  const hpRef = useRef(hpFraction);
  hpRef.current = hpFraction;
  const genreRef = useRef(genre);
  genreRef.current = genre;
  const lastRef = useRef<string | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active) {
      setLine(null);
      return;
    }

    const speak = () => {
      if (hideRef.current) clearTimeout(hideRef.current);

      const hp = hpRef.current;
      const eligible = BOSS_LINES.filter(
        (l) =>
          (l.above === undefined || hp >= l.above) &&
          (l.below === undefined || hp <= l.below),
      );
      if (eligible.length === 0) return;

      // Don't repeat the previous line unless it is the only one that fits.
      const fresh = eligible.filter((l) => l.text !== lastRef.current);
      const pool = fresh.length > 0 ? fresh : eligible;
      const chosen = pool[Math.floor(Math.random() * pool.length)];

      lastRef.current = chosen.text;
      setLine(chosen.text.replace("{genre}", genreRef.current));
      hideRef.current = setTimeout(() => setLine(null), LINE_VISIBLE_MS);
    };

    speak();
    const cycle = setInterval(speak, LINE_EVERY_MS);
    return () => {
      clearInterval(cycle);
      if (hideRef.current) clearTimeout(hideRef.current);
    };
  }, [active]);

  // Typewriter reveal, restarted whenever a new line arrives.
  useEffect(() => {
    if (!line) return;
    setTyped(0);
    const id = setInterval(() => {
      setTyped((n) => {
        if (n >= line.length) {
          clearInterval(id);
          return n;
        }
        return n + 1;
      });
    }, TYPE_SPEED_MS);
    return () => clearInterval(id);
  }, [line]);

  return { line, typed };
}

export function BossFightPanel({
  event,
  paused,
  onInspectReward,
}: {
  event: GameEvent;
  /** Tab hidden or window unfocused — stop the 3D frame timer and the clock. */
  paused: boolean;
  onInspectReward: (itemId: string) => void;
  equipped?: Equipped | null;
}) {
  const config = event.config as unknown as BossFightView;
  const now = useNow(!paused);

  const startsAt = new Date(event.startsAt).getTime();
  const endsAt = new Date(event.endsAt).getTime();
  const remaining = endsAt - now;
  const timeFrac = Math.max(0, remaining) / Math.max(1, endsAt - startsAt);
  const hpFrac = config.maxHp > 0 ? config.hp / config.maxHp : 0;

  const rewardItem = config.rewardItemId
    ? getItem(config.rewardItemId)
    : undefined;

  // The boss is not a herzie row and nothing about it is persisted — its
  // appearance is derived here from the event id, so every boss looks
  // consistent for everyone fighting it but different from the last one.
  const bossParams = useMemo(() => {
    const base = generateCreatureParams(`boss:${event.id}`);
    return { ...base, bodyType: BOSS_BODY_TYPE };
  }, [event.id]);

  const hated = hatedPhrase(config.hatedGenres ?? []);
  const dead = config.killed || config.hp <= 0;
  const escaped = config.escaped || (remaining <= 0 && !dead);
  const { line, typed } = useBossChatter(
    hpFrac,
    hated,
    !paused && !dead && !escaped,
  );

  return (
    // flex-1 so this fills the View's body; without a definite height the
    // render block's flex-1 has no slack to claim and collapses to min-h.
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      {/* The boss's name is the heading now — "BOSS FIGHT" used to sit above
          it, but the view header says that, so it was the same words twice.
          Dropping it also lifts the name toward the top of the panel. */}
      <div className="text-center text-ui-lg font-bold text-red">
        {event.title}
      </div>

      {/* Only rendered once the reward is actually known. The server withholds
          rewardItemId until the boss is dead, and a "Completion reward: ???"
          placeholder just spent a line saying nothing — the mystery is
          explained in the help popover instead. */}
      {rewardItem ? (
        <div className="flex items-center justify-center gap-1 text-[10px] text-text-dim">
          Completion reward:
          <ItemTypeIcon item={rewardItem} className="h-4 w-4 shrink-0" />
          <button
            className="cursor-pointer border-none bg-transparent text-ui underline"
            style={{ color: ITEM_RARITY_COLORS[rewardItem.rarity] }}
            type="button"
            onClick={() => onInspectReward(rewardItem.id)}
          >
            {rewardItem.name}
          </button>
        </div>
      ) : null}

      {/* Takes all the vertical slack the rest of the panel doesn't need,
          rather than a fixed box. The renderer's grid is a fixed 48 rows and
          the boss only occupies rows 7..38 of it, so the canvas is always
          taller than the creature — overflow-hidden crops that dead margin
          instead of letting it push the bars off screen. */}
      <div className="relative flex min-h-[200px] flex-1 flex-col">
        {/* The canvas gets its own overflow-hidden so the speech bubble, which
            is a sibling rather than a child, can't be clipped by it. */}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <SharedHerzie3D
            userId={`boss:${event.id}`}
            stage={3}
            // Sized for the face-on pose specifically. Head-on the boss is
            // 23 of the grid's 48 rows (the horns sweep back, so at angle 0
            // they are furthest from the camera and shrink) with ~105px of
            // empty canvas above it at this scale. 23 rows x 1.35 x 6.5 =
            // ~202px of boss, against ~112px before. The crop the container
            // takes off each side stays under that 105px margin, so the
            // crown survives even at min-height.
            size={6.5}
            cols={64}
            creatureParams={bossParams}
            // No continuous Y-rotation. `animate` spins the creature; the boss
            // keeps only the idle breathing loop, which reads as looming rather
            // than as a turntable model.
            animate={false}
            // Square-on to the viewer. The renderer adds DEFAULT_Y_ANGLE (17°)
            // to whatever it is given, so cancelling it lands at exactly 0 —
            // every other herzie sits at that three-quarter angle, and the
            // boss staring straight out is most of why it reads as a threat.
            defaultAngle={-DEFAULT_Y_ANGLE}
            draggable={false}
            paused={paused}
            ariaLabel="The boss"
          />
        </div>

        {/* Deliberately NOT drawn into the ASCII canvas: glyph art can't be
            read at this size, and the hated genres are the one thing a player
            has to actually read to know what to play. */}
        {line ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center">
            {/* Tail above the bubble, pointing up at the boss. The bubble sits
                at the bottom because up top it covered the face and horns —
                and the boss's legs fade into near-black down here, so this is
                the cheapest part of the silhouette to overlap. */}
            <div className="h-0 w-0 border-r-[5px] border-b-[5px] border-l-[5px] border-r-transparent border-b-white border-l-transparent" />
            <div className="relative max-w-full rounded bg-white px-1.5 py-1 text-left text-ui text-black">
              {/* The full line, invisible, reserves the bubble's final size so
                  the box doesn't grow or reflow as characters arrive — the
                  typed text is overlaid on top of it. Without this the bubble
                  jitters wider and taller on nearly every keystroke. */}
              <span className="invisible" aria-hidden="true">
                {line}
              </span>
              <span className="absolute inset-0 px-1.5 py-1">
                {line.slice(0, typed)}
                {typed < line.length ? (
                  <span className="opacity-60">▍</span>
                ) : null}
              </span>
            </div>
          </div>
        ) : null}

        {dead || escaped ? (
          <div
            className={cn(
              "absolute inset-0 z-10 grid place-items-center text-ui-lg font-bold",
              dead ? "text-green" : "text-red",
            )}
          >
            {dead ? "DEFEATED" : "ESCAPED"}
          </div>
        ) : null}
      </div>

      <div>
        <div className="mb-0.5 flex items-baseline justify-between text-ui text-text-dim">
          <span>Health</span>
          <span className="text-ui-sm">
            {Math.round(config.hp).toLocaleString()} /{" "}
            {Math.round(config.maxHp).toLocaleString()}
          </span>
        </div>
        <SegmentBar progress={hpFrac} colour="bg-red" />
      </div>

      <div>
        <div className="mb-0.5 flex items-baseline justify-between text-ui text-text-dim">
          <span>Time left</span>
          <span className="text-ui-sm">{formatRemaining(remaining)}</span>
        </div>
        <SegmentBar progress={timeFrac} colour="bg-cyan" />
      </div>

      {/* shrink-0, not flex-1: the leaderboard is a fixed four rows at most,
          so any spare height belongs to the boss render above. */}
      <div className="min-h-0 shrink-0">
        <div className="mb-0.5 text-ui text-text-dim">Top damage dealers:</div>
        {(config.topDealers ?? []).length === 0 ? (
          <div className="text-[10px] text-text-dim">
            Nobody has hurt it yet.
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {config.topDealers.map((d) => (
              <div
                key={`${d.rank}-${d.name}`}
                className="flex items-baseline justify-between text-ui"
              >
                <span className={cn(d.rank === 1 && "text-gold")}>
                  {d.rank}. {d.name}
                </span>
                <span className="text-text-dim">
                  {d.damage.toLocaleString()}
                </span>
              </div>
            ))}
            {/* The player is usually not in the top N, and "you" is the line
                that makes the board feel like it is about them. */}
            {config.yourDamage > 0 &&
            !config.topDealers.some((d) => d.rank === config.yourRank) ? (
              <div className="mt-0.5 flex items-baseline justify-between border-t border-[#333] pt-0.5 text-ui text-cyan">
                <span>{config.yourRank ? `${config.yourRank}. ` : ""}you</span>
                <span>{config.yourDamage.toLocaleString()}</span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {config.yourDamage === 0 && !dead && !escaped ? (
        <div className="text-center text-[10px] text-text-dim">
          Play something it hates to hurt it.
        </div>
      ) : null}
    </div>
  );
}

/**
 * A fixture boss for the Settings > Debug > "Test Boss Fight" toggle.
 *
 * The boss only spawns Thursday-Sunday on a pg_cron schedule, so without this
 * the only way to look at this panel is to stand up a local Supabase stack,
 * serve the edge functions and seed a boss — which is a lot of machinery to
 * review a layout. This renders the panel against fake data while you stay
 * logged into your normal account, and is dev-only (the button lives behind
 * `import.meta.env.DEV`).
 *
 * It is NOT wired to anything: no damage lands, and the HP never moves. The
 * timer is real, so the countdown and its bar animate.
 */
export function makeDebugBoss(): GameEvent {
  const now = Date.now();
  const config: BossFightView = {
    hatedGenres: ["electronic"],
    // Left undefined on purpose: the server withholds the reward until the
    // boss is dead, so this is what a live boss actually looks like. Flip
    // `killed` to true and set these to see the revealed state.
    rewardItemId: undefined,
    topRewardItemId: undefined,
    topCount: 3,
    hp: 42_180,
    maxHp: 100_000,
    killed: false,
    escaped: false,
    topDealers: [
      { name: "herzie1", damage: 412, rank: 1 },
      { name: "herzie2", damage: 288, rank: 2 },
      { name: "herzie3", damage: 190, rank: 3 },
    ],
    yourDamage: 64,
    yourRank: 7,
  };

  return {
    id: "debug-boss-fight",
    type: "boss_fight",
    title: "Nohoot Henry",
    description: "Listen to what it hates.",
    active: true,
    // Mid-window, so both bars sit somewhere interesting rather than full.
    startsAt: new Date(now - 36 * 3_600_000).toISOString(),
    endsAt: new Date(now + 60 * 3_600_000).toISOString(),
    config: config as unknown as Record<string, unknown>,
  };
}

/**
 * The "?" that sits in the Events header while a boss is live.
 *
 * Built on `HoverPreview`, not `Tooltip`: Tooltip is `whitespace-nowrap` and
 * chases the cursor, which is right for a short label and wrong for a
 * paragraph — a multi-line string would run off the 380px window. HoverPreview
 * already solves the anchored, sized, portalled case, so this needs no new
 * popover machinery and leaves Tooltip untouched.
 */
export function BossFightHelp() {
  return (
    <HoverPreview
      // Anchored under the icon: it lives in the header, so there is never
      // room above it.
      alwaysAbove={false}
      // estWidth/estHeight only steer placement, but they have to track the
      // real footprint or the popover is centred and fit-checked against the
      // wrong box — hence the matching w-[220px].
      estWidth={220}
      estHeight={64}
      content={
        <div className="w-[220px] rounded border border-border bg-bg-panel p-2 text-left text-ui text-text-dim">
          Defeat the boss and receive rewards. You&apos;ll have to work together
          to make it in time!
        </div>
      }
    >
      <button
        type="button"
        className="cursor-help border-none bg-transparent text-ui text-text-dim hover:text-cyan"
        aria-label="What is a boss fight?"
      >
        ?
      </button>
    </HoverPreview>
  );
}
