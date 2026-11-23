import {
  blankState,
  CRYSTAL_KEY,
  type HerzieStats,
  TOWN_FLAG_SITTING,
  type TownState,
} from "@herzies/shared";
import {
  Canvas,
  createPortal,
  type RootState,
  useFrame,
  useThree,
} from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { Suspense, useMemo, useRef } from "react";
import type { Look } from "../TownScene";
import { berthOf } from "./airship/berth";
import {
  LAID_UP_GRACE_MS,
  laidUp,
  noShipHome,
  STRANDED_GRACE_MS,
  seeOffPlank,
  seeOffShip,
} from "./airship/boarding";
import { DeckColliders, DockColliders } from "./airship/Colliders";
import { useAboardNear, useShipFrame } from "./airship/frames";
import { SkyShips } from "./airship/SkyShips";
import { wildsServiceKnown } from "./airship/service";
import { shadowFocusFor } from "./airship/shadows";
import { ambient } from "./ambient";
import { crystalHasSomething, isAttuning, startAttune } from "./attune";
import { benchesOf, type Seat, seatNear } from "./Benches";
import { type Board, BULLETIN_KEY, boardNear, boardsOf } from "./Boards";
import { CameraRig } from "./CameraRig";
import { CaveTimer } from "./CaveTimer";
import { type CrystalSpot, crystalNear, crystalsOf } from "./Crystal";
import { tryEnterCave } from "./cave";
import type { ChatBubbles } from "./chatBubbles";
import { Boss } from "./combat/Boss";
import { Combat, leaveCombat } from "./combat/Combat";
import { CombatOverlay } from "./combat/DamageNumbers";
import { LootDrops } from "./combat/LootDrops";
import { Mobs } from "./combat/Mobs";
import { Telegraphs } from "./combat/Telegraphs";
import { getCrystal } from "./crystalState";
import type { Hour } from "./DayCycle";
import { driftClouds } from "./depth";
import { youDown } from "./downed";
import { DuelScene } from "./duel/DuelScene";
import { drawn } from "./fps";
import { isMouth, usePortalOpen } from "./gates";
import { HomeDrops } from "./HomeDrops";
import { HomeLayer } from "./HomeLayer";
import { useHomeMode } from "./homeMode";
import { type TownInput, useTownInput } from "./input";
import { groundY, type TownMap, worldRadius } from "./map";
import { markMet } from "./met";
import type { TownConnection } from "./net/TownConnection";
import { townNet } from "./net/townNet";
import { Player } from "./Player";
import { Post } from "./Post";
import { MapColliders } from "./Props";
import {
  arrivalOn,
  PORTAL_REACH,
  type Portal,
  portalsOf,
  startWarp,
  WARP_IN,
  WARP_OUT,
  walkedThrough,
  warp,
} from "./portal";
import { RemotePlayers } from "./RemotePlayers";
import type { Season } from "./Seasons";
import { sfxDoor, sfxPortal } from "./sfx";
import "./shadows";
import {
  homeDpr,
  SUPERSAMPLE,
  useTownPixelSize,
  useTownSupersample,
  wholePixelDpr,
} from "./pixelSize";
import {
  goToMap,
  mapById,
  TALK_RANGE,
  type TownRuntime,
  TownRuntimeContext,
  type TownSpot,
  townLive,
  townSave,
  useTownMap,
} from "./runtime";
import type { Champion } from "./Statues";
import { Supersample } from "./Supersample";
import { TowerChest } from "./TowerChest";
import { Visitor, VisitorBody } from "./Visitor";
import { DiscVFX } from "./vfx/DiscVFX";
import { DomeVFX } from "./vfx/DomeVFX";
import { HasteVFX } from "./vfx/HasteVFX";
import { HealVFX } from "./vfx/HealVFX";
import { SkillVFX } from "./vfx/SkillVFX";
import { SlamVFX } from "./vfx/SlamVFX";
import { SlashVFX } from "./vfx/SlashVFX";
import { SonicVFX } from "./vfx/SonicVFX";
import { StunVFX } from "./vfx/StunVFX";
import { mapId, World } from "./World";
import {
  CraftingStation,
  CraftingStationColliders,
} from "./wilds/CraftingStation";
import {
  CRAFTING_KEY,
  craftingNear,
  craftingStationsOf,
} from "./wilds/craftingSpot";
import { HuntCrystalColliders, HuntCrystals } from "./wilds/HuntCrystal";
import {
  HUNT_CRYSTAL_KEY,
  huntCrystalNear,
  huntCrystalsOf,
} from "./wilds/huntCrystalSpot";
import {
  asked,
  cardInReach,
  cardName,
  type GroundCard,
  mayAsk,
} from "./wilds/loot";
import { SafeCamp } from "./wilds/SafeCamp";
import { myWildsDown } from "./wilds/store";
import { WildsLoot } from "./wilds/WildsLoot";

