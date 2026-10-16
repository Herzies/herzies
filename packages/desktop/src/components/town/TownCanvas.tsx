import { type HerzieStats, TOWN_FLAG_SITTING } from "@herzies/shared";
import { Canvas, type RootState, useFrame, useThree } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { Suspense, useMemo, useRef } from "react";
import type { Look } from "../TownScene";
import { ambient } from "./ambient";
import { benchesOf, type Seat, seatNear } from "./Benches";
import { CameraRig } from "./CameraRig";
import { CaveTimer } from "./CaveTimer";
import { tryEnterCave, useCave } from "./cave";
import type { ChatBubbles } from "./chatBubbles";
import { Boss } from "./combat/Boss";
import { Combat } from "./combat/Combat";
import { CombatOverlay } from "./combat/DamageNumbers";
import { LootDrops } from "./combat/LootDrops";
import { Telegraphs } from "./combat/Telegraphs";
import type { Hour } from "./DayCycle";
import { driftClouds } from "./depth";
import { type TownInput, useTownInput } from "./input";
import { portalCells, type TownMap, worldRadius } from "./map";
import type { TownConnection } from "./net/TownConnection";
import { Player } from "./Player";
import { isMouth } from "./Portals";
import { Post } from "./Post";
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
import { sfxPortal } from "./sfx";
import "./shadows";
import { PIXEL_SCALE, useTownPixelSize } from "./pixelSize";
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
import { Visitor } from "./Visitor";
import { DiscVFX } from "./vfx/DiscVFX";
import { SkillVFX } from "./vfx/SkillVFX";
import { SlashVFX } from "./vfx/SlashVFX";
import { SonicVFX } from "./vfx/SonicVFX";
import { World } from "./World";

export { PIXEL_SCALE } from "./pixelSize";

export type TownCanvasProps = {
  spots: TownSpot[];
  player: Look;
  paused: boolean;
  onOpen: (openKey: string) => void;
  /** Another player's name was clicked: open their profile (by friend
   * code). */
  onOpenProfile?: (friendCode: string) => void;
  /** Who's close enough to talk to (null: nobody), when that changes. */
  onNearChange: (spot: TownSpot | null) => void;
  /** What E would do at a bench right now — sit on one nearby, or stand
   * up off it — when that changes (null: nothing). */
  onBenchChange?: (prompt: "sit" | "stand" | null) => void;
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
};

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
      playerLegs: false,
      playerHerzie: null,
      playerRigidBody: null,
      cameraAzimuth: 0,
    }),
    [],
  );
  const current = useTownMap();
  const map = props.map ?? current;
  // A debug override of PIXEL_SCALE (Settings, dev builds).
  const pixelSize = useTownPixelSize();
  // Visitors stand on islands with spots for them.
  const spots = Object.keys(map.spots).length > 0 ? props.spots : [];

  return (
    <Canvas
      // Chunky pixels, to sit with the ASCII herzies: drawn at a fraction of
      // the screen's resolution and scaled up without smoothing.
      dpr={
        props.pixelScale ??
        (pixelSize ? window.devicePixelRatio / pixelSize : PIXEL_SCALE)
      }
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
        <Systems {...props} map={map} spots={spots} input={input} />
        {/* Rapier's WASM loads here: wait inside the canvas instead of
            suspending the whole Town again (the splash would blink). */}
        <Suspense fallback={null}>
          <Physics
            // A new island: a new physics world, with only its colliders.
            key={map.id}
            timeStep={1 / 60}
            interpolate
            gravity={[0, 0, 0]}
            paused={props.paused}
            updatePriority={-3}
          >
            {props.onReady && <FirstFrame onReady={props.onReady} />}
            <World
              map={map}
              others={props.others}
              champion={props.champion}
              hour={props.hour}
            />
            <Player
              look={props.player}
              spawn={map.spawn}
              reach={worldRadius(map)}
              respawn={props.respawn}
              bubble={props.bubbles?.get(props.player.seed)}
            />
            {spots.map((s) => (
              <Visitor key={s.key} spot={s} onOpen={props.onOpen} />
            ))}
            <Combat
              map={map}
              stats={props.stats ?? NO_STATS}
              active={!props.paused}
            />
            {map.id === "bossroom" && (
              <>
                <Boss />
                <Telegraphs />
              </>
            )}
            {/* The bossroom's loot; anywhere, for the dev drop. */}
            <LootDrops />
            {portalsOf(map).some(isMouth) && <CaveTimer map={map} />}
          </Physics>
        </Suspense>
        {props.net && (
          <RemotePlayers
            net={props.net}
            bubbles={props.bubbles}
            onOpenProfile={props.onOpenProfile}
          />
        )}
        <CameraRig />
        {map.combat && (
          <>
            <SonicVFX />
            <DiscVFX />
            <SkillVFX />
            <SlashVFX />
            <CombatOverlay />
          </>
        )}
        {(props.ao !== false || distorts(map)) && (
          <Post ao={props.ao !== false} distort={distorts(map)} />
        )}
      </TownRuntimeContext.Provider>
    </Canvas>
  );
}

