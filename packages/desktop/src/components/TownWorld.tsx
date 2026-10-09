import type { Equipped } from "@herzies/shared";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";
import type { ChatMessage } from "../tauri-bridge";
import { LoadingSplash } from "./LoadingSplash";
import { type EventCard, formatIn, isDown } from "./TownScene";
import { useChatBubbles } from "./town/chatBubbles";
import { useTownNet, useTownNetVersion } from "./town/net/townNet";
import { SPARE_SPOTS, SPOTS, type TownSpot, townLive } from "./town/runtime";

// three.js, Rapier's WASM and friends: loaded the first time someone opens
// the Town, not at app start.
const TownCanvas = lazy(() => import("./town/TownCanvas"));

const spotKey = (card: EventCard) =>
  `${card.type}-${card.eventId ?? card.status}`;

/**
 * The Town as a place you walk around in third person: your own herzie on
 * a plaza, with each visitor standing at their spot. Walk up to someone in
 * town and press E (or click their name) to open their screen.
 */
export function TownWorld({
  loading = false,
  chatMessages,
  cards,
  paused,
  onOpen,
  player,
  notice,
  chatOverlay = false,
}: {
  /** The chat, for lines over the speakers' heads. */
  chatMessages?: ChatMessage[];
  /** The Town's events are still loading: keep the splash up. */
  loading?: boolean;
  /** The chat floats over the bottom of the world: keep the prompt above
   * it. */
  chatOverlay?: boolean;
  /** A line shown over the top of the world (e.g. "Town is quiet"). */
  notice?: React.ReactNode;
  cards: EventCard[];
  paused: boolean;
  onOpen: (openKey: string) => void;
  /** The player's own herzie. */
  player: { seed: string; stage: number; equipped?: Equipped | null };
}) {
  const [near, setNear] = useState<TownSpot | null>(null);
  const [bench, setBench] = useState<"sit" | "stand" | null>(null);
  // Everyone else with the Town open, on the same island.
  const net = useTownNet(!paused);
  useTownNetVersion(net);
  const bubbles = useChatBubbles(chatMessages, !paused);
  // The Town tab is mounted (hidden) for the app's whole life, so wait for
  // it to be opened before loading the 3D world and starting a WebGL
  // context — then keep them.
  const [opened, setOpened] = useState(!paused);
  useEffect(() => {
    if (!paused) setOpened(true);
  }, [paused]);
  // One splash from opening until the world has drawn its first frame —
  // not one per thing that loads (the code, Rapier, the events), which
  // blinked as each handed over to the next.
  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => setReady(true), []);

  const spots = useMemo<TownSpot[]>(() => {
    let spare = 0;
    return cards
      .filter((c) => c.type !== "treat_trader" || c.status !== "idle")
      .map((card) => {
        const live = card.status === "live";
        return {
          key: spotKey(card),
          card,
          at: SPOTS[card.type] ?? SPARE_SPOTS[spare++ % SPARE_SPOTS.length],
          standing: live && !isDown(card),
          status: live
            ? card.type === "boss_fight" && card.detail
              ? card.detail
              : card.at
                ? `${formatIn(card.at)} left`
                : "in town"
            : card.at
              ? `in ${formatIn(card.at)}`
              : "away",
        };
      });
  }, [cards]);

  const equippedKey = JSON.stringify(player.equipped ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const look = useMemo(
    () => ({
      seed: player.seed,
      stage: player.stage,
      // Ground accessories (the boombox) belong to the herzie's home, not
      // to a herzie out walking.
      equipped: player.equipped
        ? {
            ...player.equipped,
            ground_left: undefined,
            ground_right: undefined,
          }
        : undefined,
    }),
    [player.seed, player.stage, equippedKey],
  );
  // A new outfit: a fresh ticket carries it to everyone else (after a beat,
  // so the server has the change saved).
  const lookKey = `${player.seed}|${player.stage}|${equippedKey}`;
  const firstLook = useRef(lookKey);
  useEffect(() => {
    if (firstLook.current === lookKey) return;
    firstLook.current = lookKey;
    const t = setTimeout(() => net.refreshLook(), 1_500);
    return () => clearTimeout(t);
  }, [lookKey, net]);

  const talkTo = near?.card.openKey;
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {notice ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 bg-black/50 px-3 py-1.5 text-center text-ui text-white/70">
          {notice}
        </div>
      ) : null}
      {net.status === "outdated" ? (
        <div
          className={cn(
            "pointer-events-none absolute right-2 z-30 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white/70",
            notice ? "top-9" : "top-2",
          )}
        >
          Update Herzies to see other players
        </div>
      ) : null}
      {opened && (
        <Suspense fallback={null}>
          <TownCanvas
            spots={spots}
            net={net}
            bubbles={bubbles}
            player={look}
            paused={paused}
            onOpen={onOpen}
            onNearChange={setNear}
            onBenchChange={setBench}
            onReady={onReady}
          />
        </Suspense>
      )}
      {!paused && (loading || !ready) ? (
        <LoadingSplash overlay label="loading town" />
      ) : null}

      {talkTo && near ? (
        <button
          type="button"
          onClick={() => onOpen(talkTo)}
          className={cn(
            "absolute left-1/2 z-30 -translate-x-1/2 cursor-pointer whitespace-nowrap rounded border border-white/40 bg-black/70 px-2 py-1 text-ui text-white hover:bg-black/85",
            // Above the dock (chat + tab bar) floating over the world.
            chatOverlay
              ? "bottom-[calc(var(--dock-height,0px)+12px)]"
              : "bottom-3",
          )}
        >
          Talk to {near.card.title} <span className="text-text-dim">[E]</span>
        </button>
      ) : bench ? (
        <button
          type="button"
          onClick={() => {
            townLive.benchPressed = true;
          }}
          className={cn(
            "absolute left-1/2 z-30 -translate-x-1/2 cursor-pointer whitespace-nowrap rounded border border-white/40 bg-black/70 px-2 py-1 text-ui text-white hover:bg-black/85",
            chatOverlay
              ? "bottom-[calc(var(--dock-height,0px)+12px)]"
              : "bottom-3",
          )}
        >
          {bench === "sit" ? "Sit down" : "Stand up"}{" "}
          <span className="text-text-dim">[E]</span>
        </button>
      ) : null}
    </div>
  );
}
