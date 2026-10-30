import {
  type ActiveMultiplier,
  type Equipped,
  type HerzieStats,
  type ItemUnit,
  isTownMapId,
  TOWER_GUARD_KEY,
} from "@herzies/shared";
import {
  Component,
  type ErrorInfo,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";
import type { AppState, ChatMessage } from "../tauri-bridge";
import { LoadingSplash } from "./LoadingSplash";
import { NowPlayingBox } from "./NowPlayingBox";
import {
  observePlayerCard,
  PLAYER_CARD,
  PLAYER_CARD_TOWN,
  PlayerBars,
} from "./PlayerBars";
import { type EventCard, formatIn, isDown } from "./TownScene";
import { TownVitals } from "./TownVitals";
import { BossHud, MusicBonus } from "./town/BossHud";
import { BossResults } from "./town/BossResults";
import { setCave } from "./town/cave";
import { useChatBubbles } from "./town/chatBubbles";
import { leaveCombat } from "./town/combat/Combat";
import { resetBossFight } from "./town/combat/fight";
import { onLootLog } from "./town/combat/lootFeed";
import { useBossResultsShown } from "./town/combat/results";
import { useCombat } from "./town/combat/state";
import { useFpsShown } from "./town/fps";
import { Hotbar } from "./town/Hotbar";
import { homeMode } from "./town/homeMode";
import { Key } from "./town/Key";
import type { TownMap } from "./town/map";
import { markMet } from "./town/met";
import { useTownNet, useTownNetVersion } from "./town/net/townNet";
import { spotsOf, type TownSpot, townLive, useTownMap } from "./town/runtime";
import { CastBar, SkillHud } from "./town/SkillHud";
import { useTuneSender } from "./town/tune";

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
  backdrop = false,
  hudHidden = paused,
  windowOpen = false,
  onOpen,
  onOpenProfile,
  player,
  chatOverlay = false,
  musicPlaying = false,
  onLog,
  stats,
  profile,
  units = [],
  home = false,
}: {
  /** At Home: the world's seen from in front of your herzie, faded away
   * round it (see town/homeMode); its labels go with it. */
  home?: boolean;
  /** The bank's copies: how many of each hotbar item are left. */
  units?: readonly ItemUnit[];
  /** The player's herzie's stats: how hard its waves hit. */
  stats?: HerzieStats;
  /** Name, level and progress to the next level, for the card top left. */
  profile?: {
    friendCode?: string;
    name: string;
    level: number;
    progress: number;
    /** Total XP, for the exp bar's tooltip. */
    xp?: number;
    /** Active XP modifiers, by the exp bar (null: logged out). */
    multipliers?: ActiveMultiplier[] | null;
    /** The class's name ("Bard"), after the level. */
    classLabel?: string;
    /** What's playing, under the card. */
    nowPlaying?: AppState["nowPlaying"];
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
  /** Paused behind a visitor's panel: still load and draw up to the first
   * frame (opened straight onto a visitor, there'd be nothing behind the
   * glass), then hold still. */
  backdrop?: boolean;
  /** The HUD (player card, hotbar, vitals, ...) is hidden. Defaults to
   * `paused`; the Town passes it apart so a world paused only because the
   * app lost focus keeps its HUD, as Home does. */
  hudHidden?: boolean;
  /** An overlay window (Herzie, Social, ...) is open over the Town. The
   * world keeps going, walking included; only the boss's end screen stops
   * taking every key, so typing reaches the window. */
  windowOpen?: boolean;
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
  // In the cave, music is a weapon: tell the room whether it's playing.
  useTuneSender(!!musicPlaying);
  // The cave's loot writes to the log like any other pickup.
  useEffect(() => onLootLog((message) => onLog?.(message)), [onLog]);
  const [near, setNear] = useState<TownSpot | null>(null);
  const endScreen = useBossResultsShown() !== null;
  const [bench, setBench] = useState<"sit" | "stand" | "read" | null>(null);
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
  const [opened, setOpened] = useState(!paused || backdrop);
  useEffect(() => {
    if (!paused || backdrop) setOpened(true);
  }, [paused, backdrop]);
  // One splash from opening until the world has drawn its first frame —
  // not one per thing that loads (the code, Rapier, the events), which
  // blinked as each handed over to the next.
  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => {
    setReady(true);
    // Home can now be shown in the world, rather than the app's stand-in.
    homeMode.setReady(true);
  }, []);
  // A backdrop runs until that first frame is up.
  const canvasPaused = paused && !(backdrop && !ready);

  // The visitors stand on islands with spots for them (home), not out on
  // the training grounds.
  const map = useTownMap();
  // Everyone else on the island you're on.
  useEffect(() => {
    if (isTownMapId(map.id)) net.setMap(map.id);
  }, [map.id, net]);
  // Out of the boss room (or the Tower), the fight is forgotten.
  useEffect(() => {
    if (map.id !== "bossroom" && map.id !== "tower") resetBossFight();
  }, [map.id]);
  // No Home on an island you fight on.
  useEffect(() => {
    homeMode.setCombatMap(!!map.combat);
  }, [map.combat]);
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
    // A map with visitors on it has a spot for one of them; the Tower
    // Guard's alone (the Tower's door, say) brings only him.
    const visitorMap = Object.keys(map.spots).some(
      (k) => k !== TOWER_GUARD_KEY,
    );
    let spare = 0;
    return (
      cards
        // The boss isn't in town: it's in its cave (see CaveTimer).
        .filter((c) => c.type !== "boss_fight")
        .filter((c) => c.type !== "treat_trader" || c.status !== "idle")
        // The Tower Guard stands only where a map gives him a spot (the
        // map editor): never on a spare one. Everyone else only on a
        // visitor map, and only with somewhere to stand.
        .filter((c) =>
          c.type === TOWER_GUARD_KEY
            ? !!SPOTS[c.type]
            : visitorMap && (!!SPOTS[c.type] || SPARE_SPOTS.length > 0),
        )
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
  // Ground accessories (the boombox) belong to the herzie's Home, not to a
  // herzie out walking: they're in its model, but only shown at Home (see
  // HerzieModel.setAccessories). Everyone else sees it as the town ticket
  // has it, without them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const look = useMemo(
    () => ({
      seed: player.seed,
      stage: player.stage,
      equipped: player.equipped ?? undefined,
    }),
    [player.seed, player.stage, equippedKey],
  );
  // A new outfit: a fresh ticket carries it to everyone else (after a beat,
  // so the server has the change saved).
  // Stats too (stat points, an upgrade): the server rolls casts from them.
  const statsKey = stats ? JSON.stringify(stats) : "";
  const lookKey = `${player.seed}|${player.stage}|${equippedKey}|${statsKey}`;
  const firstLook = useRef(lookKey);
  useEffect(() => {
    if (firstLook.current === lookKey) return;
    firstLook.current = lookKey;
    const t = setTimeout(() => net.refreshLook(), 1_500);
    return () => clearTimeout(t);
  }, [lookKey, net]);

  const talkTo = near?.card.openKey;
  // Where the E prompts (talk, portal, bench) sit: as far above the hotbar
  // as the hotbar is above the chat (6px; the slots are 36px tall), or just
  // over the chat without the HUD.
  const promptAt = hudHidden
    ? chatOverlay
      ? "bottom-[calc(var(--dock-height,0px)+6px)]"
      : "bottom-3"
    : chatOverlay
      ? profile
        ? "bottom-[calc(var(--dock-height,0px)+48px)]"
        : "bottom-[calc(var(--dock-height,0px)+4.5rem+42px)]"
      : "bottom-[54px]";
  // The key for aim mode (anywhere in the Town): sat right on top of the
  // bars (or in the corner, without them).
  const combatHint = !hudHidden ? (
    <div
      className={cn(
        // No box: the key chip, and the word over the world with a shadow.
        "pointer-events-none absolute z-30 flex items-center gap-2 text-[10px] text-white/80",
        profile
          ? "bottom-full left-0"
          : chatOverlay
            ? "bottom-[calc(var(--dock-height,0px)+4.5rem)] left-2"
            : "bottom-3 left-2",
      )}
    >
      <span>
        <Key>Tab</Key>{" "}
        <span className="[text-shadow:0_1px_2px_#000]">
          {fighting ? "roam" : "aim"}
        </span>
      </span>
    </div>
  ) : null;

  const hudFade = cn(
    "transition-opacity duration-300",
    endScreen && "pointer-events-none opacity-0",
  );

  return (
    <div
      className={cn(
        "town-world relative min-h-0 flex-1 overflow-hidden",
        // At Home the world's labels (names, chat over heads) fade with it;
        // only what's dropped around you keeps its name (globals.css).
        home && "town-home",
      )}
    >
      {net.status === "outdated" ? (
        <div
          className={cn(
            // Top right.
            "pointer-events-none absolute top-3 right-3 z-30 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white/70",
          )}
        >
          Update Herzies to see other players
        </div>
      ) : null}
      {/* The HUD fades away while the boss's end screen is up, and back. */}
      <div className={hudFade}>
        {profile && !hudHidden ? (
          <>
            {/* Top left, a frosted card: name and level, then health and
                experience — as on Home, so nothing shifts between the two.
                Under it, 8px down and as wide, what's playing. The big
                window hangs its windows under both (observePlayerCard). */}
            <div
              ref={observePlayerCard}
              className="absolute top-3 left-3 z-30 flex w-[174px] flex-col gap-2"
            >
              <div className={cn(PLAYER_CARD, PLAYER_CARD_TOWN)}>
                <div className="flex h-5 items-center">
                  <span className="block min-w-0 truncate text-ui-lg font-bold text-white">
                    {profile.name}
                  </span>
                </div>
                {/* The level (and class) on its own line, as on Home. */}
                <div className="my-0.5 text-[10px] leading-3 whitespace-nowrap text-white/70">
                  Lv. {profile.level}
                  {profile.classLabel && ` · ${profile.classLabel}`}
                </div>
                <PlayerBars
                  level={profile.level}
                  progress={profile.progress}
                  xp={profile.xp}
                  className="mt-1.5 text-white/70"
                />
              </div>
              <NowPlayingBox
                nowPlaying={profile.nowPlaying ?? null}
                multipliers={profile.multipliers ?? null}
                tint={cn(PLAYER_CARD_TOWN, "backdrop-blur-md")}
                showTags={false}
              />
              <MusicBonus />
            </div>
            <div
              className={cn(
                // A zero-height line 6px above the chat (as far as the chat
                // is from the nav), or 12px above the window's bottom, 12px
                // in from each side, as the chat is: the aim
                // hint, the hotbar and the skills stand on it, flush with
                // its ends and centred.
                "pointer-events-none absolute inset-x-3 z-30 h-0",
                chatOverlay
                  ? "bottom-[calc(var(--dock-height,0px)+6px)]"
                  : "bottom-3",
              )}
            >
              {combatHint}
              {!hudHidden ? <SkillHud className="bottom-full right-0" /> : null}
              {!hudHidden ? (
                <Hotbar
                  units={units}
                  className="bottom-full left-1/2 -translate-x-1/2"
                />
              ) : null}
              {/* A skill being played: over the hotbar's middle, a gap
                  above it (the hotbar is 36px tall). */}
              {!hudHidden ? (
                <CastBar className="bottom-full left-1/2 mb-12 -translate-x-1/2" />
              ) : null}
            </div>
          </>
        ) : null}
        {profile ? null : combatHint}
        {profile || hudHidden ? null : (
          <Hotbar
            units={units}
            className={cn(
              "left-1/2 -translate-x-1/2",
              chatOverlay
                ? "bottom-[calc(var(--dock-height,0px)+4.5rem)]"
                : "bottom-3",
            )}
          />
        )}
        {profile || hudHidden ? null : (
          <CastBar
            className={cn(
              "left-1/2 -translate-x-1/2",
              chatOverlay
                ? "bottom-[calc(var(--dock-height,0px)+7.5rem)]"
                : "bottom-[3.75rem]",
            )}
          />
        )}
        {profile || hudHidden ? null : (
          <SkillHud
            className={
              chatOverlay
                ? "bottom-[calc(var(--dock-height,0px)+4.5rem)] right-2"
                : "bottom-3 right-2"
            }
          />
        )}
      </div>
      {fpsShown && opened && !hudHidden ? (
        <FrameRate className="pointer-events-none absolute top-2 left-2 z-30 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white/70 tabular-nums" />
      ) : null}
      {opened && (
        <TownBoundary>
          <Suspense fallback={null}>
            <TownCanvas
              spots={spots}
              net={net}
              bubbles={bubbles}
              player={look}
              paused={canvasPaused}
              onOpen={onOpen}
              onOpenProfile={onOpenProfile}
              onNearChange={setNear}
              onBenchChange={setBench}
              onPortalChange={setPortalTo}
              onReady={onReady}
              stats={stats}
              homeDrops
            />
          </Suspense>
        </TownBoundary>
      )}
      {!hudHidden ? (
        <>
          <div className={hudFade}>
            <TownVitals inFight={!!map.combat} chatOverlay={chatOverlay} />
            <BossHud name={bossCard?.title ?? "The boss"} />
          </div>
          <BossResults interactive={!windowOpen} />
        </>
      ) : null}
      {!hudHidden && (loading || !ready) ? (
        <LoadingSplash overlay label="loading town" />
      ) : null}

      {/* At Home nothing's in reach: the world's faded away round you. */}
      {home ? null : talkTo && near ? (
        <button
          type="button"
          onClick={() => {
            leaveCombat();
            markMet(near.card);
            onOpen(talkTo);
          }}
          className={cn(
            "absolute left-1/2 z-30 -translate-x-1/2 cursor-pointer whitespace-nowrap rounded border-0 bg-black/35 px-2.5 py-1 text-ui text-white backdrop-blur-md hover:bg-black/50",
            promptAt,
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
            promptAt,
          )}
        >
          {portalTo.id === map.id
            ? "On to the next floor"
            : `${
                portalTo.id === "home"
                  ? "Back to "
                  : portalTo.room
                    ? "Enter "
                    : "Enter the "
              }${portalTo.name}`}{" "}
          <span className="text-text-dim">[E]</span>
        </button>
      ) : bench ? (
        <button
          type="button"
          onClick={() => {
            townLive.benchPressed = true;
          }}
          className={cn(
            "absolute left-1/2 z-30 -translate-x-1/2 cursor-pointer whitespace-nowrap rounded border-0 bg-black/35 px-2.5 py-1 text-ui text-white backdrop-blur-md hover:bg-black/50",
            promptAt,
          )}
        >
          {bench === "sit"
            ? "Sit down"
            : bench === "read"
              ? "Read the bulletin board"
              : "Stand up"}{" "}
          <span className="text-text-dim">[E]</span>
        </button>
      ) : null}
    </div>
  );
}

/**
 * The 3D world failing (no WebGL, Rapier's WASM not loading) takes only
 * itself down: Home keeps its own stand-in herzie (homeMode never turns
 * ready), and the Town says it couldn't load.
 */
class TownBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(
      "[town] the world failed to load",
      error,
      info.componentStack,
    );
    homeMode.setReady(false);
  }
  render() {
    if (this.state.failed)
      return (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-ui text-text-dim">
          The Town couldn't load on this machine.
        </div>
      );
    return this.props.children;
  }
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