export { PIXEL_SCALE } from "./pixelSize";

export type TownCanvasProps = {
  spots: TownSpot[];
  player: Look;
  /** Your herzie's name and worn title (a titles.ts id), over its head. */
  playerName?: string;
  playerTitle?: string | null;
  paused: boolean;
  onOpen: (openKey: string) => void;
  /** Another player's name was clicked: open their profile (by friend
   * code). */
  onOpenProfile?: (friendCode: string) => void;
  /** Who's close enough to talk to (null: nobody), when that changes. */
  onNearChange: (spot: TownSpot | null) => void;
  /** What E would do at a bench or board right now — sit on one nearby,
   * stand up off it, read the bulletin board, the Crystal, the Crafting
   * Station or the Hunt Crystal on the Wilds — when that changes (null:
   * nothing). */
  onBenchChange?: (prompt: BenchPrompt | null) => void;
  /** The island a portal nearby leads to (E steps in), when that changes
   * (null: none near). */
  onPortalChange?: (to: TownMap | null) => void;
  /** The island to draw (the map editor's preview passes its own). */
  map?: TownMap;
  /** The other islands in the sky (default: every map there is). */
  others?: TownMap[];
  /** Bump to put the player back at the map's spawn. */
  respawn?: number;
  /** Who the statues show: the last boss fight's champion (a stand-in
   * until there's one). */
  champion?: Champion;
  /** Show the world at this hour (default: the local clock). */
  hour?: Hour;
  /** Show the world at this time of year (default: the calendar). */
  season?: Season;
  /** Drawn at this fraction of the screen's resolution (default:
   * PIXEL_SCALE; the map editor tries others). */
  pixelScale?: number;
  /** Cast shadows from the sun (default: on; off to measure the cost). */
  shadows?: boolean;
  /** Ambient occlusion (default: on; off to measure the cost). */
  ao?: boolean;
  /** Chat lines over herzies' heads, by friend code. */
  bubbles?: ChatBubbles;
  /** The multiplayer Town: draws everyone else on it. */
  net?: TownConnection | null;
  /** Called once the world has drawn its first frame. */
  onReady?: () => void;
  /** The player's herzie's stats: how hard its waves hit. */
  stats?: HerzieStats;
  /** Called once the renderer is up (the sandbox's benchmark uses it). */
  onCreated?: (state: RootState) => void;
  /** Show what drops while you listen on the ground around you (the app's
   * own Town; not the map editor's). */
  homeDrops?: boolean;
};

/** What E would do where you stand, besides talking or a portal. On the
 * Wilds, `pickup`: take the card lying in reach (its drop id, and its name
 * to show). */
export type BenchPrompt =
  | "sit"
  | "stand"
  | "read"
  | "attune"
  | "upgrade"
  | "crafting"
  | "hunt"
  | { pickup: string; name: string };

/**
 * The 3D Town: react-three-fiber for the scene and its lifecycle, Rapier
 * for collisions and a fixed-step simulation, camera-controls for the
 * orbit camera. Loaded lazily (see TownWorld), so the rest of the app
 * never pays for it.
 */