const NO_STATS: HerzieStats = {
  sonicPower: 0,
  stamina: 0,
  euphony: 0,
  def: 0,
  luck: 0,
  critChance: 0,
  critDamage: 0,
};

/** Whether anything on the island bends light: sound waves (where you can
 * fight) or a portal. */
function distorts(map: TownMap): boolean {
  return !!map.combat || portalCells(map).length > 0;
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
}: TownCanvasProps & { input: React.RefObject<TownInput> }) {
  const surface = useThree((s) => s.gl.domElement);
  const near = useRef<TownSpot | null>(null);
  const spotsRef = useRef(spots);
  spotsRef.current = spots;
  const benches = useMemo(() => (map ? benchesOf(map) : []), [map]);
  /** The seat E would sit on, if any. */
  const seat = useRef<Seat | null>(null);
  const prompt = useRef<"sit" | "stand" | null>(null);
  // A closed cave has no mouth: nothing to see, step into or be prompted by.
  const caveOpen = useCave().kind === "open";
  const portals = useMemo(
    () => (map ? portalsOf(map) : []).filter((p) => caveOpen || !isMouth(p)),
    [map, caveOpen],
  );
  /** The portal E would step into, if any. */
  const portal = useRef<Portal | null>(null);
  /** Where the player was last frame, on which island: walking through a
   * disc is going from one side of it to the other. */
  const last = useRef({ map: "", x: 0, z: 0 });

  /** E (or a click on the prompt): talk to whoever's near; else step into
   * the portal nearby; else sit on the bench nearby, or stand up off it. */
  const interact = () => {
    const key = near.current?.card.openKey;
    if (key) onOpen(key);
    else if (portal.current) enter(portal.current.to);
    else if (townLive.seat) townLive.standUp = true;
    else if (seat.current) townLive.seat = seat.current;
  };
  const enter = (to: string) => {
    if (warp.active) return;
    // Into a room (the boss's cave): only while it's open, and says why not.
    if (mapById(to).room && !tryEnterCave()) return;
    townLive.seat = null;
    startWarp(to);
    sfxPortal();
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
        goToMap(warp.to, arrivalOn(mapById(warp.to), from));
      }
      if (warp.t >= WARP_OUT + WARP_IN) warp.active = false;
    }
    townLive.frozen = warp.active;
    if (map) {
      const l = last.current;
      if (l.map === map.id && !warp.active) {
        for (const p of portals) {
          if (walkedThrough(p, l.x, l.z, townSave.x, townSave.z)) {
            enter(p.to);
            break;
          }
        }
      }
      Object.assign(l, { map: map.id, x: townSave.x, z: townSave.z });
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

    // The shared uniforms the wind, water and sky read (see ambient.ts).
    ambient.uTime.value = clock.elapsedTime;
    ambient.uPlayer.value.set(townSave.x, 0, townSave.z);
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

    // Benches: the free seat nearest, if no one's there to talk to. A seat
    // is taken if another player is sitting on it.
    seat.current = null;
    if (!closest && !portal.current && !townLive.seat && benches.length > 0) {
      const sitting: { x: number; z: number }[] = [];
      if (net) {
        const t = net.clock.renderTime(performance.now());
        for (const r of net.remotes.values()) {
          const st = r.buffer.sample(t);
          if (st && st.flags & TOWN_FLAG_SITTING) sitting.push(st);
        }
      }
      seat.current = seatNear(benches, townSave.x, townSave.z, (s) =>
        sitting.some((p) => Math.hypot(p.x - s.x, p.z - s.z) < 0.4),
      );
    }
    if (townLive.benchPressed) {
      townLive.benchPressed = false;
      if (!closest) interact();
    }
    const next = townLive.seat ? "stand" : seat.current ? "sit" : null;
    if (next !== prompt.current) {
      prompt.current = next;
      onBenchChange?.(next);
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
