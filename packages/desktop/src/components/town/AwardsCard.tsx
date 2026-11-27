import type {
  AwardBoard,
  AwardMine,
  AwardPlace,
  ClassRole,
} from "@herzies/shared";
import { AWARD_NAMES, AWARD_ROLES } from "@herzies/shared/combat";
import { type HerzieStage, HerzieView } from "@herzies/shared/gl";
import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn, ordinal } from "../../lib/utils";
import type { BossResults } from "./combat/results";
import { sfxAward } from "./sfx";

/**
 * The end of a raid as an awards show: an award per role — Big Hitter
 * (most damage), Soundproof (kept the boss on them and blocked its hits),
 * Lifesaver (kept everyone playing) — handed out one at a time, each
 * winner stepping onto a plinth of the Town statue's stone to a sting and
 * a little dance, with its numbers in the game's own terms. Then the
 * statue line, and a line of your own: what you did, whether you won
 * anything or not. Each award's best three stay behind Details. A click
 * skips the show (a key too, in BossResults). Laid out for the width it
 * gets: the small window, the big one, or full screen (see tierOf).
 *
 * BossResults draws it over the Town; /raid-results-preview.html draws it
 * at every screen size, for a look without a fight.
 */

/** What each award is for, on hover. */
const FOR: Record<ClassRole, string> = {
  dps: "Most damage",
  tank: "Kept the boss on them and blocked its hits",
  support: "Kept everyone playing",
};

/** The order they're handed out: the sides first, the middle last. */
const ORDER: readonly ClassRole[] = ["dps", "support", "tank"];
/** Before the first award, and between each. */
const FIRST_MS = 700;
const EACH_MS = 1_000;
/** How long a winner dances as it steps up. */
const DANCE_MS = 1_600;

/** The width the card gets: the small window's, the big window's, or full
 * screen's. */
type Tier = "compact" | "regular" | "large";

function tierOf(width: number): Tier {
  return width >= 1200 ? "large" : width >= 640 ? "regular" : "compact";
}

