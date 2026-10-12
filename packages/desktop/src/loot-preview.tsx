import "./globals.css";
import { BOSS_STAND } from "@herzies/shared/combat";
import { HerzieModel } from "@herzies/shared/gl";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ambient } from "./components/town/ambient";
import { BossHud } from "./components/town/BossHud";
import { debugDropLoot } from "./components/town/combat/fight";
import { LootDrops } from "./components/town/combat/LootDrops";
import {
  type TownRuntime,
  TownRuntimeContext,
  townSave,
} from "./components/town/runtime";

/**
 * Dev only (`vite dev`, /loot-preview.html): the boss's loot drop on its
 * own, in a bare cave, to tune the show (combat/loot.ts) without a live
 * boss or the app. "Walk in" walks your herzie up to the boss, through
 * the loot; "Spirit" gives it one, to watch it fetch.
 */
function Player({ spirit, walking }: { spirit: boolean; walking: boolean }) {
  const herzie = useMemo(
    () =>
      new HerzieModel(
        {
          seed: "loot-preview",
          stage: 2,
          equipped: spirit ? { spirit: "spirit-orb" } : {},
        },
        { lighting: ambient },
      ),
    [spirit],
  );
  const rt = useRuntime();
  useEffect(() => {
    rt.playerHerzie = herzie;
    return () => {
      rt.playerHerzie = null;
      herzie.dispose();
    };
  }, [herzie, rt]);
  useFrame((_, dt) => {
    let speed = 0;
    if (walking && townSave.z > BOSS_STAND.z + 2.5) {
      speed = 2.2;
      townSave.z -= speed * dt;
    }
    herzie.heading = Math.PI;
    herzie.root.position.set(townSave.x, 0, townSave.z);
    herzie.update(dt, speed);
  });
  return <primitive object={herzie.root} />;
}

let runtime: TownRuntime | null = null;
const useRuntime = () => {
  runtime ??= {
    input: { current: null },
    playerBody: null,
    playerSpeed: 0,
    playerLegs: false,
    playerHerzie: null,
    playerRigidBody: null,
    cameraAzimuth: 0,
  } as unknown as TownRuntime;
  return runtime;
};

function Preview() {
  const [spirit, setSpirit] = useState(true);
  const [walking, setWalking] = useState(false);
  const [run, setRun] = useState(0);
  const drop = () => {
    townSave.x = 0.5;
    townSave.z = 7;
    townSave.heading = Math.PI;
    setWalking(false);
    setRun((r) => r + 1);
    debugDropLoot();
  };
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas camera={{ position: [7, 6, 13], fov: 50 }}>
        <color attach="background" args={["#0b0d12"]} />
        <hemisphereLight args={["#9aa6c8", "#1a1612", 0.9]} />
        <directionalLight position={[4, 8, 6]} intensity={1.1} />
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[40, 40]} />
          <meshLambertMaterial color="#2a2622" />
        </mesh>
        <mesh position={[BOSS_STAND.x, 1.6, BOSS_STAND.z]}>
          <cylinderGeometry args={[1.4, 1.8, 3.2, 12]} />
          <meshLambertMaterial color="#7d7a76" />
        </mesh>
        <TownRuntimeContext.Provider value={useRuntime()}>
          <Player key={`${spirit}`} spirit={spirit} walking={walking} />
          <LootDrops key={run} />
        </TownRuntimeContext.Provider>
        <OrbitControls target={[0, 1, 0]} />
      </Canvas>
      <BossHud name="Preview" />
      <div
        style={{ position: "fixed", top: 8, left: 8, display: "flex", gap: 6 }}
      >
        <button type="button" className="btn" onClick={drop}>
          Drop
        </button>
        <button type="button" className="btn" onClick={() => setWalking(true)}>
          Walk in
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setSpirit((s) => !s)}
        >
          Spirit: {spirit ? "on" : "off"}
        </button>
      </div>
    </div>
  );
}

townSave.x = 0.5;
townSave.z = 7;
const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
