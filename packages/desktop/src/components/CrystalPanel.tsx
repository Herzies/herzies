import {
  CRYSTAL_MAX_TIER,
  crystalCapacity,
  crystalUpgradeCost,
  SpeechBubble,
  useChatter,
} from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { notify } from "../lib/notices";
import { cn, formatAmount } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { CrystalView } from "./CrystalView";
import { PIXEL, PixelCrystal, type PixelCrystalLook } from "./PixelCrystal";
import { SegmentBar } from "./SegmentBar";
import { Tooltip } from "./Tooltip";
import { setCrystal, useCrystal } from "./town/crystalState";
import { sfxCrystalBoop, sfxCrystalCharge, sfxCrystalLevel } from "./town/sfx";

/** What the Crystal hums to itself, by how full it is. */
const LINES = {
  asleep: [
    "Zzz... play me something...",
    "So quiet. I only hum when you listen.",
    "Mm? Oh. Hello. I was dozing.",
  ],
  charging: [
    "Mmm, that one's nice.",
    "Keep it playing. I'm warming up.",
    "I can feel the bass from here.",
    "Every song makes me a little brighter.",
  ],
  full: [
    "I'm full! Ready when you are.",
    "So much music in here. It tickles!",
    "Attune with me? I'm glowing!",
  ],
};

/** Below this fill it dozes (as CrystalView draws it). */
const SLEEPY = 0.04;

/** Sprite height, in sprite pixels, of each size of the Crystal. */
const tierHeight = (tier: number) => 5 + tier * 2;
const TALLEST = tierHeight(CRYSTAL_MAX_TIER);

/** Sparks thrown out when a size lights up: [dx, dy] in px. */
const BURST = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2 + 0.2;
  const r = 22 + (i % 2) * 8;
  return [Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)] as const;
});

/**
 * The Crystal's window, opened with E when you've nothing to hand it (right
 * after attuning, say): the Crystal itself, how big it's grown and growing it
 * with Crystal Shards, and your resonance — what charges while you listen.
 * Laid out like the NPCs' windows (QuestGiverPanel): the name, the subject on
 * a stage, then the details and the one action.
 */