export default function TownCanvas(props: TownCanvasProps) {
  const input = useRef<TownInput>(null) as React.RefObject<TownInput>;
  const runtime = useMemo<TownRuntime>(
    () => ({
      input,
      playerBody: null,
      playerSpeed: 0,
      playerFootSpread: 0,
      playerHerzie: null,
      playerRigidBody: null,
      cameraAzimuth: 0,
    }),
    [],
  );
  const current = useTownMap();
  const map = props.map ?? current;
  // Aboard a sky ship: physics is its deck's (in its own frame), and the
  // world is drawn round whichever island it's nearest.
  const aboard = map.ship ? townSave.ship : null;
  const near = useAboardNear();
  const view = aboard !== null ? mapById(near) : map;
  const deckFrame = useShipFrame(aboard);
  // Shadows over the island and the berth beside it, or over the ship
  // you're on as it flies.
  const shadows = useMemo(
    () =>
      aboard !== null || berthOf(view)
        ? shadowFocusFor(view, aboard)
        : undefined,
    [view, aboard],
  );
  // A debug override of PIXEL_SCALE (Settings, dev builds).
  const pixelSize = useTownPixelSize();
  // Visitors stand on islands with spots for them: the island drawn, so
  // from a sky ship they're already there as you come in.
  const spots = Object.keys(view.spots).length > 0 ? props.spots : [];
  // At Home nothing's aimed or cast (and aim mode ends on the way in).
  const { home } = useHomeMode();
  // Supersampled (Settings > Graphics): drawn at twice the resolution and
  // averaged back down to the same big pixels (see Supersample), at Home
  // too.
  const supersample = useTownSupersample();

  return (
    <Canvas
      // Chunky pixels, to sit with the ASCII herzies: drawn at a fraction of
      // the screen's resolution and scaled up without smoothing.
      // Chunkier still at Home, where the herzie's drawn close up.
      dpr={(() => {
        const dpr =
          props.pixelScale ??
          (pixelSize ? window.devicePixelRatio / pixelSize : wholePixelDpr());
        return (home ? homeDpr(dpr) : dpr) * (supersample ? SUPERSAMPLE : 1);
      })()}
      gl={{ antialias: false }}
      // Plain PCF: soft enough, and at these pixels the edge reads clean.
      shadows={props.shadows === false ? false : "percentage"}
      // Its own stacking context: the name tags (drei's Html, inside this
      // wrapper) stay under whatever comes after it, the boss's end screen
      // included, and the herzie stage (fixed, z-index 1) draws over them.
      style={{ imageRendering: "pixelated", isolation: "isolate" }}
      camera={{ fov: 55, near: 0.1, far: 400 }}
      frameloop={props.paused ? "never" : "always"}
      onCreated={props.onCreated}
    >
      <TownRuntimeContext.Provider value={runtime}>
        <ClockGap />
        <Systems
          {...props}
          map={map}
          // Aboard, where you stand is the deck's: nobody to talk to.
          spots={aboard === null ? spots : []}
          input={input}
          followsSave={!props.map}
        />
        {/* Rapier's WASM loads here: wait inside the canvas instead of
            suspending the whole Town again (the splash would blink). */}
        <Suspense fallback={null}>
          {/* What's seen: outside the physics, so stepping onto a ship (a
              new physics world) doesn't build the island again. */}
          <World
            map={view}
            others={props.others}
            champion={props.champion}
            hour={props.hour}
            season={props.season}
            shadows={shadows}
          />
          {!view.room && <SkyShips origin={view.origin} />}
          {/* What stands on the island, drawn with it: seen from a sky ship
              as you come in, and the same things (not made again) once you
              step ashore. What's solid of them is in the physics below. */}
          {spots.map((s) => (
            <Visitor
              key={s.key}
              spot={s}
              ground={groundY(view, s.at.x, s.at.z)}
              map={view}
              onOpen={props.onOpen}
              bare={aboard !== null}
            />
          ))}
          {view.id === "wilds" && <SafeCamp map={view} />}
          {/* Crafting Stations and Hunt Crystals, wherever they're
              painted. */}
          <CraftingStation map={view} />
          <HuntCrystals map={view} />
          <Physics
            // A new island (or a ship's deck): a new physics world, with
            // only its colliders.
            key={map.id}
            timeStep={1 / 60}
            interpolate
            gravity={[0, 0, 0]}
            paused={props.paused}
            updatePriority={-3}
          >
            {props.onReady && <FirstFrame onReady={props.onReady} />}
            {map.ship ? (
              <DeckColliders />
            ) : (
              <>
                <MapColliders key={mapId(map)} map={map} />
                <DockColliders map={map} />
              </>
            )}
            <Player
              map={map}
              look={props.player}
              spawn={map.spawn}
              reach={worldRadius(map)}
              respawn={props.respawn}
              bubble={props.bubbles?.get(props.player.seed)}
              name={props.playerName}
              title={props.playerTitle}
              deck={aboard}
            />
            {aboard === null &&
              spots.map((s) => (
                <VisitorBody
                  key={s.key}
                  spot={s}
                  ground={groundY(map, s.at.x, s.at.z)}
                />
              ))}
            <Combat
              map={map}
              stats={props.stats ?? NO_STATS}
              active={!props.paused && !home && aboard === null}
            />
            {map.id === "bossroom" && (
              <>
                <Boss />
                {/* Its minions, once it calls them. */}
                <Mobs />
                <Telegraphs />
              </>
            )}
            {map.id === "tower" && (
              <>
                <Mobs />
                <Telegraphs />
                {/* A cleared Warden's floor's chest. */}
                <TowerChest map={map} />
              </>
            )}
            {/* The bossroom's loot; anywhere, for the dev drop (and a
                Wilds cache's). */}
            <LootDrops />
            {/* The Wilds' dropped cards and caches. */}
            {map.id === "wilds" && <WildsLoot map={map} />}
            {!map.ship && (
              <>
                <CraftingStationColliders map={map} />
                <HuntCrystalColliders map={map} />
              </>
            )}
            {/* What drops while you listen, around you (see HomeDrops). */}
            {props.homeDrops && !map.combat && !map.ship && (
              <HomeDrops map={map} />
            )}
            {portalsOf(map).some(isMouth) && <CaveTimer map={map} />}
          </Physics>
        </Suspense>
        {props.net &&
          (() => {
            const others = (
              <>
                <RemotePlayers
                  map={map}
                  net={props.net}
                  bubbles={props.bubbles}
                  onOpenProfile={props.onOpenProfile}
                  frame={deckFrame}
                />
                {/* Duels' rings, and what a duel's end leaves over heads. */}
                <DuelScene map={map} />
              </>
            );
            // Aboard, everyone else is on the deck with you.
            return deckFrame ? createPortal(others, deckFrame) : others;
          })()}
        <CameraRig map={view} />
        {/* Aim mode works on every island, so its effects are always here. */}
        <SonicVFX />
        <DiscVFX />
        <SkillVFX />
        <DomeVFX map={map} />
        <StunVFX />
        <SlamVFX map={map} />
        <HasteVFX />
        <HealVFX />
        <SlashVFX />
        <CombatOverlay />
        {/* Sound waves bend light, and aim mode works on every island. */}
        <Post ao={props.ao !== false} distort />
        {/* Home's things, over the world fading on the way Home. */}
        <HomeLayer />
        {supersample && <Supersample />}
      </TownRuntimeContext.Provider>
    </Canvas>
  );
}

