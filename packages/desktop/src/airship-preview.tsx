import "./globals.css";
import { HerzieModel } from "@herzies/shared/gl";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import {
  AirshipModel,
  SHIP_AT_REST,
  type ShipMotion,
} from "./components/town/airship/AirshipModel";
import { type Berth, berthOf } from "./components/town/airship/berth";
import { DockModel } from "./components/town/airship/DockModel";
import { DECK_OBSTACLES } from "./components/town/airship/deck";
import { ambient } from "./components/town/ambient";
import { windowGlow } from "./components/town/Buildings";
import { islandGeometry } from "./components/town/Islands";
import { nightLights } from "./components/town/Lamps";
import { islandRadius } from "./components/town/map";
import { HOME_MAP } from "./components/town/maps";
import {
  setSfxMuted,
  sfxShipBell,
  sfxShipCreak,
  sfxShipHorn,
  sfxShipThunk,
  shipAmbience,
} from "./components/town/sfx";

type Orbit = React.ComponentRef<typeof OrbitControls>;

/**
 * Dev only (`vite dev`, /airship-preview.html): the sky ship, Blåmann,
 * and the Sky Dock on their own (airship/AirshipModel.ts, DockModel.ts),
 * to tune how they look and move. The ship is shown twice: moored at the
 * home island's dock, and flying alongside. Sliders drive both copies'
 * ShipMotion (the moored one keeps its gangplank to the dock), plus
 * night, the bells (the ship's and the dock's, rung together) and the
 * ship's sounds. The herzie on deck stands in for the player, so the
 * balloon's see-through dither shows.
 *  ?view=dock|pier|deck|side|under|flying|wing|bell   where the camera starts
 *  ?night=1                                           start at night
 * `window.preview.motion` and `.state` are live; `preview.view(name)`
 * moves the camera; `.moored` and `.dock` are the models.
 */
const params = new URLSearchParams(location.search);
const berth = berthOf(HOME_MAP) as Berth;

const motion: ShipMotion = {
  ...SHIP_AT_REST,
  moored: 1,
  gangplank: 1,
};
const state = {
  motion,
  night: params.get("night") === "1" ? 1 : 0,
  bellAt: Number.NEGATIVE_INFINITY,
  bellStrikes: 0,
  ambience: false,
  t: 0,
};

/** Camera spots: [position, target], island-local. */
const shipAt = new THREE.Vector3(berth.ship.x, berth.ship.y, berth.ship.z);
const out = new THREE.Vector3(Math.sin(berth.out), 0, Math.cos(berth.out));
const along = new THREE.Vector3(Math.cos(berth.out), 0, -Math.sin(berth.out));
const FLYING_OFFSET = out
  .clone()
  .multiplyScalar(34)
  .add(new THREE.Vector3(0, 8, 0));
const VIEWS: Record<string, () => [THREE.Vector3, THREE.Vector3]> = {
  dock: () => [
    new THREE.Vector3(berth.pierStart.x, 6, berth.pierStart.z)
      .addScaledVector(out, -10)
      .addScaledVector(along, -6),
    shipAt.clone().addScaledVector(out, -3),
  ],
  side: () => [
    shipAt.clone().addScaledVector(out, 26).addScaledVector(along, 8).setY(8),
    shipAt.clone().setY(shipAt.y + 6),
  ],
  deck: () => [
    shipAt
      .clone()
      .addScaledVector(along, -14)
      .setY(shipAt.y + 8),
    shipAt.clone().setY(shipAt.y + 1),
  ],
  under: () => [
    shipAt
      .clone()
      .addScaledVector(out, 12)
      .setY(shipAt.y - 7),
    shipAt.clone().setY(shipAt.y + 4),
  ],
  flying: () => [
    shipAt
      .clone()
      .add(FLYING_OFFSET)
      .addScaledVector(out, 22)
      .addScaledVector(along, 18)
      .setY(shipAt.y + 16),
    shipAt
      .clone()
      .add(FLYING_OFFSET)
      .setY(shipAt.y + FLYING_OFFSET.y + 7),
  ],
  wing: () => {
    const base = shipAt.clone().add(FLYING_OFFSET);
    return [
      base
        .clone()
        .addScaledVector(out, 9)
        .addScaledVector(along, -13)
        .setY(base.y + 2.5),
      base.clone().addScaledVector(out, 5).addScaledVector(along, -6.5),
    ];
  },
  pier: () => {
    const end = new THREE.Vector3(
      berth.pierEnd.x,
      berth.pierEnd.y,
      berth.pierEnd.z,
    );
    return [
      end
        .clone()
        .addScaledVector(along, 9)
        .addScaledVector(out, -1)
        .setY(end.y + 3.5),
      end
        .clone()
        .addScaledVector(out, 2.5)
        .setY(end.y + 1),
    ];
  },
  // Over the shoulder of the ship's bell, past its post, to watch it swing
  // fore and aft to its strikes.
  bell: () => {
    const b = DECK_OBSTACLES[1];
    const onDeck = (x: number, y: number, z: number) =>
      new THREE.Vector3(x, y, z)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), berth.ship.yaw)
        .add(shipAt);
    return [onDeck(b.x + 1.6, 2.9, b.z - 1.7), onDeck(b.x, 1.95, b.z)];
  },
};

