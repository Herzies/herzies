import { type Equipped, type HerzieStats, isTownMapId } from "@herzies/shared";
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
import { ExpBar } from "./SquareBar";
import { type EventCard, formatIn, isDown } from "./TownScene";
import { TownHpBar, TownVitals } from "./TownVitals";
import { BossHud } from "./town/BossHud";
import { setCave } from "./town/cave";
import { useChatBubbles } from "./town/chatBubbles";
import { resetBossFight } from "./town/combat/fight";
import { onLootLog } from "./town/combat/lootFeed";
import { useCombat } from "./town/combat/state";
import { useFpsShown } from "./town/fps";
import { Key } from "./town/Key";
import type { TownMap } from "./town/map";
import { NAME_SHADOW } from "./town/nameFade";
import { useTownNet, useTownNetVersion } from "./town/net/townNet";
import { spotsOf, type TownSpot, townLive, useTownMap } from "./town/runtime";
import { SkillHud } from "./town/SkillHud";

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
  onOpenProfile,
  player,
  chatOverlay = false,
  musicPlaying = false,
  onLog,
  stats,
  profile,
}: {
  /** The player's herzie's stats: how hard its waves hit. */
  stats?: HerzieStats;
  /** Name, level and progress to the next level, for the card top left. */
  profile?: {
    friendCode?: string;
    name: string;
    level: number;
    progress: number;
  };
  /** The chat, for lines over the speakers' heads. */
  chatMessages?: ChatMessage[];
  /** The Town's events are still loading: keep the splash up. */
  loading?: boolean;
  /** The chat floats over the bottom of the world: keep the prompt above
   * it. */
  chatOverlay?: boolean;
  cards: EventCard[];
  paused: boolean;
  onOpen: (openKey: string) => void;
  /** Another player's name was clicked: open their profile. */
  onOpenProfile?: (friendCode: string) => void;
  /** The player's own herzie. */
  player: { seed: string; stage: number; equipped?: Equipped | null };
  /** Music is playing: the herzie dances when it stands still. */
  musicPlaying?: boolean;
  /** A line for the activity log (loot picked up). */
  onLog?: (message: string) => void;
}) {
  useEffect(() => {
    townLive.music = musicPlaying;
  }, [musicPlaying]);
  // The cave's loot writes to the log like any other pickup.
  useEffect(() => onLootLog((message) => onLog?.(message)), [onLog]);
  const [near, setNear] = useState<TownSpot | null>(null);
  const [bench, setBench] = useState<"sit" | "stand" | null>(null);
  const [portalTo, setPortalTo] = useState<TownMap | null>(null);
  const fighting = useCombat();
  const fpsShown = useFpsShown();
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

  // The visitors stand on islands with spots for them (home), not out on
  // the training grounds.
  const map = useTownMap();
  // Everyone else on the island you're on.
  useEffect(() => {
    if (isTownMapId(map.id)) net.setMap(map.id);
  }, [map.id, net]);
  // Out of the boss room, the fight is forgotten.
  useEffect(() => {
    if (map.id !== "bossroom") resetBossFight();
  }, [map.id]);
  // The cave's door and sign follow the boss in the events.
  const bossCard = cards.find((c) => c.type === "boss_fight");
  const bossStatus = bossCard?.status;
  const bossAt = bossCard?.at;
  const bossDown = bossCard ? isDown(bossCard) : false;
  useEffect(() => {
    const at = bossAt ? new Date(bossAt).getTime() : Number.NaN;
    if (bossStatus === "live" && bossDown) setCave({ kind: "defeated" });
    else if (bossStatus === "live" && Number.isFinite(at))
      setCave({ kind: "open", endsAt: at });
    else if (bossStatus === "scheduled" && Number.isFinite(at))
      setCave({ kind: "soon", startsAt: at });
    else setCave({ kind: "sealed" });
  }, [bossStatus, bossAt, bossDown]);
  const spots = useMemo<TownSpot[]>(() => {
    if (Object.keys(map.spots).length === 0) return [];
    const { spots: SPOTS, spare: SPARE_SPOTS } = spotsOf(map);
    let spare = 0;
    return (
      cards
        // The boss isn't in town: it's in its cave (see CaveTimer).
        .filter((c) => c.type !== "boss_fight")
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
        })
    );
  }, [cards, map]);

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
  // Where combat's allowed, the keys for it: sat right on top of the XP
  // bar (or in the corner, without one).
  const combatHint =
    map.combat && !paused ? (
      <div
        className={cn(
          "pointer-events-none absolute z-30 flex items-center gap-2 rounded bg-black/55 px-2 py-1 text-[10px] text-white/80",
          profile
            ? "bottom-full left-2 mb-1.5"
            : chatOverlay
              ? "bottom-[calc(var(--dock-height,0px)+4.5rem)] left-2"
              : "bottom-3 left-2",
        )}
      >
        <span>
          <Key>Tab</Key> {fighting ? "roam" : "aim"}
        </span>
      </div>
    ) : null;

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {net.status === "outdated" ? (
        <div className="pointer-events-none absolute top-2 right-2 z-30 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white/70">
          Update Herzies to see other players
        </div>
      ) : null}
      {profile && !paused ? (
        <>
          {/* Centred in a 20px row, like home's (its icon buttons are h-5), so
              the name doesn't shift when switching tabs. */}
          <div className="pointer-events-none absolute top-3 left-3 z-30 flex h-5 max-w-[60%] items-center">
            <span
              className="whitespace-nowrap text-ui-lg font-bold text-white"
              style={{ textShadow: NAME_SHADOW }}
            >
              {profile.name}
              <span className="ml-2 text-[10px] font-normal text-white/70">
                Lv. {profile.level}
              </span>
            </span>
          </div>
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 z-30 px-3 py-2",
              chatOverlay ? "bottom-[var(--dock-height,0px)]" : "bottom-0",
            )}
          >
            {combatHint}
            {!paused ? (
              <SkillHud
                usable={!!map.combat}
                className="bottom-full right-2 mb-1.5"
              />
            ) : null}
            <TownHpBar inFight={!!map.combat} />
            <ExpBar progress={profile.progress} className="text-white/70" />
          </div>
        </>
      ) : null}
      {profile ? null : combatHint}
      {profile || paused ? null : (
        <SkillHud
          usable={!!map.combat}
          className={
            chatOverlay
              ? "bottom-[calc(var(--dock-height,0px)+4.5rem)] right-2"
              : "bottom-3 right-2"
          }
        />
      )}
      {fpsShown && opened && !paused ? (
        <FrameRate className="pointer-events-none absolute top-2 left-2 z-30 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white/70 tabular-nums" />
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
            onOpenProfile={onOpenProfile}
            onNearChange={setNear}
            onBenchChange={setBench}
            onPortalChange={setPortalTo}
            onReady={onReady}
            stats={stats}
          />
        </Suspense>
      )}
      {!paused ? (
        <>
          <TownVitals inFight={!!map.combat} chatOverlay={chatOverlay} />
          <BossHud name={bossCard?.title ?? "The boss"} />
        </>
      ) : null}
      {!paused && (loading || !ready) ? (
        <LoadingSplash overlay label="loading town" />
      ) : null}

      {talkTo && near ? (
        <button
          type="button"
          onClick={() => onOpen(talkTo)}
          className={cn(
            "absolute left-1/2 z-30 -translate-x-1/2 cursor-pointer whitespace-nowrap rounded border-0 bg-black/35 px-2.5 py-1 text-ui text-white backdrop-blur-md hover:bg-black/50",
            // Above the dock (chat + tab bar) floating over the world.
            chatOverlay
              ? "bottom-[calc(var(--dock-height,0px)+4.5rem)]"
              : "bottom-3",
          )}
        >
          Talk to {near.card.title} <span className="text-text-dim">[E]</span>
        </button>
      ) : portalTo ? (
        <button
          type="button"
          onClick={() => {
            // E's job, from the prompt (see Systems).
            townLive.benchPressed = true;
          }}
          className={cn(
            "absolute left-1/2 z-30 -translate-x-1/2 cursor-pointer whitespace-nowrap rounded border-0 bg-black/35 px-2.5 py-1 text-ui text-white backdrop-blur-md hover:bg-black/50",
            chatOverlay
              ? "bottom-[calc(var(--dock-height,0px)+4.5rem)]"
              : "bottom-3",
          )}
        >
          {portalTo.id === "home"
            ? "Back to "
            : portalTo.room
              ? "Enter "
              : "Enter the "}
          {portalTo.name} <span className="text-text-dim">[E]</span>
        </button>
      ) : bench ? (
        <button
          type="button"
          onClick={() => {
            townLive.benchPressed = true;
          }}
          className={cn(
            "absolute left-1/2 z-30 -translate-x-1/2 cursor-pointer whitespace-nowrap rounded border-0 bg-black/35 px-2.5 py-1 text-ui text-white backdrop-blur-md hover:bg-black/50",
            chatOverlay
              ? "bottom-[calc(var(--dock-height,0px)+4.5rem)]"
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

/** A key, as the hints show it. */
/** Frames drawn per second, counted over each half second: the Town's,
 * since it draws every frame the browser does. Shown from Settings → Debug. */
function FrameRate({ className }: { className?: string }) {
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    let frames = 0;
    let since = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      frames++;
      if (now - since >= 500) {
        setFps(Math.round((frames * 1000) / (now - since)));
        frames = 0;
        since = now;
      }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  return fps === null ? null : <div className={className}>{fps} fps</div>;
}
