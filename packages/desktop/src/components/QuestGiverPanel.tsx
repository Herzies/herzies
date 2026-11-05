import {
  DEFAULT_Y_ANGLE,
  type Equipped,
  getItem,
  PIP_EQUIPPED,
  PIP_KEY,
  PIP_NAME,
  PIP_SEED,
  PIP_STAGE,
  SpeechBubble,
  useChatter,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { useState } from "react";
import { notify } from "../lib/notices";
import { useHerzieStage } from "../lib/overlayStage";
import { refreshQuests, setQuestBoard } from "../lib/quests";
import { herzies, type QuestBoard, type QuestReward } from "../tauri-bridge";
import { Coin } from "./Coin";
import { SegmentBar } from "./SegmentBar";

/** Who a quest giver is, how they look and what they say in each state. */
export interface QuestGiver {
  key: string;
  name: string;
  seed: string;
  stage: number;
  equipped: Equipped;
  lines: {
    /** A quest to offer. */
    offer: string[];
    /** You're on it. */
    active: string[];
    /** You did it: turn it in. */
    done: string[];
    /** Nothing more today. */
    rest: string[];
  };
}

/** Pip: a hatchling who's only just getting into music. He wants to learn,
 * and he wants to see if you can keep up. */
export const PIP: QuestGiver = {
  key: PIP_KEY,
  name: PIP_NAME,
  seed: PIP_SEED,
  stage: PIP_STAGE,
  equipped: PIP_EQUIPPED,
  lines: {
    offer: [
      "I'm trying to learn everything about music. Everything!",
      "I've got a challenge for you. I'm doing it too, so no cheating.",
      "Bet you can't find something new today. I can. Probably.",
      "My headphones are a bit big. I'll grow into them.",
      "Did you know there's a genre called zeuhl? There are so many!",
      "Grandpa says songs were better in the old days. Is that true?",
    ],
    active: [
      "Did you find one yet? I'm still looking...",
      "Keep listening! It counts when your next song starts.",
      "I heard something with a trumpet in it. Is that jazz?",
      "Don't tell me what you found. Okay, tell me after.",
    ],
    done: [
      "You did it! Okay, you're better at this than me.",
      "Whoa. Teach me that one sometime.",
      "Here, you earned this. Fair's fair.",
    ],
    rest: [
      "That's all for today. Come back tomorrow, I'll have a new one!",
      "I'm going to go listen to what you found. Bye!",
      "Tomorrow I'll beat you. Probably.",
    ],
  },
};

const fmt = (n: number) => n.toLocaleString();

/** A reward's items in words: "10 Star Candy". */
function rewardItems(reward: QuestReward | null | undefined): string[] {
  const items = (reward?.items ?? []).map(
    (it) => `${fmt(it.quantity)} ${getItem(it.itemId)?.name ?? it.itemId}`,
  );
  const shards = reward?.shards ?? 0;
  if (shards > 0) {
    items.push(`${fmt(shards)} Crystal Shard${shards === 1 ? "" : "s"}`);
  }
  return items;
}

/**
 * A quest giver in Town: today's quest from them to accept, the one you're
 * on and how far along it is, or the finished one to turn in. `board` is
 * null while it loads.
 */
export function QuestGiverPanel({
  giver,
  board,
  onLog,
  paused,
}: {
  giver: QuestGiver;
  board: QuestBoard | null;
  onLog?: (msg: string) => void;
  paused: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = (board?.quests ?? []).filter((q) => q.giver === giver.key);
  // A finished one first: it has to go in before anything new.
  const held =
    mine.find((q) => q.status === "complete") ??
    mine.find((q) => q.status === "active") ??
    null;
  const offer = board?.offers[giver.key] ?? null;

  const state = held
    ? held.status === "complete"
      ? "done"
      : "active"
    : offer
      ? "offer"
      : "rest";
  const { line, typed, advance } = useChatter(giver.lines[state], !paused);
  const { stage: onStage } = useHerzieStage();

  const accept = async () => {
    setError(null);
    setBusy(true);
    try {
      const { quest, board: next } = await herzies.acceptQuest(giver.key);
      setQuestBoard(next);
      if (!next) refreshQuests();
      notify(`Accepted "${quest.title}"`, { kind: "success" });
      onLog?.(`Accepted "${quest.title}" from ${giver.name}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      refreshQuests();
    } finally {
      setBusy(false);
    }
  };

  const turnIn = async () => {
    if (!held) return;
    setError(null);
    setBusy(true);
    try {
      const { reward, board: next } = await herzies.claimQuest(held.id);
      setQuestBoard(next);
      if (!next) refreshQuests();
      notify(`Turned in "${held.title}"`, { kind: "success" });
      onLog?.(
        `Turned in "${held.title}" to ${giver.name}: ${[
          `${fmt(reward.coins)} coins`,
          ...rewardItems(reward),
        ].join(", ")}`,
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      refreshQuests();
    } finally {
      setBusy(false);
    }
  };

  const shown = held ?? offer;
  const reward = held ? held.reward : (offer?.reward ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-center text-[16px] font-bold text-green">
        {giver.name}
      </div>

      {/* Staged as the merchants are: square on, his line at his feet. */}
      <div className="relative flex h-[190px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <HerzieView
            onStage={onStage}
            userId={giver.seed}
            stage={giver.stage}
            zoom={0.8}
            size={5}
            cols={64}
            equipped={giver.equipped}
            animate={false}
            defaultAngle={-DEFAULT_Y_ANGLE}
            draggable={false}
            paused={paused}
            ariaLabel={giver.name}
          />
        </div>
        <button
          type="button"
          aria-label={`Talk to ${giver.name}`}
          onClick={advance}
          className="absolute inset-0 z-[2] cursor-pointer border-none bg-transparent p-0"
        />
        <SpeechBubble line={line} typed={typed} />
      </div>

      <div className="mt-2 flex min-h-0 flex-col gap-1.5">
        {!board ? (
          <div className="text-[10px] text-text-dim">...</div>
        ) : !shown ? (
          <div className="text-[10px] text-text-dim">
            No more quests today. Come back tomorrow.
          </div>
        ) : (
          <>
            <div className="text-[10px] uppercase tracking-wider text-text-dim">
              {state === "offer"
                ? "Today's quest"
                : state === "done"
                  ? "Quest complete"
                  : "Your quest"}
            </div>
            <div className="text-ui font-bold text-text">{shown.title}</div>
            <div className="text-ui-sm text-text-dim">{shown.description}</div>
            {held ? (
              <div className="flex items-center gap-2">
                <SegmentBar
                  className="flex-1"
                  progress={held.progress / held.target}
                  colour={held.status === "complete" ? "bg-yellow" : "bg-green"}
                />
                <span className="shrink-0 text-ui-sm text-text-dim">
                  {held.progress}/{held.target}
                </span>
              </div>
            ) : null}
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-white/15 pt-1.5 text-ui">
              <span className="text-text-dim">
                {reward ? (
                  <>
                    Reward: <Coin amount={reward.coins} />
                    {rewardItems(reward).map((label) => (
                      <span key={label}>, {label}</span>
                    ))}
                  </>
                ) : null}
              </span>
              {state === "offer" ? (
                <button
                  type="button"
                  className="btn text-green"
                  disabled={busy}
                  onClick={accept}
                >
                  {busy ? "Accepting..." : "Accept"}
                </button>
              ) : state === "done" ? (
                <button
                  type="button"
                  className="btn text-yellow"
                  disabled={busy}
                  onClick={turnIn}
                >
                  {busy ? "Turning in..." : "Turn in"}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="pt-1 text-center text-[10px] text-red">{error}</div>
      )}
    </div>
  );
}
