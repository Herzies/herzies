import { HerzieModel } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
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
import { ambient } from "./ambient";
import { SEAT_Y } from "./Benches";
import type { ChatBubble } from "./chatBubbles";
import { HeadBubble } from "./HeadBubble";
import type { TownMap } from "./map";
import { type Mover, stepMover, walkAzimuth } from "./movement";
import { townLive, townSave, useTownRuntime, WORLD_RADIUS } from "./runtime";

/** The capsule the controller pushes around: radius and half-height of its
 * straight part, standing on the ground. */
const RADIUS = 0.55;
const HALF_HEIGHT = 0.35;
/** Gap the controller keeps from whatever it slides along. */
const SKIN = 0.02;
/** How long it stands still, music playing, before it starts dancing (s):
 * a pause mid-walk isn't a dance. */
const DANCE_AFTER = 0.4;

/**
 * The player's herzie: a kinematic body moved by Rapier's character
 * controller, which handles collisions and sliding along visitors and
 * trees. Movement runs in the fixed physics step; the body's drawn position
 * is interpolated between steps by <Physics interpolate>.
 *
 * Controls: WASD walks relative to the camera (arrows turn it). Left-dragging only
 * looks around — the herzie keeps walking the way it was. Holding the right
 * button turns the herzie with the camera (and A/D then strafe); holding
 * both walks forward.
 */
export function Player({
  look,
  spawn,
  respawn = 0,
  bubble,
}: {
  /** What the player just said in chat, over their head. */
  bubble?: ChatBubble;
  look: Look;
  spawn: TownMap["spawn"];
  /** Bumped to put the player back at `spawn`. */
  respawn?: number;
}) {
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
  const herzie = useMemo(
    () => new HerzieModel(look, { lighting: ambient }),
    [look.seed, look.stage, equippedKey],
  );
  useEffect(() => {
    herzie.heading = townSave.heading;
    return () => herzie.dispose();
  }, [herzie]);
  // Gone from the world means standing still, as far as others can tell.
  useEffect(
    () => () => {
      townLive.speed = 0;
    },
    [],
  );

  const spawned = useRef(respawn);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on a bump
  useEffect(() => {
    if (spawned.current === respawn) return;
    spawned.current = respawn;
    const [x, z] = spawn.at;
    townLive.seat = null;
    Object.assign(townSave, { x, z, heading: spawn.heading });
    herzie.heading = spawn.heading;
    mover.current = { vx: 0, vz: 0, heading: spawn.heading };
    body.current?.setTranslation({ x, y: 0, z }, true);
    body.current?.setNextKinematicTranslation({ x, y: 0, z });
  }, [respawn]);

  useBeforePhysicsStep((w) => {
    const b = body.current;
    const col = collider.current;
    const kcc = controller.current;
    if (!b || !col || !kcc) return;
    const dt = w.timestep;
    const input = rt.input.current;
    const m = mover.current;
    if (input && Object.values(input).some(Boolean))
      townLive.lastInputAt = performance.now();

    // The town server refused a move (too fast, say): go back where it
    // last agreed the herzie was.
    const to = townLive.teleport;
    if (to) {
      townLive.teleport = null;
      townLive.seat = null;
      m.vx = m.vz = 0;
      b.setTranslation({ x: to.x, y: 0, z: to.z }, true);
      b.setNextKinematicTranslation({ x: to.x, y: 0, z: to.z });
      townSave.x = to.x;
      townSave.z = to.z;
      rt.playerSpeed = townLive.speed = 0;
      return;
    }
    // On a bench: stay put on the seat, facing out, until asked to stand
    // (E again) or walked off it.
    const seat = townLive.seat;
    if (seat) {
      const walking =
        !!input &&
        (input.forward ||
          input.back ||
          input.left ||
          input.right ||
          (input.mouseLeft && input.mouseRight));
      const standing = walking || townLive.standUp;
      if (standing) townLive.seat = null;
      townLive.standUp = false;
      const { x, z } = standing ? seat.stand : seat;
      m.vx = m.vz = 0;
      herzie.heading = m.heading = seat.heading;
      b.setNextKinematicTranslation({ x, y: 0, z });
      townSave.x = x;
      townSave.z = z;
      townSave.heading = seat.heading;
      rt.playerSpeed = townLive.speed = 0;
      return;
    }
    townLive.standUp = false;
    walkAz.current = walkAzimuth(walkAz.current, rt.cameraAzimuth, input);
    m.heading = herzie.heading;
    stepMover(m, input, walkAz.current, dt);
    herzie.heading = m.heading;

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
    townLive.speed = rt.playerSpeed;
    b.setNextKinematicTranslation({ x, y: p.y, z });
    townSave.x = x;
    townSave.z = z;
    townSave.heading = herzie.heading;
  });

  const stillFor = useRef(0);
  // Herzies grow legs at stage 3 (see HerzieModel).
  rt.playerLegs = look.stage >= 3;
  useFrame((_, dt) => {
    // Sitting: on the seat, not the ground.
    herzie.root.position.y = townLive.seat ? SEAT_Y : 0;
    herzie.sitting = !!townLive.seat;
    // Standing still to music: dance.
    stillFor.current = rt.playerSpeed > 0.05 ? 0 : stillFor.current + dt;
    townLive.dancing =
      townLive.music && !townLive.seat && stillFor.current >= DANCE_AFTER;
    herzie.dancing = townLive.dancing;
    herzie.update(dt, rt.playerSpeed);
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
        <primitive object={herzie.root} />
      </group>
      {bubble ? (
        <Html position={[0, herzie.height + 0.3, 0]} zIndexRange={[19, 0]}>
          <div className="-translate-x-1/2 -translate-y-full">
            <HeadBubble key={bubble.key} bubble={bubble} />
          </div>
        </Html>
      ) : null}
    </RigidBody>
  );
}
