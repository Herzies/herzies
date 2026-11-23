import { type ShipIndex, type SkyDock, WILDS_LEG_MS } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Benches } from "../Benches";
import { mapById } from "../maps";
import { townSave } from "../runtime";
import { shipAmbience } from "../sfx";
import { AirshipModel, type ShipMotion } from "./AirshipModel";
import { type Berth, berthOf } from "./berth";
import { fleet, hasRoute, poseMatrix, updateFleet } from "./fleet";
import { setAboardNear, setShipFrame } from "./frames";
import { emptyPose } from "./route";
import { setListener, shipBells, stepShipSounds } from "./shipSounds";

/**
 * The sky ship, Sofia III, wherever the timetable has it, drawn from any
 * island (and around you when you're aboard). It's a group whose matrix
 * carries its deck's frame into the scene's — set once a frame, before
 * physics and the camera, from the same moment for everything — with the
 * model, the deck's benches and (see Player, TownCanvas) whoever is aboard
 * inside it.
 */

/** Which island a ship in this state is nearest: the one it's at, or
 * the one it left until half way, then the one it's making for. */
export function nearDock(ship: ShipIndex, now: number): SkyDock {
  const st = fleet.poses[ship].state;
  if (st.kind === "docked") return st.at;
  return now - st.departedAt < WILDS_LEG_MS / 2 ? st.from : st.to;
}

/** Island-local points by a berth, in the moored ship's deck frame. */
function onDeckAt(
  berth: Berth,
  dock: SkyDock,
  points: { x: number; y: number; z: number }[],
): { x: number; y: number; z: number }[] {
  const [ox, oy, oz] = mapById(dock).origin;
  const pose = emptyPose();
  Object.assign(pose, {
    x: berth.ship.x + ox,
    y: berth.ship.y + oy,
    z: berth.ship.z + oz,
    yaw: berth.ship.yaw,
  });
  const inv = poseMatrix(pose, new THREE.Matrix4()).invert();
  return points.map((p) => {
    const v = new THREE.Vector3(p.x + ox, p.y + oy, p.z + oz).applyMatrix4(inv);
    return { x: v.x, y: v.y, z: v.z };
  });
}

/** Where each dock's gangplank comes down, as the ship lying there sees
 * it. */
function plankEndOf(dock: SkyDock): ShipMotion["gangplankTo"] | null {
  const berth = berthOf(mapById(dock));
  if (!berth) return null;
  const [end] = onDeckAt(berth, dock, [berth.pierEnd]);
  return { x: end.x, y: end.y };
}

export function SkyShips({
  origin,
}: {
  /** Where the scene's origin is in the sky: the island drawn there. */
  origin: readonly [number, number, number];
}) {
  const originRef = useRef(origin);
  originRef.current = origin;
  const plankEnds = useMemo(
    () => ({ home: plankEndOf("home"), wilds: plankEndOf("wilds") }),
    [],
  );
  // Before anything else in the frame: where the ship is now. Aboard,
  // which island the world is drawn round.
  useFrame(({ camera }) => {
    setListener(camera);
    updateFleet();
    if (townSave.map === "airship")
      setAboardNear(nearDock(townSave.ship, fleet.now));
  }, -6);
  useEffect(() => () => shipAmbience.stop(), []);
  if (!hasRoute()) return null;
  return <SkyShip ship={0} origin={originRef} plankEnds={plankEnds} />;
}

const shift = new THREE.Matrix4();

function SkyShip({
  ship,
  origin,
  plankEnds,
}: {
  ship: ShipIndex;
  origin: React.RefObject<readonly [number, number, number]>;
  plankEnds: Record<SkyDock, ShipMotion["gangplankTo"] | null>;
}) {
  const group = useRef<THREE.Group>(null);
  const model = useMemo(() => new AirshipModel(), []);
  useEffect(() => () => model.dispose(), [model]);
  useLayoutEffect(() => {
    setShipFrame(ship, group.current);
    return () => setShipFrame(ship, null);
  }, [ship]);
  const deck = useMemo(() => mapById("airship"), []);
  const motion = useRef<ShipMotion>({
    speed: 0,
    throttle: 0,
    accel: 0,
    turnRate: 0,
    moored: 1,
    gangplank: 0,
    gangplankTo: { x: 9, y: -1.3 },
    gust: 0,
    bell: Number.POSITIVE_INFINITY,
    bellStrikes: 0,
  });
  // Moved to where the fleet has it (after the fleet's worked out, before
  // physics and the camera), its moving parts posed.
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const [ox, oy, oz] = origin.current;
    g.matrix
      .copy(fleet.matrices[ship])
      .premultiply(shift.makeTranslation(-ox, -oy, -oz));
    g.updateMatrixWorld(true);
    const p = fleet.poses[ship];
    const m = motion.current;
    m.speed = p.speed;
    m.throttle = p.throttle;
    m.accel = p.accel;
    m.turnRate = p.turnRate;
    m.moored = p.moored;
    m.gangplank = p.gangplank;
    m.gust = p.gust;
    // Its plank reaches the dock it's at, or has just left, or is coming
    // in to.
    const plankTo = plankEnds[nearDock(ship, fleet.now)];
    if (plankTo) m.gangplankTo = plankTo;
    // The cues first, so a bell rung this frame swings from this frame.
    stepShipSounds(ship, g);
    const rung = shipBells[ship];
    m.bell = (fleet.now - rung.at) / 1000;
    m.bellStrikes = rung.strikes;
    model.update(dt, fleet.now / 1000, m);
  }, -5.5);
  return (
    <group ref={group} matrixAutoUpdate={false}>
      <primitive object={model.root} />
      <Benches map={deck} />
    </group>
  );
}