export function CrystalPanel({ paused = false }: { paused?: boolean }) {
  const crystal = useCrystal();
  const [busy, setBusy] = useState(false);
  /** The size that just lit up, and a count to replay its pop. */
  const [popped, setPopped] = useState<{ tier: number; n: number } | null>(
    null,
  );
  const [boopAt, setBoopAt] = useState(0);
  // The pop plays once; then the size it grew to bobs like the current one
  // (tier -1: nothing popping; `n` still counts the grows).
  useEffect(() => {
    if (!popped || popped.tier < 0) return;
    const t = setTimeout(
      () => setPopped((p) => (p ? { ...p, tier: -1 } : p)),
      900,
    );
    return () => clearTimeout(t);
  }, [popped]);

  const charge =
    crystal && crystal.capacity > 0 ? crystal.fill / crystal.capacity : 0;
  const mood = charge < SLEEPY ? "asleep" : charge >= 1 ? "full" : "charging";
  const { line, typed, advance } = useChatter(LINES[mood], !paused);
  const shownHours = useGlide(crystal ? crystal.capacity / 60 : 0);

  if (!crystal) {
    return <div className="text-[10px] text-text-dim">...</div>;
  }

  const fill = Math.min(1, charge);
  const cost = crystalUpgradeCost(crystal.tier);
  const canGrow = cost !== null && crystal.shards >= cost;

  const grow = async () => {
    setBusy(true);
    // The wind-up: light gathering while the server answers.
    sfxCrystalCharge();
    try {
      const r = await herzies.upgradeCrystal();
      setCrystal(r.crystal);
      if (r.ok) {
        sfxCrystalLevel();
        setPopped((p) => ({ tier: r.crystal.tier, n: (p?.n ?? 0) + 1 }));
        notify(`The Crystal grew: it holds ${hours(r.crystal.capacity)} now`, {
          kind: "success",
        });
      } else
        notify(
          r.reason === "max-tier"
            ? "The Crystal can't grow any more"
            : "Not enough Crystal Shards",
        );
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const boop = () => {
    sfxCrystalBoop();
    setBoopAt((n) => n + 1);
    advance();
  };

  const look = (i: number): PixelCrystalLook =>
    i <= crystal.tier ? "lit" : i === crystal.tier + 1 ? "next" : "locked";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-center text-[16px] font-bold text-cyan">
        The Crystal
      </div>

      {/* Its stage: the crystal, lit by how full it is, its line at its
          feet. Click it and it wobbles and says something. */}
      <div className="relative flex h-[190px] shrink-0 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">
          <CrystalView
            charge={charge}
            tier={crystal.tier}
            paused={paused}
            grownAt={popped?.n ?? 0}
            boopAt={boopAt}
            talking={line !== null && typed < line.length}
          />
        </div>
        <button
          type="button"
          aria-label="Poke the Crystal"
          onClick={boop}
          className="absolute inset-0 z-[2] cursor-pointer border-none bg-transparent p-0"
        />
        <SpeechBubble line={line} typed={typed} />
      </div>

      <div className="mt-1 flex min-h-0 flex-col gap-1.5">
        <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider text-text-dim">
          <span>Crystal size</span>
          <span
            key={popped?.n ?? 0}
            className={cn(
              "normal-case tracking-normal",
              popped &&
                popped.tier >= 0 &&
                "animate-[crystal-text-pop_600ms_ease-out] text-cyan",
            )}
          >
            Holds {formatHours(shownHours)} of listening
          </span>
        </div>

        {/* The sizes, smallest to largest: grown ones lit, the next one
            waiting in outline, the rest dark. */}
        <div
          className="flex items-end justify-between px-1"
          style={{ height: TALLEST * PIXEL + 18 }}
        >
          {Array.from({ length: CRYSTAL_MAX_TIER + 1 }, (_, i) => {
            const l = look(i);
            const current = i === crystal.tier;
            const pop = popped?.tier === i;
            return (
              <Tooltip
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed tiers
                key={i}
                label={
                  i <= crystal.tier
                    ? `Size ${i + 1}: holds ${hours(crystalCapacity(i))}`
                    : `Size ${i + 1}: would hold ${hours(crystalCapacity(i))}`
                }
              >
                <div className="flex flex-col items-center gap-1">
                  <div className="relative">
                    {current ? (
                      <div
                        aria-hidden="true"
                        className="absolute -inset-2 rounded-full bg-cyan/25 blur-md"
                      />
                    ) : null}
                    <PixelCrystal
                      key={pop ? `pop${popped.n}` : "still"}
                      h={tierHeight(i)}
                      look={l}
                      className={cn(
                        "relative",
                        current &&
                          !pop &&
                          "animate-[crystal-bob_2.4s_ease-in-out_infinite]",
                        l === "next" &&
                          "animate-[crystal-next_1.6s_ease-in-out_infinite]",
                        pop && "animate-[crystal-pop_700ms_ease-out]",
                        l === "lit" &&
                          "drop-shadow-[0_0_3px_rgba(127,232,255,0.55)]",
                      )}
                    />
                    {pop ? (
                      <div
                        key={`burst${popped.n}`}
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0"
                      >
                        {BURST.map(([dx, dy], k) => (
                          <span
                            // biome-ignore lint/suspicious/noArrayIndexKey: fixed sparks
                            key={k}
                            className="absolute top-1/2 left-1/2 size-1 opacity-0 animate-[crystal-burst_650ms_ease-out_forwards] bg-white shadow-[0_0_4px_#7fe8ff]"
                            style={
                              {
                                "--dx": `${dx}px`,
                                "--dy": `${dy}px`,
                                animationDelay: `${(k % 3) * 30}ms`,
                              } as React.CSSProperties
                            }
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      "text-ui-sm leading-none",
                      i <= crystal.tier
                        ? "text-cyan"
                        : l === "next"
                          ? "text-text"
                          : "text-text-dim/60",
                    )}
                  >
                    {crystalCapacity(i) / 60}h
                  </span>
                </div>
              </Tooltip>
            );
          })}
        </div>

        <div className="mt-1 flex items-center justify-between gap-2 border-t border-white/15 pt-1.5 text-ui">
          <Tooltip
            label={`${formatAmount(crystal.shards)} Crystal Shard${crystal.shards === 1 ? "" : "s"}`}
          >
            <span className="text-cyan">◆ {formatAmount(crystal.shards)}</span>
          </Tooltip>
          {cost !== null ? (
            <button
              type="button"
              className={cn(
                "btn",
                canGrow ? "text-cyan" : "text-text-dim",
                canGrow &&
                  !busy &&
                  "animate-[crystal-ready_1.6s_ease-in-out_infinite]",
              )}
              disabled={busy || !canGrow}
              onClick={grow}
            >
              {busy
                ? "Growing..."
                : `Grow to ${crystalCapacity(crystal.tier + 1) / 60}h · ◆ ${cost}`}
            </button>
          ) : (
            <span className="text-ui-sm text-cyan">Fully grown</span>
          )}
        </div>
        {cost !== null && !canGrow ? (
          <div className="text-ui-sm text-text-dim">
            {cost - crystal.shards} more shard
            {cost - crystal.shards === 1 ? "" : "s"} to grow. Quests and events
            give them.
          </div>
        ) : null}

        <div className="mt-2 border-t border-white/15 pt-1.5 text-[10px] uppercase tracking-wider text-text-dim">
          Your resonance{charge >= 1 ? " · full" : ""}
        </div>
        <div className="flex items-center gap-2">
          <SegmentBar className="flex-1" progress={fill} colour="bg-cyan" />
          <span className="shrink-0 text-ui-sm text-text-dim">
            {clock(crystal.fill)} / {clock(crystal.capacity)}
          </span>
        </div>
        <div className="text-ui-sm text-text-dim">
          Listen to music to charge your resonance.
        </div>
      </div>
    </div>
  );
}

/** `value`, gliding to a new one over a moment rather than jumping. */
function useGlide(value: number, ms = 650): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    if (a === value) return;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const v = a + (value - a) * (1 - (1 - t) ** 3);
      from.current = v;
      setShown(v);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return shown;
}

/** 3 hours, 4.5 hours. */
function formatHours(h: number): string {
  const r = Math.round(h * 10) / 10;
  return `${r} hour${r === 1 ? "" : "s"}`;
}

function hours(minutes: number): string {
  return `${formatHours(minutes / 60)} of listening`;
}

/** 2h 05m. */
function clock(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