function Scene({ orbit }: { orbit: React.RefObject<Orbit | null> }) {
  const camera = useThree((s) => s.camera);
  const island = useMemo(() => {
    const r = islandRadius(HOME_MAP);
    return islandGeometry(r, r * 0.75, 20261008, { segments: 96 });
  }, []);
  const moored = useMemo(() => new AirshipModel(), []);
  const flying = useMemo(() => new AirshipModel(), []);
  const dock = useMemo(() => new DockModel(berth), []);
  const herzies = useMemo(
    () =>
      ["preview-a", "preview-b"].map(
        (seed) =>
          new HerzieModel(
            { seed, stage: 3, equipped: {} },
            { lighting: ambient },
          ),
      ),
    [],
  );
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    moored.root.position.copy(shipAt);
    moored.root.rotation.y = berth.ship.yaw;
    flying.root.position.copy(shipAt).add(FLYING_OFFSET);
    flying.root.rotation.y = berth.ship.yaw;
    // One herzie on deck (by the gangway), one on the pier.
    moored.root.add(herzies[0].root);
    herzies[0].root.position.set(2.2, 0, 1.6);
    herzies[0].heading = -Math.PI / 2;
    herzies[1].root.position.set(
      berth.pierStart.x + out.x * 2.5,
      berth.pierStart.y,
      berth.pierStart.z + out.z * 2.5,
    );
    herzies[1].heading = berth.out;
    const view = (name: string) => {
      const [p, target] = (VIEWS[name] ?? VIEWS.dock)();
      camera.position.copy(p);
      orbit.current?.target.copy(target);
      orbit.current?.update();
    };
    Object.assign(window, {
      preview: {
        state,
        motion,
        view,
        moored,
        dock,
      },
    });
    view(params.get("view") ?? "dock");
    return () => {
      moored.dispose();
      flying.dispose();
      dock.dispose();
      for (const h of herzies) h.dispose();
      island.dispose();
    };
  }, [moored, flying, dock, herzies, island, camera, orbit]);

  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, frameDt) => {
    const dt = Math.min(frameDt, 1 / 20);
    state.t += dt;
    const t = state.t;
    ambient.uTime.value = t;
    const night = state.night;
    windowGlow.uWindows.value = night;
    nightLights.level = night;
    ambient.uNight.value = night;
    const day = new THREE.Color("#a9cbe6");
    const dark = new THREE.Color("#141f3a");
    const sky = day.lerp(dark, night);
    scene.background = sky;
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(sky);
    if (sun.current) sun.current.intensity = 1.6 * (1 - night) + 0.12 * night;
    if (hemi.current) hemi.current.intensity = 1.1 * (1 - night) + 0.35 * night;
    ambient.uLight.value.setScalar(1 - 0.6 * night);

    // The moored ship's gangplank goes to the dock.
    moored.root.updateMatrixWorld();
    const end = moored.root.worldToLocal(
      tmp.set(berth.pierEnd.x, berth.pierEnd.y, berth.pierEnd.z),
    );
    const bell = t - state.bellAt;
    const strikes = state.bellStrikes;
    moored.update(dt, t, {
      ...motion,
      gangplankTo: { x: end.x, y: end.y },
      bell,
      bellStrikes: strikes,
    });
    flying.update(dt, t, {
      ...motion,
      moored: 0,
      gangplank: 0,
      bell,
      bellStrikes: strikes,
    });
    dock.update(dt, t, { bell, strikes });
    for (const h of herzies) h.update(dt, 0);

    // The player (for the see-through dither): the herzie on deck.
    herzies[0].root.getWorldPosition(tmp).setY(tmp.y + 1.2);
    ambient.uPlayer.value.copy(tmp);
    ambient.uPlayerView.value.copy(tmp).applyMatrix4(camera.matrixWorldInverse);

    if (state.ambience)
      shipAmbience.set({
        speed: motion.speed,
        throttle: motion.throttle,
        near: 1,
      });
    else shipAmbience.set({ speed: 0, throttle: 0, near: 0 });
  });

  return (
    <>
      <hemisphereLight ref={hemi} args={["#ffffff", "#556644", 1.1]} />
      <directionalLight
        ref={sun}
        position={[shipAt.x - 30, 50, shipAt.z + 20]}
        intensity={1.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
        shadow-camera-far={150}
        shadow-bias={-0.0005}
      >
        <object3D attach="target" position={[shipAt.x, 0, shipAt.z]} />
      </directionalLight>
      <mesh geometry={island} receiveShadow>
        <meshLambertMaterial vertexColors flatShading />
      </mesh>
      <primitive object={dock.root} />
      <primitive object={moored.root} />
      <primitive object={flying.root} />
      <primitive object={herzies[1].root} />
    </>
  );
}

