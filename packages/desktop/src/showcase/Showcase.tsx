import { Canvas, useFrame } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ambient } from "../components/town/ambient";
import type { Champion } from "../components/town/champion";
import { driftClouds } from "../components/town/depth";
import { Post } from "../components/town/Post";
import { PIXEL_SCALE } from "../components/town/pixelSize";
import {
  HOME_MAP,
  type TownRuntime,
  TownRuntimeContext,
} from "../components/town/runtime";
import "../components/town/shadows";
import { statueSpots } from "../components/town/Statues";
import { World } from "../components/town/World";
import type { WatchConnection } from "./WatchConnection";
import { WatchedHerzies } from "./WatchedHerzies";

export type ShowcaseProps = {
  net: WatchConnection | null;
  champion?: Champion;
  /** Hold the camera still (prefers-reduced-motion). */
  still?: boolean;
  /** Skip ambient occlusion (small or slow screens). */
  lite?: boolean;
  onReady?: () => void;
};

/** One lap around the statue, in seconds. */
const LAP_S = 120;
/** How far out the camera circles, how high, and how far above the statue's
 * foot it looks. */
const ORBIT_RADIUS = 30;
const ORBIT_HEIGHT = 24;
const LOOK_HEIGHT = 1.5;

/**
 * The home island for the website: the camera circling the statue for
 * ever, and whoever is in Town right now walking about. Nothing to steer,
 * nothing to bump into (see rapier-stub.ts).
 */
export function Showcase({
  net,
  champion,
  still,
  lite,
  onReady,
}: ShowcaseProps) {
  const runtime = useMemo<TownRuntime>(
    () => ({
      input: { current: null } as unknown as TownRuntime["input"],
      playerBody: null,
      playerSpeed: 0,
      playerLegs: false,
      playerHerzie: null,
      playerRigidBody: null,
      cameraAzimuth: 0,
    }),
    [],
  );
  const hidden = usePageHidden();
  return (
    <Canvas
      dpr={PIXEL_SCALE}
      gl={{ antialias: false, powerPreference: "low-power" }}
      shadows="percentage"
      style={{ imageRendering: "pixelated" }}
      camera={{ fov: 50, near: 0.1, far: 400 }}
      frameloop={hidden ? "never" : "always"}
    >
      <TownRuntimeContext.Provider value={runtime}>
        {/* The map's colliders want a physics world: in the website's build
            it's a stand-in that holds nothing (see rapier-stub.tsx). */}
        <Suspense fallback={null}>
          <Physics paused>
            <World map={HOME_MAP} champion={champion} />
          </Physics>
        </Suspense>
        {net && <WatchedHerzies map={HOME_MAP} net={net} />}
        <Orbit still={still} />
        <Uniforms />
        {onReady && <FirstFrame onReady={onReady} />}
        <Post ao={!lite} distort={false} />
      </TownRuntimeContext.Provider>
    </Canvas>
  );
}

/** The middle of the orbit: the statue (the middle of town if there's
 * none). */
function orbitCentre(): [number, number, number] {
  const [first] = statueSpots(HOME_MAP);
  if (!first) return [0, 0, 0];
  const [x, z, , y] = first;
  return [x, y, z];
}

function Orbit({ still }: { still?: boolean }) {
  const centre = useMemo(orbitCentre, []);
  const angle = useRef(Math.random() * Math.PI * 2);
  useFrame(({ camera, size }, dt) => {
    if (!still) angle.current += (Math.min(dt, 0.1) * Math.PI * 2) / LAP_S;
    const [x, y, z] = centre;
    // A tall, narrow screen (a phone) sees less across: back off a little,
    // but stay close enough for the herzies to read.
    const back = Math.min(1.1, Math.max(1, 1.3 / (size.width / size.height)));
    camera.position.set(
      x + Math.sin(angle.current) * ORBIT_RADIUS * back,
      y + ORBIT_HEIGHT * back,
      z + Math.cos(angle.current) * ORBIT_RADIUS * back,
    );
    camera.lookAt(x, y + LOOK_HEIGHT, z);
    camera.updateMatrixWorld();
    // Whatever stands between the camera and the statue turns see-through,
    // as it does in front of the player in the app (see `seeThrough`).
    ambient.uPlayerView.value
      .set(x, y + LOOK_HEIGHT, z)
      .applyMatrix4(camera.matrixWorldInverse);
  });
  return null;
}

/** The shared uniforms the wind, water and sky read (see ambient.ts), as
 * the Town's own frame loop sets them. Nobody is walking the grass aside. */
function Uniforms() {
  useFrame(({ clock }) => {
    ambient.uTime.value = clock.elapsedTime;
    ambient.uPlayer.value.set(1e4, 0, 1e4);
    driftClouds(clock.elapsedTime, ambient.uWindDir.value);
  }, -4);
  return null;
}

function FirstFrame({ onReady }: { onReady: () => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    requestAnimationFrame(() => onReady());
  });
  return null;
}

/** Whether the tab is out of sight: no drawing then. */
function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}
