import type { BossPlace } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { clearBossResults, useBossResults } from "./combat/results";

/**
 * The end of a boss fight, for whoever was in the cave: victory or defeat,
 * then the ten who dealt the most over the whole fight — the top one on
 * their own, second and third side by side, the rest in a list — and, if
 * you're not among them, your own place under a "…". It sits below the
 * "Back to town" banner and only its Close button takes the mouse, so the
 * loot can still be picked up; it stays up back in town until closed.
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
  const [first, ...after] = top;
  const podium = after.slice(0, 2);
  const rest = after.slice(2);
  const outside = you !== null && !top.some(mine);

  return (
    <section
      aria-labelledby="boss-results-title"
      className="pointer-events-none absolute top-24 left-1/2 z-30 w-[min(22rem,86%)] -translate-x-1/2 rounded border border-border bg-bg-panel/95 px-4 pt-3 pb-2.5 text-ui text-text shadow-lg"
    >
      <h2
        id="boss-results-title"
        className={cn(
          "text-center text-xl font-bold tracking-wide",
          won ? "text-yellow" : "text-red",
        )}
      >
        {won ? "Victory" : "Defeat"}
      </h2>
      <p className="mb-2.5 text-center text-[10px] text-text-dim">
        {won ? `${name} has fallen.` : `${name} got away.`}
      </p>

      {first ? (
        <>
          <div
            className={cn(
              "mb-2 flex flex-col items-center rounded bg-yellow/10 px-2 py-1.5",
              mine(first) ? "ring-2 ring-cyan" : "ring-1 ring-yellow/40",
            )}
          >
            <span className="text-[10px] text-yellow">1st</span>
            <span
              className={cn(
                "max-w-full truncate text-base font-bold",
                mine(first) ? "text-cyan" : "text-text",
              )}
            >
              {first.name}
            </span>
            <span className="text-[10px] text-text-dim tabular-nums">
              {first.damage.toLocaleString()} damage
            </span>
          </div>

          {podium.length ? (
            <div className="mb-2 grid grid-cols-2 gap-2">
              {podium.map((p) => (
                <div
                  key={p.rank}
                  className={cn(
                    "flex min-w-0 flex-col items-center rounded bg-white/5 px-2 py-1",
                    mine(p) ? "ring-2 ring-cyan" : "ring-1 ring-white/15",
                  )}
                >
                  <span className="text-[10px] text-text-dim">
                    {p.rank === 2 ? "2nd" : "3rd"}
                  </span>
                  <span
                    className={cn(
                      "max-w-full truncate font-bold",
                      mine(p) && "text-cyan",
                    )}
                  >
                    {p.name}
                  </span>
                  <span className="text-[10px] text-text-dim tabular-nums">
                    {p.damage.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {rest.length || outside ? (
            <ol className="flex flex-col gap-0.5">
              {rest.map((p) => (
                <Row key={p.rank} place={p} you={mine(p)} />
              ))}
              {outside && you ? (
                <>
                  <li aria-hidden className="text-center text-text-dim">
                    …
                  </li>
                  <Row place={you} you />
                </>
              ) : null}
            </ol>
          ) : null}
        </>
      ) : (
        <p className="mb-1 text-center text-[10px] text-text-dim">
          Nobody landed a hit.
        </p>
      )}

      <div className="mt-2.5 flex justify-center">
        <button
          type="button"
          className="btn pointer-events-auto"
          onClick={clearBossResults}
        >
          Close
        </button>
      </div>
    </section>
  );
}

function Row({ place, you }: { place: BossPlace; you: boolean }) {
  return (
    <li
      className={cn(
        "flex items-baseline justify-between gap-2",
        you && "text-cyan",
      )}
    >
      <span className="min-w-0 truncate">
        <span className="text-text-dim tabular-nums">{place.rank}.</span>{" "}
        {place.name}
      </span>
      <span className="shrink-0 text-text-dim tabular-nums">
        {place.damage.toLocaleString()}
      </span>
    </li>
  );
}
