import {
  CRYSTAL_MAX_TIER,
  crystalCapacity,
  crystalUpgradeCost,
} from "@herzies/shared";
import { useState } from "react";
import { notify } from "../lib/notices";
import { cn, formatAmount } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { SegmentBar } from "./SegmentBar";
import { Tooltip } from "./Tooltip";
import { setCrystal, useCrystal } from "./town/crystalState";

/**
 * The Crystal's window, opened with E when you've nothing to hand it (right
 * after attuning, say): your resonance — what charges while you listen —
 * how full it is, how much it holds, and growing it with Crystal Shards. Laid out like the NPCs' windows (QuestGiverPanel):
 * the name, the subject on a stage, then the details and the one action.
 */
export function CrystalPanel() {
  const crystal = useCrystal();
  const [busy, setBusy] = useState(false);

  if (!crystal) {
    return <div className="text-[10px] text-text-dim">...</div>;
  }

  const fill = crystal.capacity > 0 ? crystal.fill / crystal.capacity : 0;
  const cost = crystalUpgradeCost(crystal.tier);
  const canGrow = cost !== null && crystal.shards >= cost;

  const grow = async () => {
    setBusy(true);
    try {
      const r = await herzies.upgradeCrystal();
      setCrystal(r.crystal);
      if (r.ok)
        notify(
          `Your resonance grew: it holds ${hours(r.crystal.capacity)} now`,
          {
            kind: "success",
          },
        );
      else
        notify(
          r.reason === "max-tier"
            ? "Your resonance can't grow any more"
            : "Not enough Crystal Shards",
        );
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-center text-[16px] font-bold text-cyan">
        The Crystal
      </div>

      {/* Its stage: the crystal, lit by how full it is. */}
      <div className="relative flex h-[190px] shrink-0 items-center justify-center">
        <CrystalArt fill={fill} />
      </div>

      <div className="mt-2 flex min-h-0 flex-col gap-1.5">
        <div className="text-[10px] uppercase tracking-wider text-text-dim">
          Crystal size
        </div>
        <div className="flex items-center gap-1">
          {Array.from({ length: CRYSTAL_MAX_TIER + 1 }, (_, i) => (
            <Tooltip
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed tiers
              key={i}
              label={`Holds ${hours(crystalCapacity(i))}`}
              className="flex-1"
            >
              <SizeBlock unlocked={i <= crystal.tier} seed={i} />
            </Tooltip>
          ))}
        </div>

        <div className="mt-1 flex items-center justify-between gap-2 border-t border-white/15 pt-1.5 text-ui">
          <span className="text-text-dim">
            {formatAmount(crystal.shards)} Crystal Shard
            {crystal.shards === 1 ? "" : "s"}
          </span>
          {cost !== null ? (
            <button
              type="button"
              className="btn text-cyan"
              disabled={busy || !canGrow}
              onClick={grow}
            >
              {busy
                ? "Growing..."
                : `Grow (${cost} shard${cost === 1 ? "" : "s"})`}
            </button>
          ) : null}
        </div>
        {cost !== null && !canGrow ? (
          <div className="text-ui-sm text-text-dim">
            Get Crystal Shards from quests and events.
          </div>
        ) : null}
        <div className="mt-2 border-t border-white/15 pt-1.5 text-[10px] uppercase tracking-wider text-text-dim">
          Your resonance{fill >= 1 ? " · full" : ""}
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

/** Sparkles per unlocked block, each with its own spot and timing. */
const SPARKS = 5;

/** One step of the Crystal's size: dark while locked; unlocked, crystal
 * coloured with glints drifting up through it. */
function SizeBlock({ unlocked, seed }: { unlocked: boolean; seed: number }) {
  if (!unlocked) return <div className="h-5 w-full bg-[#333]" />;
  return (
    <div className="relative h-5 w-full overflow-hidden bg-gradient-to-b from-[#c8f6ff] via-[#7fe8ff] to-[#3f9fc4] shadow-[0_0_8px_rgba(127,232,255,0.45)]">
      {/* A facet's sheen across the top. */}
      <div className="absolute inset-x-0 top-0 h-1/3 bg-white/35" />
      {Array.from({ length: SPARKS }, (_, k) => {
        // Spread by a little hash of the block and spark, so neighbouring
        // blocks don't twinkle in step.
        const h = ((seed * 7 + k * 13) % 17) / 17;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed sparks
            key={k}
            className="absolute size-[3px] animate-[crystal-spark_1.8s_ease-in-out_infinite] bg-white shadow-[0_0_4px_#fff]"
            style={{
              left: `${8 + ((k * 19 + seed * 11) % 84)}%`,
              bottom: "-3px",
              animationDelay: `${(h * 1.8).toFixed(2)}s`,
              animationDuration: `${(1.4 + h * 0.9).toFixed(2)}s`,
            }}
          />
        );
      })}
    </div>
  );
}

function hours(minutes: number): string {
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? "" : "s"} of listening`;
}

/** 2h 05m. */
function clock(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A faceted crystal over a little plinth, glowing and pulsing with how
 * full it is (the same colours as the one in Town). */
function CrystalArt({ fill }: { fill: number }) {
  const f = Math.max(0, Math.min(1, fill));
  const glow = 0.15 + 0.6 * f;
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div
        className="absolute size-40 animate-pulse rounded-full blur-2xl"
        style={{ background: `rgba(127,232,255,${glow * 0.6})` }}
      />
      <svg
        viewBox="0 0 100 140"
        className="relative h-[170px] animate-[crystal-float_3.2s_ease-in-out_infinite]"
        role="img"
        aria-label="The Crystal"
      >
        <title>The Crystal</title>
        {/* Plinth */}
        <polygon points="22,124 78,124 72,134 28,134" fill="#7d7887" />
        <polygon points="30,114 70,114 78,124 22,124" fill="#a39fab" />
        {/* Crystal: left and right halves, light and shade. */}
        <g style={{ filter: `drop-shadow(0 0 ${4 + 10 * f}px #7fe8ff)` }}>
          <polygon
            points="50,8 30,58 50,104"
            fill={mix("#3a5f8a", "#7fe8ff", f)}
          />
          <polygon
            points="50,8 70,58 50,104"
            fill={mix("#2c4a6e", "#4fc4e6", f)}
          />
          <polygon
            points="50,8 30,58 50,52"
            fill={mix("#5b82ad", "#c8f6ff", f)}
            opacity={0.85}
          />
          <polygon
            points="50,8 70,58 50,52"
            fill={mix("#47709b", "#9ff0ff", f)}
            opacity={0.7}
          />
        </g>
      </svg>
    </div>
  );
}

/** Mix two #rrggbb colours, t from 0 to 1. */
function mix(a: string, b: string, t: number): string {
  const p = (h: string, i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  const c = [1, 3, 5].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
