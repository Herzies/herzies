import { Canvas, type RootState, useFrame, useThree } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { Suspense, useMemo, useRef } from "react";
import type { Look } from "../TownScene";
import { ambient } from "./ambient";
import { CameraRig } from "./CameraRig";
import type { Hour } from "./DayCycle";
import { type TownInput, useTownInput } from "./input";
import type { TownMap } from "./map";
import type { TownConnection } from "./net/TownConnection";
import { Player } from "./Player";
import { RemotePlayers } from "./RemotePlayers";
import {
  HOME_MAP,
  TALK_RANGE,
  type TownRuntime,
  TownRuntimeContext,
  type TownSpot,
  townSave,
} from "./runtime";
import type { Champion } from "./Statues";
import { Visitor } from "./Visitor";
import { World } from "./World";

/** The Town's resolution as a fraction of the screen's: each drawn pixel
 * covers 1/PIXEL_SCALE screen pixels square. */
const PIXEL_SCALE = 1 / 3;

export type TownCanvasProps = {
  spots: TownSpot[];
  player: Look;
  paused: boolean;
  onOpen: (openKey: string) => void;
  /** Who's close enough to talk to (null: nobody), when that changes. */
  onNearChange: (spot: TownSpot | null) => void;
  /** The island to draw (the map editor's preview passes its own). */
  map?: TownMap;
  /** Bump to put the player back at the map's spawn. */
  respawn?: number;
  /** Who the statues show: the last boss fight's champion (a stand-in
   * until there's one). */
  champion?: Champion;
  /** Show the world at this hour (default: the local clock). */
  hour?: Hour;
  /** Cast shadows from the sun (default: on; off to measure the cost). */
  shadows?: boolean;
  /** The multiplayer Town: draws everyone else on it. */
  net?: TownConnection | null;
  /** Called once the world has drawn its first frame. */
  onReady?: () => void;
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
      cameraAzimuth: 0,
    }),
    [],
  );
  const map = props.map ?? HOME_MAP;

  return (
    <Canvas
      // Chunky pixels, to sit with the ASCII herzies: drawn at a fraction of
      // the screen's resolution and scaled up without smoothing.
      dpr={PIXEL_SCALE}
      gl={{ antialias: false }}
      // Plain PCF: soft enough, and at these pixels the edge reads clean.
      shadows={props.shadows === false ? false : "percentage"}
      style={{ imageRendering: "pixelated" }}
      camera={{ fov: 55, near: 0.1, far: 400 }}
      frameloop={props.paused ? "never" : "always"}
      onCreated={props.onCreated}
    >
      <TownRuntimeContext.Provider value={runtime}>
        <Systems {...props} input={input} />
        {/* Rapier's WASM loads here: wait inside the canvas instead of
            suspending the whole Town again (the splash would blink). */}
        <Suspense fallback={null}>
          <Physics
            timeStep={1 / 60}
            interpolate
            gravity={[0, 0, 0]}
            paused={props.paused}
            updatePriority={-3}
          >
            {props.onReady && <FirstFrame onReady={props.onReady} />}
            <World map={map} champion={props.champion} hour={props.hour} />
            <Player
              look={props.player}
              spawn={map.spawn}
              respawn={props.respawn}
            />
            {props.spots.map((s) => (
              <Visitor key={s.key} spot={s} onOpen={props.onOpen} />
            ))}
          </Physics>
        </Suspense>
        {props.net && <RemotePlayers net={props.net} />}
        <CameraRig />
      </TownRuntimeContext.Provider>
    </Canvas>
  );
}

/** Per-frame housekeeping: input, and who the player is close enough to
 * talk to. */
function Systems({
  spots,
  paused,
  onOpen,
  onNearChange,
  input,
}: TownCanvasProps & { input: React.RefObject<TownInput> }) {
  const surface = useThree((s) => s.gl.domElement);
  const near = useRef<TownSpot | null>(null);
  const spotsRef = useRef(spots);
  spotsRef.current = spots;

  const live = useTownInput(!paused, surface, () => {
    const key = near.current?.card.openKey;
    if (key) onOpen(key);
  });
  input.current = live.current;

  useFrame(({ clock }) => {
    // The shared uniforms the wind, water and sky read (see ambient.ts).
    ambient.uTime.value = clock.elapsedTime;
    ambient.uPlayer.value.set(townSave.x, 0, townSave.z);

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