const SLIDERS: [
  key: keyof ShipMotion,
  min: number,
  max: number,
  step: number,
][] = [
  ["speed", 0, 10, 0.1],
  ["throttle", 0, 1, 0.01],
  ["accel", -1.5, 1.5, 0.05],
  ["turnRate", -0.12, 0.12, 0.005],
  ["moored", 0, 1, 0.01],
  ["gangplank", 0, 1, 0.01],
  ["gust", -1, 1, 0.05],
];

function Panel() {
  const [, redraw] = useState(0);
  const set = (fn: () => void) => {
    fn();
    redraw((n) => n + 1);
  };
  return (
    <div
      style={{
        position: "fixed",
        top: 8,
        left: 8,
        padding: 8,
        background: "rgba(10,12,18,0.7)",
        color: "#eee",
        font: "12px monospace",
        display: "grid",
        gridTemplateColumns: "auto 140px 40px",
        gap: 4,
        alignItems: "center",
      }}
    >
      {SLIDERS.map(([key, min, max, step]) => (
        <label key={key} style={{ display: "contents" }}>
          <span>{key}</span>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={motion[key] as number}
            onChange={(e) =>
              set(() =>
                Object.assign(motion, { [key]: Number(e.target.value) }),
              )
            }
          />
          <span>{(motion[key] as number).toFixed(2)}</span>
        </label>
      ))}
      <label style={{ display: "contents" }}>
        <span>night</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={state.night}
          onChange={(e) =>
            set(() => Object.assign(state, { night: Number(e.target.value) }))
          }
        />
        <span>{state.night.toFixed(2)}</span>
      </label>
      <div
        style={{
          gridColumn: "1 / -1",
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
        }}
      >
        <button
          type="button"
          className="btn"
          onClick={() => setSfxMuted(false)}
        >
          Sound on
        </button>
        {[2, 3].map((n) => (
          <button
            key={n}
            type="button"
            className="btn"
            onClick={() => {
              state.bellAt = state.t;
              state.bellStrikes = n;
              sfxShipBell(n);
            }}
          >
            Bell ×{n}
          </button>
        ))}
        <button type="button" className="btn" onClick={() => sfxShipHorn()}>
          Horn
        </button>
        <button type="button" className="btn" onClick={() => sfxShipCreak()}>
          Creak
        </button>
        <button type="button" className="btn" onClick={() => sfxShipThunk()}>
          Thunk
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            set(() => Object.assign(state, { ambience: !state.ambience }))
          }
        >
          Ride: {state.ambience ? "on" : "off"}
        </button>
      </div>
    </div>
  );
}

function Preview() {
  const orbit = useRef<Orbit | null>(null);
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas shadows camera={{ fov: 50, near: 0.1, far: 600 }}>
        <fog attach="fog" args={["#a9cbe6", 120, 420]} />
        <Scene orbit={orbit} />
        <OrbitControls ref={orbit} makeDefault />
      </Canvas>
      <Panel />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
