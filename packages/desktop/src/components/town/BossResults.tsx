import type { BossPlace } from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { clearBossResults, useBossResults } from "./combat/results";

/**
 * The end of a boss fight, for whoever was in the cave: victory or defeat;
 * the three who did the most, drawn with their instruments in hand — first
 * in the middle and a little bigger, second to its left, third to its
 * right; then the same three as a list with what each dealt and healed,
 * and your own place under a "…" if you're not among them. Ranked by
 * contribution (damage, plus healing and blocking; see contributionOf).
 *
 * It sits below the "Back to town" banner and only Continue takes the
 * mouse, so the loot can still be picked up; it stays up back in town
 * until you go on. It has no z-index of its own: the herzies are drawn on
 * the shared stage (fixed, z-index 1), which has to paint over its
 * background.
 */
export function BossResults({ name }: { name: string }) {
  const results = useBossResults();
  // On a kill it waits for the boss to crumble away.
  const [now, setNow] = useState(() => performance.now());
  const wait = results ? results.showAt - now : 0;
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setNow(performance.now()), wait);
    return () => clearTimeout(t);
  }, [wait]);
  if (!results || wait > 0) return null;

  const { outcome, top, you } = results;
  const won = outcome === "victory";
  const mine = (p: BossPlace) => you !== null && p.rank === you.rank;
  const podium = [top[1], top[0], top[2]].filter(
    (p): p is BossPlace => p !== undefined,
  );
  const outside = you !== null && !top.some(mine);

  return (
    <section
      aria-labelledby="boss-results-title"
      className="pointer-events-none absolute top-24 left-1/2 w-[min(26rem,92%)] -translate-x-1/2 rounded border border-border bg-bg-panel/95 px-4 pt-3 pb-2.5 text-ui text-text shadow-lg"
    >
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
              <Podium key={p.rank} place={p} you={mine(p)} />
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
        <button
          type="button"
          className="btn pointer-events-auto"
          onClick={clearBossResults}
        >
          Continue
        </button>
      </div>
    </section>
  );
}

/** One of the top three, drawn: its gear in hand, its place under it. */
function Podium({ place, you }: { place: BossPlace; you: boolean }) {
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
            size={first ? 4 : 3.2}
            cols={44}
            // Turned toward the side, so the gear in hand shows across
            // its body rather than end-on.
            defaultAngle={-0.9}
            groundInset={2}
            armed
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