const NO_STATS: HerzieStats = {
  sonicPower: 0,
  stamina: 0,
  euphony: 0,
  timing: 0,
  def: 0,
  luck: 0,
  critChance: 0,
  critDamage: 0,
  moveSpeed: 0,
};

/** The Town's clock doesn't run while it's paused (window closed to the
 * menu bar): the first frame back would carry the whole gap in `elapsedTime`
 * and everything swaying on it (trees, bunting, clouds) would jump to a new
 * phase. Takes the gap back out, ahead of every other frame callback. */
function ClockGap() {
  useFrame((state, delta) => {
    drawn.frames++;
    if (delta > 0.5) state.clock.elapsedTime -= delta;
  }, -1000);
  return null;
}

/** Per-frame housekeeping: input, and who the player is close enough to
 * talk to. */
function Systems({
  spots,
  paused,
  onOpen,
  onNearChange,
  onBenchChange,
  onPortalChange,
  map,
  net,
  input,
  followsSave,
}: TownCanvasProps & {
  input: React.RefObject<TownInput>;
  /** The island drawn is the save's (not the map editor's preview). */
  followsSave: boolean;
}) {
  const surface = useThree((s) => s.gl.domElement);
  const near = useRef<TownSpot | null>(null);
  const spotsRef = useRef(spots);
  spotsRef.current = spots;
  const benches = useMemo(() => (map ? benchesOf(map) : []), [map]);
  /** The seat E would sit on, if any. */
  const seat = useRef<Seat | null>(null);
  const prompt = useRef<BenchPrompt | null>(null);
  const boards = useMemo(() => (map ? boardsOf(map) : []), [map]);
  /** The bulletin board E would read, if any. */
  const board = useRef<Board | null>(null);
  const crystals = useMemo(() => (map ? crystalsOf(map) : []), [map]);
  /** The Crystal E would attune to, if any. */
  const crystal = useRef<CrystalSpot | null>(null);
  const stations = useMemo(() => (map ? craftingStationsOf(map) : []), [map]);
  /** At a Crafting Station. */
  const crafting = useRef(false);
  const huntCrystals = useMemo(() => (map ? huntCrystalsOf(map) : []), [map]);
  /** By a Hunt Crystal (to talk to it). */
  const hunt = useRef(false);
  /** The card on the Wilds E would pick up, if any. */
  const pickup = useRef<GroundCard | null>(null);
  // A shut portal (a sealed cave, the Tower out of season, a floor not
  // yet cleared): nothing to see, step into or be prompted by.
  const isOpen = usePortalOpen();
  const all = useMemo(() => (map ? portalsOf(map) : []), [map]);
  const portals = all.filter(isOpen);
  /** The portal E would step into, if any. */
  const portal = useRef<Portal | null>(null);
  /** Where the player was last frame, on which island: walking through a
   * disc is going from one side of it to the other. */
  const last = useRef({ map: "", x: 0, z: 0 });
  /** The other players sitting down, sampled near a bench: the first `n`
   * of `at` (kept and refilled, not made, each frame). A seat's taken if
   * one of them is on it. */
  const sitting = useMemo(() => {
    const at: TownState[] = [];
    const state = {
      at,
      n: 0,
      taken: (s: Seat) => {
        for (let i = 0; i < state.n; i++) {
          if (Math.hypot(at[i].x - s.x, at[i].z - s.z) < 0.4) return true;
        }
        return false;
      },
    };
    return state;
  }, []);
  /** Since when the ship you're on has been laid up (you're seen off it
   * after a moment), and since when you've been on the Wilds with no ship
   * to take you home (you're sent home after a moment). */
  const laidUpSince = useRef<number | null>(null);
  const strandedSince = useRef<number | null>(null);

  /** E (or a click on the prompt): talk to whoever's near; else step into
   * the portal nearby; else stand up; else pick up the card in reach (the
   * Wilds); else read the board nearby; else sit on the bench nearby.
   * Knocked out, talking's all it can do: it lies where it fell. */
  const interact = () => {
    const card = near.current?.card;
    if (card?.openKey) {
      // Talking's done roaming, not aiming: the mouse let go for the card.
      leaveCombat();
      markMet(card);
      onOpen(card.openKey);
    } else if (youDown()) return;
    else if (portal.current) enter(portal.current);
    else if (townLive.seat) townLive.standUp = true;
    else if (pickup.current) {
      // The room judges it (a `wildsTaken`, or a refusal that says why).
      const { id } = pickup.current;
      const now = performance.now();
      if (mayAsk(id, now) && townNet().sendWildsTake(id)) asked(id, now);
    } else if (crystal.current) {
      // Something in it: attune (a cast). Nothing: its upgrade window.
      if (crystalHasSomething()) startAttune();
      else if (!isAttuning()) onOpen(CRYSTAL_KEY);
    } else if (board.current) onOpen(BULLETIN_KEY);
    else if (crafting.current) {
      leaveCombat();
      onOpen(CRAFTING_KEY);
    } else if (hunt.current) {
      leaveCombat();
      onOpen(HUNT_CRYSTAL_KEY);
    } else if (seat.current) townLive.seat = seat.current;
  };
  const enter = (p: Portal) => {
    if (warp.active) return;
    const to = p.to;
    // Into a room (the boss's cave): only while it's open, and says why not.
    if (isMouth(p) && !tryEnterCave()) return;
    townLive.seat = null;
    // The Tower's way on: the same island, its next floor.
    if (p.next) {
      startWarp(to, true);
      townNet().sendNext();
    } else startWarp(to, false, !!p.door);
    if (p.door) sfxDoor();
    else sfxPortal();
  };
  const live = useTownInput(!paused, surface, interact);
  input.current = live.current;

  useFrame(({ clock }, dt) => {
    // Through a portal: out, swap islands at the white-out, back in.
    if (warp.active) {
      warp.t += Math.min(dt, 0.05);
      if (!warp.swapped && warp.t >= WARP_OUT) {
        warp.swapped = true;
        const from = townSave.map;
        const dest = mapById(warp.to);
        // On to the next floor: back at the island's start, same island.
        if (warp.sameIsland)
          townLive.teleport = {
            x: dest.spawn.at[0],
            z: dest.spawn.at[1],
            heading: dest.spawn.heading,
          };
        else goToMap(warp.to, arrivalOn(dest, from));
      }
      if (warp.t >= WARP_OUT + WARP_IN) warp.active = false;
    }
    townLive.frozen = warp.active;
    // Between a map change and the world catching up (a frame or two),
    // the save is already the next island's: nothing here is about it.
    if (followsSave && map && townSave.map !== map.id) return;
    if (map) {
      const l = last.current;
      if (l.map === map.id && !warp.active) {
        for (const p of portals) {
          if (walkedThrough(p, l.x, l.z, townSave.x, townSave.z)) {
            enter(p);
            break;
          }
        }
      }
      l.map = map.id;
      l.x = townSave.x;
      l.z = townSave.z;
    }
    // The portal close enough to step into with E.
    let nearest: Portal | null = null;
    let reach = PORTAL_REACH;
    for (const p of portals) {
      const d = Math.hypot(townSave.x - p.x, townSave.z - p.z);
      if (d < reach) {
        reach = d;
        nearest = p;
      }
    }
    if (warp.active) nearest = null;
    if (nearest?.key !== portal.current?.key) {
      portal.current = nearest;
      onPortalChange?.(nearest ? mapById(nearest.to) : null);
    }

    // A sky ship's gangway is walked through freely (see Player); a laid-up
    // ship sees its last passengers off after a moment, and a gangplank
    // being drawn in whoever's on it.
    if (map && !warp.active) {
      if (map.ship) {
        const ship = townSave.ship;
        if (laidUp(ship) && !townLive.glide) {
          laidUpSince.current ??= performance.now();
          if (performance.now() - laidUpSince.current > LAID_UP_GRACE_MS) {
            laidUpSince.current = null;
            seeOffShip(ship);
          }
        } else laidUpSince.current = null;
      } else seeOffPlank(map, worldRadius(map));
    }
    // The Wilds' only way off is by ship: with none to come (the service is
    // over, or there's none), back to Town.
    const stranded =
      followsSave &&
      map?.id === "wilds" &&
      !warp.active &&
      wildsServiceKnown() &&
      noShipHome();
    if (stranded) {
      strandedSince.current ??= performance.now();
      if (performance.now() - strandedSince.current > STRANDED_GRACE_MS) {
        strandedSince.current = null;
        townLive.seat = null;
        startWarp("home", false, true);
      }
    } else strandedSince.current = null;

    // The shared uniforms the wind, water and sky read (see ambient.ts).
    ambient.uTime.value = clock.elapsedTime;
    // Aboard, nobody's walking through the grass down there.
    if (map?.ship) ambient.uPlayer.value.set(1e5, 0, 1e5);
    else ambient.uPlayer.value.set(townSave.x, 0, townSave.z);
    driftClouds(clock.elapsedTime, ambient.uWindDir.value);

    let closest: TownSpot | null = null;
    let best = TALK_RANGE;
    for (const s of spotsRef.current) {
      // A live visitor who's down (a beaten boss) has no name tag to click,
      // so stepping up to their ring still opens them.
      if (s.card.status !== "live" || !s.card.openKey) continue;
      const d = Math.hypot(townSave.x - s.at.x, townSave.z - s.at.z);
      if (d < best) {
        best = d;
        closest = s;
      }
    }
    if (closest?.key !== near.current?.key) {
      near.current = closest;
      onNearChange(closest);
    }

    // A card on the Wilds in reach that you may take: never taken without
    // asking (see wilds/loot.ts), so walking past leaves it lying.
    pickup.current =
      map?.id === "wilds" && !closest && !portal.current && !townLive.seat
        ? cardInReach(townSave, performance.now(), myWildsDown())
        : null;

    // Benches: the free seat nearest, if no one's there to talk to. A seat
    // is taken if another player is sitting on it.
    seat.current = null;
    // Only while the server has the Crystal on (it isn't drawn otherwise).
    crystal.current =
      !closest && !portal.current && !townLive.seat && getCrystal()?.enabled
        ? crystalNear(crystals, townSave.x, townSave.z)
        : null;
    board.current =
      !closest && !portal.current && !townLive.seat && !crystal.current
        ? boardNear(boards, townSave.x, townSave.z)
        : null;
    crafting.current =
      !closest &&
      !portal.current &&
      !townLive.seat &&
      !crystal.current &&
      !board.current &&
      craftingNear(stations, townSave.x, townSave.z);
    hunt.current =
      !closest &&
      !portal.current &&
      !townLive.seat &&
      !crystal.current &&
      !board.current &&
      !crafting.current &&
      huntCrystalNear(huntCrystals, townSave.x, townSave.z);
    if (
      !closest &&
      !portal.current &&
      !townLive.seat &&
      !crystal.current &&
      !board.current &&
      !crafting.current &&
      !hunt.current &&
      benches.length > 0
    ) {
      sitting.n = 0;
      if (net) {
        const t = net.clock.renderTime(performance.now());
        for (const r of net.remotes.values()) {
          sitting.at[sitting.n] ??= blankState();
          const st = r.buffer.sample(t, sitting.at[sitting.n]);
          if (st && st.flags & TOWN_FLAG_SITTING) sitting.n++;
        }
      }
      seat.current = seatNear(benches, townSave.x, townSave.z, sitting.taken);
    }
    if (townLive.benchPressed) {
      townLive.benchPressed = false;
      if (!closest) interact();
    }
    const lying = pickup.current;
    // Knocked out: no "E to…" (see interact).
    const next = youDown()
      ? null
      : townLive.seat
        ? "stand"
        : lying
          ? "pickup"
          : crystal.current
            ? isAttuning()
              ? null
              : crystalHasSomething()
                ? "attune"
                : "upgrade"
            : board.current
              ? "read"
              : crafting.current
                ? "crafting"
                : hunt.current
                  ? "hunt"
                  : seat.current
                    ? "sit"
                    : null;
    const was = prompt.current;
    const same =
      next === "pickup"
        ? typeof was === "object" && was?.pickup === lying?.id
        : next === was;
    if (!same) {
      const shown: BenchPrompt | null =
        next === "pickup" && lying
          ? { pickup: lying.id, name: cardName(lying.item, lying.level) }
          : next === "pickup"
            ? null
            : next;
      prompt.current = shown;
      onBenchChange?.(shown);
    }
  }, -4);

  return null;
}

/** Calls back once the world has drawn a frame. */
function FirstFrame({ onReady }: { onReady: () => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    // After this frame reaches the screen, not before it's drawn.
    requestAnimationFrame(() => onReady());
  });
  return null;
}