/** The card's tier, measured again whenever its width changes. */
function useTier(ref: RefObject<HTMLElement | null>): Tier {
  const [tier, setTier] = useState<Tier>("compact");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTier(tierOf(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return tier;
}

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Whether a place in `role`'s ranking is yours: your own result is in
 * one role only, so elsewhere you're never picked out. */
function yours(mine: AwardMine | null, role: ClassRole, p: AwardPlace) {
  return mine !== null && mine.role === role && mine.place.rank === p.rank;
}

/** The end screen of a boss fight: its outcome, its three awards, and your
 * own result. */
export function AwardsCard({
  results: { outcome, awards, mine },
  stage,
  skip: skips = 0,
  onContinue,
}: {
  results: Omit<BossResults, "showAt">;
  /** Where the winners' herzies draw; null leaves them out. */
  stage: HerzieStage | null;
  /** Bumped to skip to the end of the show (a key, in BossResults). */
  skip?: number;
  onContinue: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const tier = useTier(ref);
  const titleId = useId();
  const won = outcome === "victory";
  const large = tier === "large";
  const winners = awards.filter((b) => b.winner).length;

  // How many awards are out, in ORDER. A skip shows the rest at once,
  // without their stings.
  const [out, setOut] = useState(() => (reducedMotion() ? ORDER.length : 0));
  const skipped = useRef(false);
  useEffect(() => {
    if (out >= ORDER.length) return;
    const t = setTimeout(
      () => {
        const role = ORDER[out];
        if (!skipped.current && awards.find((b) => b.role === role)?.winner)
          sfxAward(out);
        setOut(out + 1);
      },
      out === 0 ? FIRST_MS : EACH_MS,
    );
    return () => clearTimeout(t);
  }, [out, awards]);
  const done = out >= ORDER.length;
  const skip = () => {
    skipped.current = true;
    setOut(ORDER.length);
  };
  // Only a bump since it came up: the count runs on across fights.
  const skipsAtStart = useRef(skips);
  useEffect(() => {
    if (skips === skipsAtStart.current) return;
    skipped.current = true;
    setOut(ORDER.length);
  }, [skips]);
  const [details, setDetails] = useState(false);

  return (
    // A click anywhere skips to the end of the show (keys too, in
    // BossResults, which has them first).
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys skip it in BossResults
    <section
      ref={ref}
      aria-labelledby={titleId}
      onClick={done ? undefined : skip}
      className="relative flex min-h-0 w-full flex-col items-center overflow-x-hidden overflow-y-auto rounded border border-white/15 bg-black/45 px-4 py-3 text-text shadow-lg backdrop-blur-md"
    >
      <style>{`@keyframes award-up{0%{opacity:0;transform:translateY(10px)}100%{opacity:1;transform:none}}@media (prefers-reduced-motion: reduce){@keyframes award-up{0%{opacity:0}100%{opacity:1}}}`}</style>
      <div
        className={cn(
          "my-auto w-full",
          tier === "compact" && "max-w-[26rem] text-ui",
          tier === "regular" && "max-w-[30rem] text-ui",
          tier === "large" && "max-w-[40rem] text-ui-lg",
        )}
      >
        <h2
          id={titleId}
          className={cn(
            "text-center font-bold tracking-[0.2em]",
            large ? "text-3xl" : "text-xl",
            won ? "text-yellow" : "text-red",
          )}
        >
          {won ? "VICTORY" : "DEFEAT"}
        </h2>
        <p
          className={cn(
            "mb-1 text-center text-text-dim",
            large ? "text-ui" : "text-[10px]",
          )}
        >
          {won ? "The boss has fallen." : "The boss got away."}
        </p>

        {winners ? (
          <div className="flex justify-center gap-1">
            {AWARD_ROLES.map((role) => {
              const board = awards.find((b) => b.role === role);
              return board ? (
                <AwardStand
                  key={role}
                  board={board}
                  you={!!board.winner && yours(mine, role, board.winner)}
                  out={ORDER.indexOf(role) < out}
                  stage={stage}
                  tier={tier}
                  statue={won}
                />
              ) : null;
            })}
          </div>
        ) : (
          <p className="my-2 text-center text-[10px] text-text-dim">
            Nobody landed a hit.
          </p>
        )}

        <div
          className={cn(
            "mt-3 flex flex-col items-center gap-0.5 text-center transition-opacity duration-500",
            done ? "opacity-100" : "opacity-0",
          )}
        >
          {winners ? (
            <p className="text-text-dim">
              {won
                ? `${["", "This one goes", "These two go", "These three go"][winners]} up on the statue in town.`
                : "No statue this time."}
            </p>
          ) : null}
          {mine ? <YourLine mine={mine} statue={won} /> : null}
        </div>

        <div className="mt-3 flex justify-center gap-2">
          <button
            type="button"
            className="btn text-text-dim"
            aria-expanded={details}
            onClick={(e) => {
              e.stopPropagation();
              skip();
              setDetails((d) => !d);
            }}
          >
            {details ? "Hide details" : "Details"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={(e) => {
              e.stopPropagation();
              onContinue();
            }}
          >
            Continue
          </button>
        </div>

        {details ? (
          <div className="mt-3 grid grid-cols-3 gap-x-3 border-t border-white/15 pt-2">
            {AWARD_ROLES.map((role) => {
              const board = awards.find((b) => b.role === role);
              return board ? (
                <div key={role} className="min-w-0">
                  <div
                    className={cn(
                      "text-text-dim",
                      large ? "text-ui" : "text-[10px]",
                    )}
                    title={FOR[role]}
                  >
                    {AWARD_NAMES[role]}
                  </div>
                  <Ranking
                    board={board}
                    mine={mine}
                    statue={won}
                    large={large}
                  />
                </div>
              ) : null;
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One award: its plinth, the award cut into it; once it's handed out, the
 * winner steps up onto it (dancing a moment), its name under it — gold
 * when it goes up on the statue — and the numbers it won with. The
 * herzie's view is wider and taller than its place (the gear and a tall
 * herzie don't fit the place's box), so it reaches over its neighbours'
 * and the title's space, unclipped; the middle one's place overlaps the
 * other two (its negative margin), its herzie drawn over theirs.
 */
function AwardStand({
  board: { role, winner },
  you,
  out,
  stage,
  tier,
  statue,
}: {
  board: AwardBoard;
  /** The winner is the one looking. */
  you: boolean;
  /** Handed out yet. */
  out: boolean;
  stage: HerzieStage | null;
  tier: Tier;
  /** The fight was won: the winners go up on the statue. */
  statue: boolean;
}) {
  const middle = role === AWARD_ROLES[1];
  const large = tier === "large";
  const look = winner?.look;
  // A little dance as it steps up, then still.
  const [dancing, setDancing] = useState(false);
  useEffect(() => {
    if (!out || !winner || reducedMotion()) return;
    setDancing(true);
    const t = setTimeout(() => setDancing(false), DANCE_MS);
    return () => clearTimeout(t);
  }, [out, winner]);
  const arrive = "motion-safe:animate-[award-up_450ms_ease-out_both]";
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-center",
        large
          ? middle
            ? "-mx-6 w-48"
            : "w-48"
          : middle
            ? "-mx-2 w-32"
            : "w-32",
      )}
      title={FOR[role]}
    >
      <div className={cn("relative w-full", large ? "h-44" : "h-32")}>
        {out && look && stage && winner ? (
          <HerzieView
            userId={look.seed}
            stage={look.stage}
            equipped={look.equipped}
            size={large ? 4.35 : 3}
            // Its full width (the default cols), room for the gear either
            // side, stood on its plinth.
            wrapperClassName={cn(
              "pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2",
              arrive,
            )}
            layer={middle ? 1 : 0}
            // Turned to face us (0 is the usual three-quarter view).
            defaultAngle={-0.4}
            groundInset={1}
            armed
            isPlaying={dancing}
            onStage={stage}
            draggable={false}
            ariaLabel={`${winner.name}, the ${AWARD_NAMES[role]}`}
          />
        ) : null}
      </div>
      <div className={cn("w-full", large ? "px-6" : "px-2")}>
        <Plinth label={AWARD_NAMES[role]} large={large} />
        {out ? (
          <div className={cn("mt-1 flex flex-col items-center", arrive)}>
            <span
              className={cn(
                "max-w-full truncate",
                !winner
                  ? "text-text-dim"
                  : you
                    ? "text-cyan"
                    : statue
                      ? "text-[#ffd84a]"
                      : "text-text",
              )}
              title={winner ? detail(winner) : undefined}
            >
              {winner?.name ?? "–"}
            </span>
            {(winner ? headline(role, winner) : [nobody(role)]).map((line) => (
              <span
                key={line}
                className={cn(
                  "max-w-full truncate text-text-dim tabular-nums",
                  large ? "text-ui" : "text-[10px]",
                )}
              >
                {line}
              </span>
            ))}
          </div>
        ) : (
          <div
            aria-hidden
            className={cn(
              "mt-1 text-center text-text-dim",
              large ? "h-[2.6rem]" : "h-[2.15rem]",
            )}
          >
            …
          </div>
        )}
      </div>
    </div>
  );
}

/** A plinth like the Town statue's (Statues.tsx): its stone, a lighter cap
 * a little wider than the block, its award cut into its face. */
function Plinth({ label, large }: { label: string; large: boolean }) {
  return (
    <div aria-hidden className="flex flex-col items-center">
      <div className="h-1 w-full bg-[#a9a49b] shadow-[inset_0_-1px_0_rgba(0,0,0,0.15)]" />
      <div
        className={cn(
          "flex w-[86%] items-center justify-center bg-[#8f8a82] font-bold text-[#36322d] shadow-[inset_2px_0_0_rgba(255,255,255,0.08),inset_-2px_0_0_rgba(0,0,0,0.12),inset_0_-3px_0_rgba(0,0,0,0.2)] [text-shadow:0_1px_0_rgba(255,255,255,0.25)]",
          large ? "h-8 text-ui" : "h-5 text-[10px]",
        )}
      >
        {label}
      </div>
    </div>
  );
}

/** An award's best three, the way the events tab lists a boss's awards:
 * "1. name", its share of the role on the right; whoever goes up on the
 * statue in gold, you in cyan, your own place under a rule if it's lower. */
function Ranking({
  board: { role, winner, top },
  mine,
  statue,
  large,
}: {
  board: AwardBoard;
  mine: AwardMine | null;
  statue: boolean;
  large: boolean;
}) {
  if (!top.length)
    return (
      <p
        className={cn(
          "mt-1.5 text-text-dim",
          large ? "text-ui" : "text-[10px]",
        )}
      >
        {nobody(role)}
      </p>
    );
  const below =
    mine?.role === role && !top.some((p) => yours(mine, role, p))
      ? mine.place
      : null;
  const row = (p: AwardPlace, under = false) => {
    const you = yours(mine, role, p);
    return (
      <li
        key={p.rank}
        className={cn(
          "flex items-baseline gap-1",
          under && "mt-0.5 border-t border-white/15 pt-0.5",
          you
            ? "text-cyan"
            : statue && p.rank === winner?.rank
              ? "text-[#ffd84a]"
              : "text-text",
        )}
        title={detail(p)}
      >
        <span className="min-w-0 flex-1 truncate">
          {p.rank}. {p.name}
        </span>
        <span className={cn("tabular-nums", you ? undefined : "text-text-dim")}>
          {percent(p.share)}
        </span>
      </li>
    );
  };
  return (
    <ol
      className={cn(
        "mt-1.5 flex flex-col gap-0.5",
        large ? "text-ui" : "text-[10px]",
      )}
    >
      {top.map((p) => row(p))}
      {below ? row(below, true) : null}
    </ol>
  );
}

/** Your own line, under the awards: the one you won, or where you came in
 * your own role and what you did there. */
function YourLine({
  mine: { role, place, won },
  statue,
}: {
  mine: AwardMine;
  statue: boolean;
}) {
  return (
    <p className="text-cyan" title={detail(place)}>
      {won
        ? `You won ${AWARD_NAMES[role]}${statue ? "! Up you go." : "."}`
        : [
            `You came ${ordinal(place.rank)} for ${AWARD_NAMES[role]}`,
            ...headline(role, place),
          ].join(" · ")}
    </p>
  );
}

/** The numbers an award is won with, in the game's own terms, a line
 * each, short enough for under a plinth in the small window. A tank's:
 * how long it tanked the boss (its Taunt holding it), and what its
 * Cymbrella blocked, each only if there's any. */
function headline(role: ClassRole, p: AwardPlace): string[] {
  if (role === "dps") return [`${p.damage.toLocaleString()} damage`];
  if (role === "tank")
    return [
      ...(p.tanked > 0 ? [`Tanked ${clock(p.tanked)}`] : []),
      ...(p.blocked > 0 ? [`Blocked ${p.blocked.toLocaleString()}`] : []),
    ];
  return [`Healed ${p.healed.toLocaleString()}`];
}

/** Under a plinth nobody stepped onto, and an empty ranking. */
function nobody(role: ClassRole): string {
  // Short enough for under a plinth in the small window.
  return role === "tank"
    ? "Nobody tanked"
    : role === "support"
      ? "Nobody healed"
      : "Nobody hit it";
}

/** A place's tooltip: everything it did, in the game's own terms. */
function detail(p: AwardPlace): string {
  const parts = [`Damage ${p.damage.toLocaleString()}`];
  if (p.tanked > 0) parts.push(`tanked ${clock(p.tanked)}`);
  if (p.blocked > 0) parts.push(`blocked ${p.blocked.toLocaleString()}`);
  if (p.healed > 0) parts.push(`healed ${p.healed.toLocaleString()}`);
  return parts.join(" · ");
}

/** Seconds as m:ss. */
function clock(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A share, 0–1, as a whole percentage; a sliver as "<1%". */
function percent(x: number): string {
  if (x > 0 && x < 0.005) return "<1%";
  return `${Math.round(x * 100)}%`;
}
