import {
  buffMult,
  defReduction,
  formatStat,
  type HerzieStats,
  healMult,
  maxHp as maxHpFor,
  NO_STAT_POINTS,
  POINT_STATS,
  type PointStat,
  STAT_KEYS,
  STAT_LABELS,
  type StatPoints,
  statPoints,
  waveDamage,
  withStatPoints,
} from "@herzies/shared";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { Tooltip } from "./Tooltip";
import { refreshVitals } from "./town/vitals";

/** The stats points go into, in the order they're listed. */
const PRIMARY = STAT_KEYS.filter((k): k is PointStat =>
  (POINT_STATS as readonly string[]).includes(k),
);
/** Everything else a herzie has: from its cards, or following from the
 * primary stats. */
const SECONDARY = STAT_KEYS.filter(
  (k) => !(POINT_STATS as readonly string[]).includes(k),
);

/** One secondary line: what it's called, its value now, and the value it
 * would become (a held card, or points being placed). */
type Line = {
  key: string;
  label: string;
  now: number;
  next: number;
  text: (v: number) => string;
  hint?: string;
};

/** The secondary stats: Max HP, Damage and Healing (which follow from the
 * level, Stamina, Sonic Power and Euphony), then the rest in catalog
 * order. */
function secondaryLines(
  level: number | undefined,
  now: HerzieStats,
  nowStamina: number,
  next: HerzieStats,
  nextStamina: number,
): Line[] {
  const lines: Line[] = [];
  if (level)
    lines.push({
      key: "maxHp",
      label: "Max HP",
      now: maxHpFor(level, nowStamina),
      next: maxHpFor(level, nextStamina),
      text: String,
    });
  lines.push({
    key: "damage",
    label: "Damage",
    now: waveDamage(now.sonicPower),
    next: waveDamage(next.sonicPower),
    text: String,
    hint: "What one sonic wave deals, before crits",
  });
  lines.push({
    key: "healing",
    label: "Healing",
    now: Math.round((healMult(now.euphony) - 1) * 100),
    next: Math.round((healMult(next.euphony) - 1) * 100),
    text: (v) => `+${v}%`,
    hint: `Heals +${Math.round((healMult(next.euphony) - 1) * 100)}%, buffs +${Math.round((buffMult(next.euphony) - 1) * 100)}%, from Euphony`,
  });
  for (const key of SECONDARY)
    lines.push({
      key,
      label: STAT_LABELS[key],
      now: now[key],
      next: next[key],
      text: (v) => formatStat(key, v),
      hint:
        key === "def"
          ? `Takes ${Math.round(defReduction(next.def) * 100)}% off every hit`
          : undefined,
    });
  return lines;
}

/** Green if it would go up, red if down, else the label's own dim colour —
 * a bright one read as a bigger number. */
function changeColour(change: number) {
  return change > 0 ? "text-green" : change < 0 ? "text-red" : "text-text-dim";
}

function LineRow({ line }: { line: Line }) {
  const label = <span className="text-text-dim">{line.label}</span>;
  return (
    <div className="flex items-center justify-between gap-2">
      {line.hint ? <Tooltip label={line.hint}>{label}</Tooltip> : label}
      <span className={changeColour(line.next - line.now)}>
        {line.text(line.next)}
      </span>
    </div>
  );
}

/**
 * The Herzie view's Stats tab: where stat points are spent. The stats they
 * go into on the left, `+`/`−` on each, and what follows from them on the
 * right, showing what Save would make of them. Reset refunds every point
 * (Save still makes it so; Cancel takes it back).
 */
export function StatsTab({
  stats,
  level,
  points,
  onLog,
}: {
  /** What the herzie's cards give. */
  stats: HerzieStats;
  level: number;
  points: StatPoints;
  onLog?: (msg: string) => void;
}) {
  /** The allocation being placed; equal to `points` when nothing's moved. */
  const [draft, setDraft] = useState<StatPoints | null>(null);
  const [saving, setSaving] = useState(false);
  const placing = draft ?? points;
  const { unspent } = statPoints(level, placing);
  const dirty = POINT_STATS.some((k) => placing[k] !== points[k]);

  const now = withStatPoints(stats, points, level);
  const next = withStatPoints(stats, placing, level);

  const bump = (key: PointStat, by: 1 | -1) => {
    if (by > 0 && unspent <= 0) return;
    setDraft({ ...placing, [key]: Math.max(0, placing[key] + by) });
  };

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await herzies.allocateStats(placing);
      // The new max HP. Skipped in a fight, whose own count is truer.
      refreshVitals();
      setDraft(null);
    } catch (e) {
      onLog?.(`Couldn't save stat points: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 pt-1.5 text-ui">
      {/* The buttons share the heading's line, so the tab fits without
          scrolling. */}
      <div className="flex items-baseline justify-between">
        <span
          className={cn("font-bold", unspent > 0 ? "text-yellow" : "text-text")}
        >
          {unspent} point{unspent === 1 ? "" : "s"} to spend
        </span>
        <span className="flex gap-3">
          <TextButton disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </TextButton>
          <TextButton
            disabled={saving || POINT_STATS.every((k) => placing[k] === 0)}
            onClick={() => setDraft({ ...NO_STAT_POINTS })}
          >
            Reset
          </TextButton>
          <TextButton
            disabled={!dirty || saving}
            onClick={() => setDraft(null)}
          >
            Cancel
          </TextButton>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          {PRIMARY.map((key) => (
            <div key={key} className="flex items-center justify-between gap-1">
              <Tooltip label={`Cards ${stats[key]} · Points ${placing[key]}`}>
                <span className="text-text-dim">{STAT_LABELS[key]}</span>
              </Tooltip>
              <span className="flex items-center gap-1">
                <StepButton
                  disabled={placing[key] <= 0 || saving}
                  onClick={() => bump(key, -1)}
                >
                  −
                </StepButton>
                <span
                  className={cn(
                    "min-w-[3ch] text-center",
                    changeColour(next[key] - now[key]),
                  )}
                >
                  {formatStat(key, next[key])}
                </span>
                <StepButton
                  disabled={unspent <= 0 || saving}
                  onClick={() => bump(key, 1)}
                >
                  +
                </StepButton>
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1 border-l border-border pl-3">
          {secondaryLines(
            level,
            now,
            points.stamina,
            next,
            placing.stamina,
          ).map((line) => (
            <LineRow key={line.key} line={line} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StepButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer border border-border bg-transparent px-1 leading-none text-text-dim hover:text-cyan disabled:cursor-default disabled:opacity-30 disabled:hover:text-text-dim"
    >
      {children}
    </button>
  );
}

function TextButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer border-none bg-transparent p-0 text-text-dim hover:text-cyan disabled:cursor-default disabled:opacity-40 disabled:hover:text-text-dim"
    >
      {children}
    </button>
  );
}
