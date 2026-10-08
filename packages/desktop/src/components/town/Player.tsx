import { useFrame } from "@react-three/fiber";
import {
  CapsuleCollider,
  type RapierCollider,
  type RapierRigidBody,
  RigidBody,
  useBeforePhysicsStep,
  useRapier,
} from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import type { Look } from "../TownScene";
import { HerzieSprite } from "./HerzieSprite";
import { type Mover, stepMover, walkAzimuth } from "./movement";
import { townSave, useTownRuntime, WORLD_RADIUS } from "./runtime";

/** The capsule the controller pushes around: radius and half-height of its
 * straight part, standing on the ground. */
const RADIUS = 0.55;
const HALF_HEIGHT = 0.35;
/** Gap the controller keeps from whatever it slides along. */
const SKIN = 0.02;

/**
 * The player's herzie: a kinematic body moved by Rapier's character
 * controller, which handles collisions and sliding along visitors and
 * trees. Movement runs in the fixed physics step; the body's drawn position
 * is interpolated between steps by <Physics interpolate>.
 *
 * Controls: WASD / arrows walk relative to the camera. Left-dragging only
 * looks around — the herzie keeps walking the way it was. Holding the right
 * button turns the herzie with the camera (and A/D then strafe); holding
 * both walks forward.
 */
export function Player({ look }: { look: Look }) {
  const rt = useTownRuntime();
  const { world } = useRapier();
  const body = useRef<RapierRigidBody>(null);
  const collider = useRef<RapierCollider>(null);
  const mover = useRef<Mover>({ vx: 0, vz: 0, heading: townSave.heading });

  // Created and freed in the same effect: a WASM object, so a memo whose
  // cleanup ran early (StrictMode, a remount) would leave a freed one.
  const controller = useRef<ReturnType<
    typeof world.createCharacterController
  > | null>(null);
  useEffect(() => {
    const c = world.createCharacterController(SKIN);
    c.setSlideEnabled(true);
    controller.current = c;
    return () => {
      controller.current = null;
      world.removeCharacterController(c);
    };
  }, [world]);
  /** The direction walking is relative to (see walkAzimuth). */
  const walkAz = useRef<number | null>(null);

  const equippedKey = JSON.stringify(look.equipped ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const sprite = useMemo(
    () => new HerzieSprite(look),
    [look.seed, look.stage, equippedKey],
  );
  useEffect(() => {
    sprite.heading = townSave.heading;
    return () => sprite.dispose();
  }, [sprite]);

  useBeforePhysicsStep((w) => {
    const b = body.current;
    const col = collider.current;
    const kcc = controller.current;
    if (!b || !col || !kcc) return;
    const dt = w.timestep;
    const input = rt.input.current;
    const m = mover.current;
    walkAz.current = walkAzimuth(walkAz.current, rt.cameraAzimuth, input);
    m.heading = sprite.heading;
    stepMover(m, input, walkAz.current, dt);
    sprite.heading = m.heading;

    kcc.computeColliderMovement(col, {
      x: m.vx * dt,
      y: 0,
      z: m.vz * dt,
    });
    const move = kcc.computedMovement();
    const p = b.translation();
    let x = p.x + move.x;
    let z = p.z + move.z;
    const r = Math.hypot(x, z);
    if (r > WORLD_RADIUS) {
      x = (x / r) * WORLD_RADIUS;
      z = (z / r) * WORLD_RADIUS;
    }
    // The walk cycle follows the distance actually covered: pushing into a
    // tree stops the feet too.
    rt.playerSpeed = Math.hypot(x - p.x, z - p.z) / dt;
    b.setNextKinematicTranslation({ x, y: p.y, z });
    townSave.x = x;
    townSave.z = z;
    townSave.heading = sprite.heading;
  });

  useFrame(({ camera }, dt) => {
    sprite.update(dt, rt.playerSpeed, camera);
  });

  return (
    <RigidBody
      ref={(b) => {
        body.current = b;
      }}
      type="kinematicPosition"
      colliders={false}
      position={[townSave.x, 0, townSave.z]}
      enabledRotations={[false, false, false]}
    >
      <CapsuleCollider
        ref={collider}
        args={[HALF_HEIGHT, RADIUS]}
        position={[0, HALF_HEIGHT + RADIUS + SKIN, 0]}
      />
      <group
        ref={(g) => {
          rt.playerBody = g;
        }}
      >
        <primitive object={sprite.root} />
      </group>
    </RigidBody>
  );
}
