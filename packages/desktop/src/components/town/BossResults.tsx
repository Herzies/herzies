import type { BossPlace } from "@herzies/shared";
import { HerzieStage, HerzieView } from "@herzies/shared/gl";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { leaveCombat } from "./combat/Combat";
import { clearBossResults, useBossResults } from "./combat/results";
import { letGoOfTownInput } from "./input";

/**
 * The end of a boss fight, for whoever was in the cave: victory or defeat;
 * the three who did the most, drawn with their instruments in hand — first
 * in the middle and a little bigger, second to its left, third to its
 * right; then the same three as a list with what each dealt and healed,
 * and your own place under a "…" if you're not among them. Ranked by
 * contribution (damage, plus healing and blocking; see contributionOf).
 *
 * It shows just after the boss falls, before anyone goes for the loot,
 * and goes with Continue or Esc. It fills the Town, chat and HUD included,
 * from the top margin down to the tab bar (`--nav-height`), the world
 * blurred out behind it, and is only drawn while the Town is the view;
 * nothing in the Town moves while it's up. It stays
 * up back in town until you go on. Above all that, the page's shared
 * herzie stage would be under its background, so its herzies have a stage
 * of their own, inside it.
 */
export function BossResults({ name }: { name: string }) {
  const results = useBossResults();
  // Its herzies' own stage, its canvas inside the overlay.
  const [stage] = useState(() => new HerzieStage());
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => () => stage.dispose(), [stage]);
  // On a kill it waits for the boss to crumble away.
  const [now, setNow] = useState(() => performance.now());
  const wait = results ? results.showAt - now : 0;
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setNow(performance.now()), wait);
    return () => clearTimeout(t);
  }, [wait]);
  const shown = !!results && wait <= 0;
  useEffect(() => {
    if (shown) stage.setHost(overlay.current);
  }, [shown, stage]);
  // While it's up the Town is still: whatever's held is let go, aiming
  // ends (the mouse is let go too), and keys reach it first and stop here —
  // no walking, casting or skills. Esc goes on, like Continue.
  useEffect(() => {
    if (!shown) return;
    letGoOfTownInput();
    leaveCombat();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        clearBossResults();
      } else if (e.key !== "Enter" && e.key !== " ") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown]);
  if (!results || !shown) return null;

  const { outcome, top, you } = results;
  const won = outcome === "victory";
  const mine = (p: BossPlace) => you !== null && p.rank === you.rank;
  const podium = [top[1], top[0], top[2]].filter(
    (p): p is BossPlace => p !== undefined,
  );
  const outside = you !== null && !top.some(mine);

  return (
    <div
      ref={overlay}
      className="absolute inset-x-3 top-3 z-50 flex"
      style={{ bottom: "calc(var(--nav-height, 0px) + 0.75rem)" }}
    >
      {/* The window fills it, the Town blurred out behind; its content
          sits in the middle. */}
      <section
        aria-labelledby="boss-results-title"
        className="relative flex min-h-0 w-full flex-col items-center justify-center overflow-y-auto rounded border border-white/15 bg-black/45 px-4 py-3 text-ui text-text shadow-lg backdrop-blur-md"
      >
        <div className="w-full max-w-[26rem]">
          <h2
            id="boss-results-title"
            className={cn(
              "text-center text-xl font-bold tracking-[0.2em]",
              won ? "text-yellow" : "text-red",
            )}
          >
            {won ? "VICTORY" : "DEFEAT"}
          </h2>
          <p className="mb-1 text-center text-[10px] text-text-dim">
            {won ? `${name} has fallen.` : `${name} got away.`}
          </p>

          {top.length ? (
            <>
              <div className="mb-2 flex items-end justify-center gap-1">
                {podium.map((p) => (
                  <Podium key={p.rank} place={p} you={mine(p)} stage={stage} />
                ))}
              </div>

              <table className="w-full border-separate border-spacing-y-0.5">
                <thead>
                  <tr className="text-[10px] text-text-dim">
                    <th className="text-left font-normal" colSpan={2}>
                      <span className="sr-only">Herzie</span>
                    </th>
                    <th className="w-14 text-right font-normal">Dmg</th>
                    <th
                      className="w-12 text-right font-normal"
                      title="Healed + blocked"
                    >
                      Heal
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((p) => (
                    <Row key={p.rank} place={p} you={mine(p)} />
                  ))}
                  {outside && you ? (
                    <>
                      <tr aria-hidden>
                        <td colSpan={4} className="text-center text-text-dim">
                          …
                        </td>
                      </tr>
                      <Row place={you} you />
                    </>
                  ) : null}
                </tbody>
              </table>
            </>
          ) : (
            <p className="my-2 text-center text-[10px] text-text-dim">
              Nobody landed a hit.
            </p>
          )}

          <div className="mt-2.5 flex justify-center">
            <button type="button" className="btn" onClick={clearBossResults}>
              Continue
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** One of the top three, drawn: its gear in hand, its place under it. */
function Podium({
  place,
  you,
  stage,
}: {
  place: BossPlace;
  you: boolean;
  stage: HerzieStage;
}) {
  const first = place.rank === 1;
  const look = place.look;
  return (
    <div className="flex w-28 min-w-0 flex-col items-center">
      <div
        className={cn(
          "flex items-end justify-center overflow-hidden",
          first ? "h-36 w-28" : "h-28 w-24",
        )}
      >
        {look ? (
          <HerzieView
            userId={look.seed}
            stage={look.stage}
            equipped={look.equipped}
            size={first ? 3.4 : 2.7}
            cols={44}
            // Turned to face us (0 is the usual three-quarter view).
            defaultAngle={-0.4}
            groundInset={2}
            armed
            onStage={stage}
            animate={false}
            draggable={false}
            ariaLabel={`${place.name}, ${ordinal(place.rank)}`}
          />
        ) : null}
      </div>
      <span
        className={cn(
          "font-bold tabular-nums",
          first ? "text-lg text-yellow" : "text-base text-text-dim",
        )}
      >
        {place.rank}
      </span>
      <span
        className={cn(
          "max-w-full truncate text-[10px]",
          you ? "text-cyan" : "text-text",
        )}
      >
        {place.name}
      </span>
    </div>
  );
}

function Row({ place, you }: { place: BossPlace; you: boolean }) {
  return (
    <tr className={cn(you && "text-cyan")}>
      <td className="w-8 text-text-dim tabular-nums">{ordinal(place.rank)}</td>
      <td className="max-w-0 truncate">{place.name}</td>
      <td className="text-right tabular-nums">
        {place.damage.toLocaleString()}
      </td>
      <td className="text-right text-green tabular-nums">
        {place.heal ? place.heal.toLocaleString() : "–"}
      </td>
    </tr>
  );
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
