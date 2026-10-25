import {
  DEFAULT_Y_ANGLE,
  type Equipped,
  getItem,
  ItemTypeIcon,
  RARITY_COLORS,
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
import ItemInspectOverlay, {
  INSPECT_ORIGIN_ATTR,
  inspectOrigin,
} from "./ItemInspectOverlay";
import { List } from "./List";

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
  equipped,
  onClaimed,
  onLog,
  paused,
}: {
  guard: TowerGuard | null;
  /** Your deck, for the inspect card's set progress. */
  equipped?: Equipped | null;
  /** Fetch him again: the reward's gone, the "!" with it. */
  onClaimed: () => void;
  onLog?: (msg: string) => void;
  paused: boolean;
}) {
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
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
  // What he owes you, or else what this month's best climber will get.
  const rewardId =
    (owed ? guard?.reward.itemId : current?.rewardItemId) ?? null;
  const rewardItem = rewardId ? getItem(rewardId) : undefined;

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

      <div className="mt-2 min-h-0 shrink-0">
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
          // As the Orphiez finders list: a line under each row but the last.
          <List>
            {[
              ...top.map((p) => ({ ...p, mine: you?.rank === p.rank })),
              ...(you && !youShown
                ? [
                    {
                      rank: you.rank,
                      name: "you",
                      floor: you.floor,
                      mine: true,
                    },
                  ]
                : []),
            ].map((p) => (
              <div
                key={`${p.rank}-${p.name}`}
                className="mb-1 flex justify-between border-b border-white/15 py-1 text-ui last:mb-0 last:border-b-0"
              >
                <span
                  className={
                    p.mine
                      ? "text-cyan"
                      : p.rank === 1
                        ? "text-yellow"
                        : "text-text"
                  }
                >
                  {p.rank}. {p.name}
                </span>
                <span className="text-text-dim">Floor {p.floor}</span>
              </div>
            ))}
          </List>
        )}
      </div>

      {/* At the bottom: last month's winner, then the reward. */}
      {guard?.last || rewardItem ? (
        <div className="mt-auto flex flex-col gap-1.5">
          {guard?.last ? (
            <div className="text-[10px] text-text-dim">
              Last month: <span className="text-yellow">{guard.last.name}</span>
              , floor {guard.last.floor}.
            </div>
          ) : null}
          {rewardItem ? (
            <div
              className={cn(
                "flex items-center justify-between gap-2 text-ui",
                guard?.last && "border-t border-white/15 pt-1.5",
              )}
            >
              {/* As reward lists are elsewhere: the card flies out of the icon. */}
              <button
                type="button"
                title="Inspect"
                onClick={() => setInspecting(true)}
                {...{ [INSPECT_ORIGIN_ATTR]: "tower-reward" }}
                className="group flex min-w-0 cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-left text-ui text-text-dim"
              >
                <span className="shrink-0">Highest climber's reward:</span>
                <ItemTypeIcon item={rewardItem} className="h-6 w-6 shrink-0" />
                <span
                  className="truncate group-hover:underline"
                  style={{ color: RARITY_COLORS[rewardItem.rarity] }}
                >
                  {rewardItem.name}
                </span>
              </button>
              {owed ? (
                <button
                  type="button"
                  className="btn text-yellow"
                  disabled={claiming}
                  onClick={claim}
                >
                  {claiming ? "Claiming..." : "Claim"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {error && (
        <div className="pt-1 text-center text-[10px] text-red">{error}</div>
      )}

      {inspecting && rewardItem ? (
        <ItemInspectOverlay
          itemId={rewardItem.id}
          origin={inspectOrigin("tower-reward")}
          onClose={() => setInspecting(false)}
          equipped={equipped}
        />
      ) : null}
    </div>
  );
}
