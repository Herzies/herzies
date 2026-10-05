import {
  getItem,
  ItemPreview,
  type ItemUnit,
  RARITY_COLORS,
  requiredDiceForLevel,
  SAFETY_PICK_ID,
  STAT_KEYS,
  STAT_LABELS,
  upgradeSuccessChance,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { type UpgradeRollFn, useUpgradeRoll } from "../hooks/useUpgradeRoll";
import { cn } from "../lib/utils";
import { Checkbox } from "./Checkbox";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { List } from "./List";
import { PromptOverlay } from "./PromptOverlay";

/** One row: a statted card that isn't maxed. Copies of the same card at the
 * same level, both worn or both not, are interchangeable and share a row;
 * copies at different levels don't, which is the point of picking one. */
interface Target {
  /** The copy this row upgrades. */
  unitId: string;
  itemId: string;
  level: number;
  worn: boolean;
  /** How many interchangeable copies the row stands for. */
  count: number;
  /** The die this row's next level needs — this one, or a greyed-out hint. */
  needs: string;
}

/** What's being rolled, frozen when the roll starts: a destroyed card leaves
 * `units`, but the result screen still has to show what it was. */
interface Rolled {
  itemId: string;
  level: number;
  protectedRoll: boolean;
  /** Dice of this kind left once this roll has spent one — counted at roll
   * start rather than read back from `units`, which may not have caught up
   * with the server by the time the result shows. */
  diceLeftAfter: number;
}

/** Green at 100% sliding to red at the long shots. */
function chanceColour(chance: number): string {
  return `hsl(${Math.round(chance * 120)} 75% 55%)`;
}

function formatChance(chance: number): string {
  return `${Math.round(chance * 100)}%`;
}

function statLine(itemId: string, level: number): string {
  const def = getItem(itemId);
  return STAT_KEYS.filter((k) => def?.stats?.[k] !== undefined)
    .map((k) => `${STAT_LABELS[k]}: +${(def?.stats?.[k] ?? 0) + level}`)
    .join(" · ");
}

/** Full-screen overlay opened by clicking a dice item in the Inventory grid.
 * Three steps in one modal: pick a card (every row shows its next step's
 * odds), look at the roll (odds, Safety Pick, what failure costs), then watch
 * it land — "Upgrading…" for at least MIN_ROLL_MS, then the result on the
 * same card. Mirrors ItemInspectOverlay's modal chrome.
 *
 * Picks a specific copy: upgrading one Box of Boom leaves the other alone, so
 * two of them at different levels have to be told apart here. */
export function DiceUpgradeOverlay({
  diceItemId,
  units,
  onRoll,
  onClose,
}: {
  diceItemId: string;
  units: readonly ItemUnit[];
  /** Sends the roll; resolves with how it landed, throws the server's error. */
  onRoll: UpgradeRollFn;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [usePick, setUsePick] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [rolled, setRolled] = useState<Rolled | null>(null);
  const { phase, start, reset } = useUpgradeRoll(onRoll);
  const rolling = phase.status === "rolling";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Mid-roll the modal is locked; while confirming, Escape belongs to
      // the confirm prompt.
      if (e.key !== "Escape" || rolling || confirming) return;
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, rolling, confirming]);

  const dice = getItem(diceItemId);
  if (!dice) return null;

  const unworn = (itemId: string) =>
    units.filter((u) => u.itemId === itemId && u.equippedSlot === null).length;
  const diceLeft = unworn(diceItemId);
  const picksLeft = unworn(SAFETY_PICK_ID);

  const targets = new Map<string, Target>();
  for (const u of units) {
    const def = getItem(u.itemId);
    if (!def?.stats || Object.keys(def.stats).length === 0) continue;
    const needs = requiredDiceForLevel(u.upgradeLevel);
    if (!needs) continue;
    const worn = u.equippedSlot !== null;
    const key = `${u.itemId}:${u.upgradeLevel}:${worn}`;
    const existing = targets.get(key);
    if (existing) existing.count += 1;
    else {
      targets.set(key, {
        unitId: u.id,
        itemId: u.itemId,
        level: u.upgradeLevel,
        worn,
        count: 1,
        needs,
      });
    }
  }
  // Cards this die fits first, then the greyed-out ones.
  const rows = [...targets.values()].sort(
    (a, b) =>
      Number(b.needs === diceItemId) - Number(a.needs === diceItemId) ||
      (getItem(a.itemId)?.name ?? a.itemId).localeCompare(
        getItem(b.itemId)?.name ?? b.itemId,
      ) ||
      b.level - a.level ||
      Number(b.worn) - Number(a.worn),
  );

  const selectedUnit = units.find((u) => u.id === selected) ?? null;
  const close = () => {
    if (!rolling) onClose();
  };

  const roll = () => {
    if (!selectedUnit) return;
    const chance = upgradeSuccessChance(selectedUnit.upgradeLevel);
    const protectedRoll = chance < 1 && usePick && picksLeft > 0;
    setConfirming(false);
    setRolled({
      itemId: selectedUnit.itemId,
      level: selectedUnit.upgradeLevel,
      protectedRoll,
      diceLeftAfter: diceLeft - 1,
    });
    start(selectedUnit.id, protectedRoll ? SAFETY_PICK_ID : null);
  };

  const onUpgradeClick = () => {
    if (!selectedUnit) return;
    const risky = upgradeSuccessChance(selectedUnit.upgradeLevel) < 1;
    if (risky && !(usePick && picksLeft > 0)) setConfirming(true);
    else roll();
  };

  const backToList = () => {
    reset();
    setRolled(null);
    setSelected(null);
  };

  // Once a roll lands, the window has done its job if this die can't be
  // rolled again on anything useful: none left, or the card it just went
  // onto now needs a higher die (or is maxed). A broken card with dice to
  // spare goes back to the list instead, as does an error.
  const doneAfterRoll =
    rolled !== null &&
    "newLevel" in phase &&
    (rolled.diceLeftAfter <= 0 ||
      (phase.status !== "destroyed" &&
        requiredDiceForLevel(phase.newLevel) !== diceItemId));

  let body: React.ReactNode;
  if (rolled && phase.status !== "idle") {
    body = (
      <RollStage
        rolled={rolled}
        phase={phase}
        diceItemId={diceItemId}
        continueLabel={doneAfterRoll ? "Done" : "Continue"}
        onContinue={doneAfterRoll ? onClose : backToList}
      />
    );
  } else if (selectedUnit) {
    const { itemId, upgradeLevel: level } = selectedUnit;
    const def = getItem(itemId)!;
    const chance = upgradeSuccessChance(level);
    const risky = chance < 1;
    const protectedRoll = risky && usePick && picksLeft > 0;
    body = (
      <div className="flex flex-col items-center gap-2 text-center">
        <ItemPreview item={def} box={110} />
        <div>
          <div className="text-ui" style={{ color: RARITY_COLORS[def.rarity] }}>
            "{def.name}" +{level} → +{level + 1}
          </div>
          <div className="mt-1 text-ui-sm text-text-dim">
            {statLine(itemId, level + 1)}
          </div>
        </div>
        {risky && (
          <SafetyPickToggle
            on={protectedRoll}
            picksLeft={picksLeft}
            level={level}
            onChange={setUsePick}
          />
        )}
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            className="btn text-text-dim"
            onClick={() => setSelected(null)}
          >
            Back
          </button>
          <button
            type="button"
            className={cn(
              "btn",
              protectedRoll || !risky ? "text-cyan" : "text-red",
            )}
            onClick={onUpgradeClick}
          >
            Upgrade
          </button>
        </div>
        <div className="text-ui-sm text-text-dim">
          Success chance:{" "}
          <span style={{ color: chanceColour(chance) }}>
            {formatChance(chance)}
          </span>
        </div>
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="py-4 text-center text-ui-sm text-text-dim">
        No cards to upgrade
      </div>
    );
  } else {
    body = (
      <List className="max-h-80">
        {rows.map((target) => {
          const def = getItem(target.itemId)!;
          const { level } = target;
          const fits = target.needs === diceItemId;
          const chance = upgradeSuccessChance(level);
          return (
            <button
              key={`${target.itemId}:${level}:${target.worn}`}
              type="button"
              disabled={!fits}
              onClick={() => {
                setSelected(target.unitId);
                setUsePick(true);
              }}
              className={cn(
                "flex w-full items-center gap-2 border-none bg-transparent px-2 py-1.5 text-left",
                fits ? "cursor-pointer hover:bg-white/5" : "opacity-45",
              )}
            >
              <ItemTypeIcon item={def} className="h-6 w-6 shrink-0" />
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-ui"
                  style={{ color: RARITY_COLORS[def.rarity] }}
                >
                  {def.name}
                  {level > 0 ? ` +${level}` : ""}
                  {target.worn ? " (placed)" : ""}
                  {target.count > 1 ? ` x${target.count}` : ""}
                </div>
                <div className="text-ui-sm text-text-dim">
                  {fits ? (
                    <>
                      +{level + 1} ·{" "}
                      <span style={{ color: chanceColour(chance) }}>
                        {formatChance(chance)}
                      </span>
                    </>
                  ) : (
                    <>
                      +{level} · needs{" "}
                      {getItem(target.needs)?.name ?? target.needs}
                    </>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </List>
    );
  }

  return (
    <>
      <div
        onClick={close}
        className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70"
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="w-80 max-w-full border border-border bg-bg-panel p-3 shadow-xl shadow-black/50"
        >
          <div className="mb-2 text-center text-sm font-bold">Upgrade</div>
          {body}
        </div>
      </div>
      {confirming && selectedUnit && (
        <PromptOverlay
          title="Are you sure?"
          titleId="confirm-risky-upgrade-title"
          onEscape={() => setConfirming(false)}
          actions={[
            {
              label: "Cancel",
              colour: "text-text-dim",
              onClick: () => setConfirming(false),
            },
            { label: "Roll anyway", colour: "text-red", onClick: roll },
          ]}
        >
          If this upgrade fails,{" "}
          <span className="font-bold">
            "{getItem(selectedUnit.itemId)?.name}" +{selectedUnit.upgradeLevel}
          </span>{" "}
          will break and be gone for good.
        </PromptOverlay>
      )}
    </>
  );
}

/** The Safety Pick choice for a risky roll, as one row: the pick, how many
 * are left, and what failing costs under the current choice — so flipping
 * the box visibly flips the stakes. Lit in the pick's rarity colour while
 * it's protecting the card; dashed and inert when there are none. */
function SafetyPickToggle({
  on,
  picksLeft,
  level,
  onChange,
}: {
  on: boolean;
  picksLeft: number;
  level: number;
  onChange: (on: boolean) => void;
}) {
  const pick = getItem(SAFETY_PICK_ID);
  if (!pick) return null;
  const accent = RARITY_COLORS[pick.rarity];
  const none = picksLeft === 0;
  return (
    <Checkbox
      checked={on}
      disabled={none}
      accent={accent}
      onChange={onChange}
      // Hex alpha: ~8% of the rarity colour behind the row while it's on.
      style={
        on ? { borderColor: accent, background: `${accent}14` } : undefined
      }
      className={cn(
        "w-full border px-2 py-1.5 transition-colors duration-100",
        none
          ? "border-dashed border-border opacity-60"
          : on
            ? "hover:brightness-110"
            : "border-border hover:bg-white/5",
      )}
    >
      <span
        className="flex shrink-0 transition-[filter] duration-100"
        style={on ? undefined : { filter: "grayscale(1) opacity(0.6)" }}
      >
        <ItemTypeIcon item={pick} className="h-6 w-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block text-ui"
          style={on ? { color: accent } : undefined}
        >
          {none ? "No Safety Picks" : "Use Safety Pick"}
        </span>
        <span className="block text-ui-sm">
          {on ? (
            <span className="text-text-dim">
              If it fails, the card stays at +{level}
            </span>
          ) : (
            <span className="text-red">If it fails, the card is destroyed</span>
          )}
        </span>
      </span>
      {!none && (
        <span className="shrink-0 text-ui-sm text-text-dim">x{picksLeft}</span>
      )}
    </Checkbox>
  );
}

/** The roll itself, on the card being upgraded: the die (and pick) tumbling
 * onto it with a pulsing glow while the server decides, then the result. */
function RollStage({
  rolled,
  phase,
  diceItemId,
  continueLabel,
  onContinue,
}: {
  rolled: Rolled;
  phase: ReturnType<typeof useUpgradeRoll>["phase"];
  diceItemId: string;
  continueLabel: string;
  onContinue: () => void;
}) {
  const def = getItem(rolled.itemId);
  const dice = getItem(diceItemId);
  const pick = getItem(SAFETY_PICK_ID);
  if (!def || !dice) return null;

  const level = phase.status === "upgraded" ? phase.newLevel : rolled.level;
  const glow = RARITY_COLORS[dice.rarity];

  const headline =
    phase.status === "rolling"
      ? "Upgrading…"
      : phase.status === "upgraded"
        ? `Upgraded to +${phase.newLevel}!`
        : phase.status === "kept"
          ? "Upgrade failed"
          : phase.status === "destroyed"
            ? `"${def.name}" broke`
            : phase.status === "error"
              ? `Upgrade failed: ${phase.message}`
              : "";

  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <div
        className="relative"
        style={{ "--upgrade-glow": glow } as React.CSSProperties}
      >
        <div
          key={phase.status}
          className={cn(
            phase.status === "rolling" && "upgrade-rolling",
            phase.status === "upgraded" && "upgrade-success",
            phase.status === "kept" && "upgrade-kept",
            phase.status === "destroyed" && "upgrade-destroyed",
          )}
        >
          <ItemPreview item={def} box={110} />
        </div>
        {phase.status === "rolling" && (
          <div className="dice-tumble pointer-events-none absolute -top-2 -right-4">
            <ItemPreview item={dice} box={40} />
          </div>
        )}
        {rolled.protectedRoll && pick && phase.status !== "upgraded" && (
          <div
            className={cn(
              "pointer-events-none absolute -top-2 -left-4",
              phase.status === "rolling" ? "dice-tumble" : "pick-shatter",
            )}
          >
            <ItemPreview item={pick} box={36} />
          </div>
        )}
      </div>
      <div className="text-ui" style={{ color: RARITY_COLORS[def.rarity] }}>
        "{def.name}"{" "}
        <span
          key={level}
          className={cn(
            phase.status === "upgraded" && "upgrade-pop",
            "inline-block",
          )}
        >
          +{level}
        </span>
      </div>
      <div
        className={cn(
          "text-ui-lg font-bold",
          phase.status === "rolling" && "animate-pulse text-text",
          phase.status === "upgraded" && "text-green",
          phase.status === "kept" && "text-text-dim",
          (phase.status === "destroyed" || phase.status === "error") &&
            "text-red",
        )}
      >
        {headline}
      </div>
      <button
        type="button"
        className="btn text-cyan"
        disabled={phase.status === "rolling"}
        onClick={onContinue}
      >
        {continueLabel}
      </button>
    </div>
  );
}
