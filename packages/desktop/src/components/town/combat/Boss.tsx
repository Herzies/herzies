import { BOSS_STAND } from "@herzies/shared/combat";
import { HerzieModel, turnToward } from "@herzies/shared/gl";
import { useFrame } from "@react-three/fiber";
import { CylinderCollider, RigidBody } from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import { lookOf } from "../../TownScene";
import { ambient } from "../ambient";
import { townSave } from "../runtime";
import { bossFight, useBossFight } from "./fight";

/** The boss looms: drawn this much bigger than it's built, like the one
 * in town. */
const SCALE = 2.2;
const TURN_RATE = 4;
const MAX_TURN_SPEED = 3;
/** The boss rears this much while an attack fills, and drops on the slam. */
const REAR = 0.08;
const SLAM_MS = 260;

/**
 * The boss in its cave: the same body as the one in town, turning to
 * whoever is nearest, raising its hand as an attack builds on the floor,
 * dropping heavily as it lands, and turning to stone when it falls. It's
 * solid, so waves burst on it and nobody walks through it.
 */
export function Boss() {
  useBossFight();
  const event = bossFight.event;
  const herzie = useMemo(() => {
    if (!event) return null;
    const m = new HerzieModel(
      lookOf({
        type: "boss_fight",
        title: "",
        description: null,
        status: "live",
        at: null,
        openKey: null,
        eventId: event,
      }),
      { seed: 7, lighting: ambient },
    );
    m.root.position.set(BOSS_STAND.x, 0, BOSS_STAND.z);
    m.heading = Math.PI;
    return m;
  }, [event]);
  useEffect(() => () => herzie?.dispose(), [herzie]);

  const stoned = useRef(false);
  const lastShapes = useRef(0);
  useFrame((_, dt) => {
    if (!herzie) return;
    const now = performance.now();
    // Face the nearest player: here that's you, until others can be told.
    const dx = townSave.x - BOSS_STAND.x;
    const dz = townSave.z - BOSS_STAND.z;
    herzie.heading = turnToward(
      herzie.heading,
      Math.atan2(dx, dz),
      TURN_RATE,
      MAX_TURN_SPEED,
      dt,
    );
    // A new shape on the floor: the hand goes up.
    const coming = bossFight.shapes.filter((s) => s.resolvedAt === null);
    if (coming.length > lastShapes.current && !herzie.casting) herzie.cast(0);
    lastShapes.current = coming.length;
    // Rear while one fills, drop as it lands.
    const slam = Math.max(0, 1 - (now - bossFight.slammedAt) / SLAM_MS);
    const rear = coming.length ? REAR : 0;
    const y = 1 + rear - slam * 0.1;
    const xz = 1 - rear * 0.4 + slam * 0.06;
    herzie.root.scale.set(SCALE * xz, SCALE * y, SCALE * xz);
    if (bossFight.victory && !stoned.current) {
      stoned.current = true;
      herzie.petrify();
    }
    herzie.update(dt, 0);
  });

  if (!herzie) return null;
  return (
    <>
      <primitive object={herzie.root} />
      <RigidBody
        type="fixed"
        colliders={false}
        position={[BOSS_STAND.x, 0, BOSS_STAND.z]}
      >
        <CylinderCollider
          args={[2.4, BOSS_STAND.radius * 0.92]}
          position={[0, 2.4, 0]}
        />
      </RigidBody>
    </>
  );
}
