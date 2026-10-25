import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { clock } from "./cave";
import { bossFight, mobsLeft, useBossFight } from "./combat/fight";

/**
 * What the boss room shows over the world: the boss's health (with its
 * phases marked), a flash of red when you're hit, and how long until the
 * room closes once the fight is over. (The door's and the room's little
 * messages are notices: lib/notices.ts.)
 */
export function BossHud({ name }: { name: string }) {
  useBossFight();
  const { on, hp, maxHp, closing, victory, youHitAt, tower } = bossFight;
  const [now, setNow] = useState(() => performance.now());
  // Ticks while something counts down: the room closing, or a Tower
  // floor's enrage.
  const counting = !!closing || (!!tower?.enrageAt && !tower.cleared);
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(t);
  }, [counting]);

  const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const closes = closing ? Math.max(0, closing.at - now) : 0;
  return (
    <>
      {on && tower ? (
        <div
          role="status"
          className="pointer-events-none absolute top-2 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded bg-black/35 px-2.5 py-1 text-center text-ui text-white backdrop-blur-md"
        >
          <span className="font-medium">Floor {tower.floor}</span>
          <span className="text-text-dim">
            {" · "}
            {tower.cleared ? "cleared" : `${mobsLeft()} left`}
          </span>
          <EnrageTag tower={tower} now={now} />
        </div>
      ) : on ? (
        <div
          className="pointer-events-none absolute top-2 left-1/2 z-30 w-[min(26rem,80%)] -translate-x-1/2"
          role="progressbar"
          aria-label={`${name} health`}
          aria-valuemin={0}
          aria-valuemax={maxHp}
          aria-valuenow={Math.round(hp)}
        >
          <div className="mb-0.5 flex justify-between px-0.5 text-[11px] text-white/90 [text-shadow:0_1px_2px_#000]">
            <span className="font-medium">{name}</span>
            <span className="tabular-nums text-white/70">
              {Math.ceil(hp).toLocaleString()} / {maxHp.toLocaleString()}
            </span>
          </div>
          <div className="relative h-2.5 overflow-hidden rounded-sm bg-black/60 ring-1 ring-white/25">
            <div
              className="h-full bg-red-500 transition-[width] duration-200"
              style={{ width: `${frac * 100}%` }}
            />
            {/* Where it changes gear. */}
            {[0.66, 0.33].map((p) => (
              <span
                key={p}
                className="absolute top-0 h-full w-px bg-white/50"
                style={{ left: `${p * 100}%` }}
              />
            ))}
          </div>
        </div>
      ) : null}
      {closing ? (
        <div
          role="status"
          className={cn(
            "pointer-events-none absolute top-12 left-1/2 z-30 -translate-x-1/2 rounded bg-black/70 px-3 py-1.5 text-center text-ui text-white",
          )}
        >
          {tower
            ? "The Tower is closing…"
            : victory
              ? "The boss has fallen!"
              : "The boss is slipping away…"}{" "}
          <span className="text-white/60 tabular-nums">
            Back to town in {clock(closes)}
          </span>
        </div>
      ) : null}
      {on && performance.now() - youHitAt < 450 ? (
        <div
          key={youHitAt}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 motion-safe:animate-[hurt_0.45s_ease-out_forwards]"
          style={{ boxShadow: "inset 0 0 90px 20px rgba(220,38,38,0.55)" }}
        />
      ) : null}
    </>
  );
}

/** How long until a Tower floor's mobs enrage, once it's close (the last
 * 20 seconds), then that they have. */
function EnrageTag({
  tower,
  now,
}: {
  tower: { enrageAt: number | null; cleared: boolean };
  now: number;
}) {
  if (tower.cleared || tower.enrageAt === null) return null;
  const left = Math.max(0, tower.enrageAt - now);
  if (left > 20_000) return null;
  return (
    <span className={cn("font-medium", left > 0 ? "text-orange" : "text-red")}>
      {" · "}
      {left > 0 ? `enrage in ${Math.ceil(left / 1000)}s` : "enraged!"}
    </span>
  );
}
