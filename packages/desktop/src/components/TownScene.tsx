import {
  BOSS_BODY_TYPE,
  type CreatureParams,
  DEFAULT_Y_ANGLE,
  type Equipped,
  GEORGE_EQUIPPED,
  GEORGE_SEED,
  generateCreatureParams,
  Herzie3D,
  NANDOR_EQUIPPED,
  NANDOR_SEED,
  ORPHIEZ_EQUIPPED,
  useChatter,
  VISITORS,
} from "@herzies/shared";
import { useMemo } from "react";
import { cn } from "../lib/utils";
import { BOSS_LINES } from "./BossFightPanel";
import { GEORGE_LINES, NANDOR_LINES } from "./MerchantPanel";
import { ORPHIEZ_LINES } from "./OrphiezStage";
import { ROW_TEXT_SHADOW, VISITOR_THEMES } from "./VisitorRowTheme";

export type EventCard = {
  type: string;
  title: string;
  description: string | null;
  status: "live" | "scheduled" | "idle";
  /** Ends-at when live, starts-at when scheduled. */
  at: string | null;
  detail?: string;
  /** What opening the card selects (an event id, or "song_hunt" for the hunt
   * view); null when there is nothing to open yet. */
  openKey: string | null;
  /** For a stable React key. */
  eventId?: string;
};

