import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { useMemo, useRef, useState } from "react";
import type * as THREE from "three";
import type { Look } from "../TownScene";
import { CameraRig } from "./CameraRig";
import { resetFrameBudget } from "./HerzieSprite";
import { type TownInput, useTownInput } from "./input";
import { Player } from "./Player";
import {
  TALK_RANGE,
  type TownRuntime,
  TownRuntimeContext,
  type TownSpot,
  townSave,
} from "./runtime";
import { Visitor } from "./Visitor";
import { World } from "./World";

export type TownCanvasProps = {
  spots: TownSpot[];
  player: Look;
  paused: boolean;
  onOpen: (openKey: string) => void;
  /** Who's close enough to talk to (null: nobody), when that changes. */
  onNearChange: (spot: TownSpot | null) => void;
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
    () => ({ input, playerBody: null, playerSpeed: 0, cameraAzimuth: 0 }),
    [],
  );
  const [treeMeshes, setTreeMeshes] = useState<THREE.Object3D[]>([]);

  return (
    <Canvas
      // Chunky pixels, to sit with the ASCII herzies.
      dpr={1}
      gl={{ antialias: false }}
      style={{ imageRendering: "pixelated" }}
      camera={{ fov: 55, near: 0.1, far: 120 }}
      frameloop={props.paused ? "never" : "always"}
    >
      <TownRuntimeContext.Provider value={runtime}>
        <Systems {...props} input={input} />
        <Physics
          timeStep={1 / 60}
          interpolate
          gravity={[0, 0, 0]}
          paused={props.paused}
          updatePriority={-3}
        >
          <World onTreeMeshes={setTreeMeshes} />
          <Player look={props.player} />
          {props.spots.map((s) => (
            <Visitor key={s.key} spot={s} onOpen={props.onOpen} />
          ))}
        </Physics>
        <CameraRig colliders={treeMeshes} />
      </TownRuntimeContext.Provider>
    </Canvas>
  );
}

/** Per-frame housekeeping: input, the sprite render budget, and who the
 * player is close enough to talk to. */
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

  useFrame(() => {
    resetFrameBudget();

    let closest: TownSpot | null = null;
    let best = TALK_RANGE;
    for (const s of spotsRef.current) {
      if (!s.standing || !s.card.openKey) continue;
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
