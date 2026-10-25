import {
  DEFAULT_Y_ANGLE,
  getItem,
  SpeechBubble,
  TOWER_GUARD_EQUIPPED,
  TOWER_GUARD_NAME,
  TOWER_GUARD_SEED,
  TOWER_GUARD_STAGE,
  useChatter,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { useState } from "react";
import { notify } from "../lib/notices";
import { useHerzieStage } from "../lib/overlayStage";
import { cn } from "../lib/utils";
import { herzies, type TowerGuard } from "../tauri-bridge";

/** What he says to anyone: nobody lasts up there, least of all you. */
export const TOWER_GUARD_LINES = [
  "The Tower? You? That's adorable.",
  "Nobody lasts up there. You won't either.",
  "Floor four. That's where the brave ones cry.",
  "I've swept up better climbers than you.",
  "Go on, then. I'll keep your spot warm. At the bottom.",
  "Every month someone thinks they're special.",
  "The one who climbs highest gets paid. It won't be you.",
  "I've guarded this door for years. Nobody's impressed me yet.",
];

/** What he says to whoever he owes: still not impressed. */
const OWED_LINES = [
  "Fine. You climbed the highest. Don't let it go to your head.",
  "Here. Take it before I change my mind.",
  "Beginner's luck. Doesn't happen twice.",
];

/**
 * The Tower Guard, by the Tower: this month's three best climbers and where
 * you stand, last month's winner, and — for that winner — the reward
 * (claimed here, once). `guard` is null while it loads.
 */
export function TowerGuardPanel({
  guard,
  onClaimed,
  onLog,
  paused,
}: {
  guard: TowerGuard | null;
  /** Fetch him again: the reward's gone, the "!" with it. */
  onClaimed: () => void;
  onLog?: (msg: string) => void;
  paused: boolean;
}) {
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owed = !!guard?.reward.eligible;
  const { line, typed, advance } = useChatter(
    owed ? OWED_LINES : TOWER_GUARD_LINES,
    !paused,
  );
  const { stage: onStage } = useHerzieStage();

  const rewardName = (id: string | null | undefined) =>
    (id && getItem(id)?.name) ?? "the reward";

  const claim = async () => {
    setError(null);
    setClaiming(true);
    try {
      const { itemId } = await herzies.claimTowerReward();
      const name = rewardName(itemId);
      notify(`Received "${name}"`, { kind: "success" });
      onLog?.(`Received "${name}" from the ${TOWER_GUARD_NAME}`);
      onClaimed();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaiming(false);
    }
  };

  const current = guard?.current ?? null;
  const top = current?.top ?? [];
  const you = current?.you ?? null;
  const youShown = !!you && top.some((p) => p.rank === you.rank);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-center text-[16px] font-bold text-[#c9d2dc]">
        {TOWER_GUARD_NAME}
      </div>

      {/* Staged as the merchants are: square on, his line at his feet. */}
      <div className="relative flex h-[190px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <HerzieView
            onStage={onStage}
            userId={TOWER_GUARD_SEED}
            stage={TOWER_GUARD_STAGE}
            zoom={0.8}
            size={5}
            cols={64}
            equipped={TOWER_GUARD_EQUIPPED}
            animate={false}
            defaultAngle={-DEFAULT_Y_ANGLE}
            draggable={false}
            paused={paused}
            ariaLabel={TOWER_GUARD_NAME}
          />
        </div>
        <button
          type="button"
          aria-label={`Talk to the ${TOWER_GUARD_NAME}`}
          onClick={advance}
          className="absolute inset-0 z-[2] cursor-pointer border-none bg-transparent p-0"
        />
        <SpeechBubble line={line} typed={typed} />
      </div>

      {owed && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-yellow/40 bg-yellow/10 px-2 py-1.5 text-ui">
          <span>
            Top climber's reward:{" "}
            <span className="text-yellow">
              {rewardName(guard?.reward.itemId)}
            </span>
          </span>
          <button
            type="button"
            className="btn text-yellow"
            disabled={claiming}
            onClick={claim}
          >
            {claiming ? "Claiming..." : "Claim"}
          </button>
        </div>
      )}

      <div className="min-h-0 shrink-0">
        <div className="mb-0.5 text-ui text-text-dim">
          Highest climbers this month:
        </div>
        {!guard ? (
          <div className="text-[10px] text-text-dim">...</div>
        ) : !current ? (
          <div className="text-[10px] text-text-dim">
            The Tower's shut. Lucky you.
          </div>
        ) : top.length === 0 ? (
          <div className="text-[10px] text-text-dim">
            Nobody's even tried. Can't blame them.
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {top.map((p) => (
              <div
                key={`${p.rank}-${p.name}`}
                className={cn(
                  "flex items-baseline justify-between text-ui",
                  you?.rank === p.rank && "text-cyan",
                )}
              >
                <span className={cn(p.rank === 1 && "text-yellow")}>
                  {p.rank}. {p.name}
                </span>
                <span className="text-text-dim">Floor {p.floor}</span>
              </div>
            ))}
            {you && !youShown ? (
              <div className="mt-0.5 flex items-baseline justify-between border-t border-white/15 pt-0.5 text-ui text-cyan">
                <span>{you.rank}. you</span>
                <span>Floor {you.floor}</span>
              </div>
            ) : null}
          </div>
        )}
        {guard?.last ? (
          <div className="mt-1.5 text-[10px] text-text-dim">
            Last month: <span className="text-yellow">{guard.last.name}</span>,
            floor {guard.last.floor}.
          </div>
        ) : null}
      </div>

      {error && (
        <div className="pt-1 text-center text-[10px] text-red">{error}</div>
      )}
    </div>
  );
}