export function formatIn(at: string): string {
  const ms = new Date(at).getTime() - Date.now();
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

/** Glyph size of the visitors on the map. */
const NPC_SIZE = 2.8;
const NPC_COLS = 44;
/** How much of a visitor's canvas shows above their feet: the tallest of
 * them (the boss, horns and all) fits. */
const NPC_BOX_H = 80;
/** Width of a spot, name tag included. */
const SPOT_W = 104;
/** Where the speech bubble's tail ends, above a visitor's feet. */
const HEAD_H = 64;

/** Each visitor's spot on the map, as % of its width and height (where their
 * feet go): the boss up north, George's stall to the west, Orphiez to the
 * east, Nandor down south. Anyone else takes the next free spare spot. */
const SPOTS: Record<string, { x: number; y: number }> = {
  boss_fight: { x: 50, y: 30 },
  merchant: { x: 24, y: 56 },
  song_hunt: { x: 76, y: 56 },
  treat_trader: { x: 34, y: 86 },
};
const SPARE_SPOTS = [
  { x: 68, y: 86 },
  { x: 50, y: 66 },
];

export type Look = {
  seed: string;
  stage: number;
  equipped?: Equipped;
  params?: CreatureParams;
};

/** The visitor's own look, the same one their screen shows. */
export function lookOf(card: EventCard): Look {
  switch (card.type) {
    case "song_hunt":
      return {
        seed: VISITORS.song_hunt.seed ?? "npc:orphiez",
        stage: 2,
        equipped: ORPHIEZ_EQUIPPED,
      };
    case "merchant":
      return { seed: GEORGE_SEED, stage: 2, equipped: GEORGE_EQUIPPED };
    case "treat_trader":
      return { seed: NANDOR_SEED, stage: 2, equipped: NANDOR_EQUIPPED };
    case "boss_fight": {
      const seed = `boss:${card.eventId ?? ""}`;
      return {
        seed,
        stage: 3,
        params: { ...generateCreatureParams(seed), bodyType: BOSS_BODY_TYPE },
      };
    }
    default:
      return { seed: `npc:${card.type}`, stage: 2 };
  }
}

/** What each visitor mutters while they're in town: their own screen's
 * lines. The boss only gets the ones that hold at any HP and don't name a
 * genre — the Town doesn't know either. */
export const TOWN_LINES: Record<string, readonly string[]> = {
  merchant: GEORGE_LINES,
  song_hunt: ORPHIEZ_LINES,
  treat_trader: NANDOR_LINES,
  boss_fight: BOSS_LINES.filter(
    (l) =>
      l.above === undefined &&
      l.below === undefined &&
      !l.text.includes("{genre}"),
  ).map((l) => l.text),
};

/** useChatter cycles plain strings, so each line carries its speaker's spot
 * key after this separator — at the end, so the typewriter reaches the words
 * straight away and only types the (hidden) key once they're all out. */
const SPEAKER_SEP = "\u0001";

const spotKey = (card: EventCard) =>
  `${card.type}-${card.eventId ?? card.status}`;

/** The boss is in town but no longer standing. */
export const isDown = (card: EventCard) =>
  card.type === "boss_fight" && card.detail === "Defeated!";

function Spot({
  card,
  at,
  paused,
  onOpen,
}: {
  card: EventCard;
  at: { x: number; y: number };
  paused: boolean;
  onOpen?: () => void;
}) {
  const live = card.status === "live";
  const theme = live ? VISITOR_THEMES[card.type] : undefined;
  // Keyed on who, not on the card: the view rebuilds its cards on every
  // render, and a fresh boss look would restart its idle loop each time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const look = useMemo(() => lookOf(card), [card.type, card.eventId]);
  const standing = live && !isDown(card);

  const status = live
    ? card.type === "boss_fight" && card.detail
      ? card.detail
      : card.at
        ? `${formatIn(card.at)} left`
        : "in town"
    : card.at
      ? `in ${formatIn(card.at)}`
      : "away";

  const Root = onOpen ? "button" : "div";
  return (
    <Root
      {...(onOpen ? { type: "button" as const, onClick: onOpen } : {})}
      aria-label={`${card.title}: ${status}`}
      className={cn(
        "group absolute flex flex-col items-center border-none bg-transparent p-0",
        onOpen &&
          "cursor-pointer focus-visible:outline-1 focus-visible:outline-cyan",
      )}
      // The spot's point is the visitor's feet.
      style={{
        left: `${at.x}%`,
        top: `${at.y}%`,
        width: SPOT_W,
        transform: `translate(-50%, -${NPC_BOX_H}px)`,
      }}
    >
      <div
        className={cn(
          "relative flex w-full items-end justify-center",
          onOpen &&
            "transition-[filter] duration-100 group-hover:brightness-150",
        )}
        style={{ height: NPC_BOX_H }}
      >
        {/* The visitor's patch of ground: in their colour while they're
            here, an empty dashed ring while they're away. */}
        <div
          className={cn(
            "absolute bottom-0 h-[18px] w-[72px] translate-y-1/2 rounded-[50%]",
            !theme && "border border-dashed border-white/25",
          )}
          style={
            theme
              ? {
                  background: `${theme.accent}30`,
                  border: `1px solid ${theme.accent}90`,
                }
              : undefined
          }
        />
        {standing ? (
          <div className="relative flex h-full items-end justify-center overflow-hidden">
            <Herzie3D
              userId={look.seed}
              stage={look.stage}
              size={NPC_SIZE}
              cols={NPC_COLS}
              equipped={look.equipped}
              creatureParams={look.params}
              animate={false}
              defaultAngle={-DEFAULT_Y_ANGLE}
              draggable={false}
              paused={paused}
              groundInset={0}
              ariaLabel={card.title}
            />
          </div>
        ) : null}
      </div>
      <div
        className="mt-3 flex max-w-full flex-col items-center rounded bg-black/55 px-1.5 py-0.5 text-center"
        style={{ textShadow: ROW_TEXT_SHADOW }}
      >
        <div
          className={cn(
            "max-w-full truncate text-[10px] leading-tight",
            live ? "text-white" : "text-text-dim",
            onOpen && !live && "group-hover:text-cyan",
          )}
        >
          {card.title}
        </div>
        <div
          className="max-w-full truncate text-[9px] leading-tight text-text-dim"
          style={theme ? { color: theme.accent } : undefined}
        >
          {status}
        </div>
      </div>
    </Root>
  );
}

/**
 * The Town as a map, seen from above: every visitor has their own spot on
 * it. Whoever's in town stands on theirs and talks; an empty spot says when
 * its visitor is due. Opening a spot opens that visitor's screen.
 */
export function TownScene({
  cards,
  paused,
  onOpen,
}: {
  cards: EventCard[];
  paused: boolean;
  onOpen: (openKey: string) => void;
}) {
  const spots = useMemo(() => {
    let spare = 0;
    return (
      cards
        // Nandor only has a spot while he's around.
        .filter((c) => c.type !== "treat_trader" || c.status !== "idle")
        .map((card) => ({
          card,
          at: SPOTS[card.type] ?? SPARE_SPOTS[spare++ % SPARE_SPOTS.length],
        }))
    );
  }, [cards]);

  // One conversation for the whole town: each line is someone in town, and
  // the bubble floats over whoever's talking.
  const lines = useMemo(
    () =>
      spots.flatMap(({ card }) =>
        card.status === "live" && !isDown(card)
          ? (TOWN_LINES[card.type] ?? []).map(
              (l) => `${l}${SPEAKER_SEP}${spotKey(card)}`,
            )
          : [],
      ),
    [spots],
  );
  const { line, typed, advance } = useChatter(
    lines,
    !paused && lines.length > 0,
  );
  const [text, speaker] = line ? line.split(SPEAKER_SEP) : [null, null];
  // A speaker who left mid-line takes the bubble with them.
  const speakerAt = spots.find(({ card }) => spotKey(card) === speaker)?.at;

  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden border border-border"
      style={{
        background:
          "radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px) 0 0 / 14px 14px, radial-gradient(ellipse at 50% 45%, #1d3324 0%, #142519 60%, #0d1810 100%)",
      }}
    >
      {spots.map(({ card, at }) => (
        <Spot
          key={spotKey(card)}
          card={card}
          at={at}
          paused={paused}
          onOpen={
            card.openKey ? () => onOpen(card.openKey as string) : undefined
          }
        />
      ))}

      {/* Over the speaker's head. Translating by their x% of its own width
          keeps the bubble inside the map at either edge; the tail stays
          over them. Clicking it hurries them along. */}
      {speakerAt && text ? (
        <>
          <button
            type="button"
            onClick={advance}
            aria-label="Next line"
            className="absolute z-10 flex w-max max-w-[70%] cursor-pointer border-none bg-transparent p-0"
            style={{
              left: `${speakerAt.x}%`,
              top: `calc(${speakerAt.y}% - ${HEAD_H + 5}px)`,
              transform: `translate(-${speakerAt.x}%, -100%)`,
            }}
          >
            <div className="relative rounded bg-white px-1.5 py-1 text-left text-ui text-black">
              <span className="invisible" aria-hidden="true">
                {text}
              </span>
              <span className="absolute inset-0 px-1.5 py-1">
                {text.slice(0, typed)}
              </span>
            </div>
          </button>
          <div
            className="absolute z-10 h-0 w-0 -translate-x-1/2 border-t-[5px] border-r-[5px] border-l-[5px] border-t-white border-r-transparent border-l-transparent"
            style={{
              left: `${speakerAt.x}%`,
              top: `calc(${speakerAt.y}% - ${HEAD_H + 5}px)`,
            }}
          />
        </>
      ) : null}
    </div>
  );
}
