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
import { discField } from "./combat/discs";
import { combat } from "./combat/state";
import { HeadBubble } from "./HeadBubble";
import type { TownInput } from "./input";
import type { TownMap } from "./map";
import { type Mover, stepMover, walkAzimuth } from "./movement";
import { warpAmount } from "./portal";
import { townLive, townSave, useTownRuntime } from "./runtime";

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
const aimingInput: TownInput = {
  forward: false,
  back: false,
  left: false,
  right: false,
  turnLeft: false,
  turnRight: false,
  tiltUp: false,
  tiltDown: false,
  sprint: false,
  mouseLeft: false,
  mouseRight: true,
  jump: false,
};
/** The keys as they are, with the mouse read as steering (combat mode). */
function aiming(input: TownInput): TownInput {
  return Object.assign(aimingInput, input, {
    mouseLeft: false,
    mouseRight: true,
  });
}

export function Player({
  look,
  spawn,
  respawn = 0,
  reach,
  bubble,
}: {
  /** How far from the island's middle it can walk. */
  reach: number;
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
    rt.playerHerzie = herzie;
    return () => {
      if (rt.playerHerzie === herzie) rt.playerHerzie = null;
      herzie.dispose();
    };
  }, [herzie, rt]);
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
    Object.assign(townSave, {
      x,
      z,
      heading: spawn.heading,
      azimuth: spawn.heading - Math.PI,
      arrival: townSave.arrival + 1,
    });
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
    // In combat the herzie faces where the camera looks and strafes, as
    // with the right button held; the left button casts rather than looks.
    const raw = rt.input.current;
    const input = combat.on && raw ? aiming(raw) : raw;
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
      if (to.heading !== undefined) townSave.heading = m.heading = to.heading;
      rt.playerSpeed = townLive.speed = 0;
      return;
    }
    // Going through a portal: carried, not walking.
    if (townLive.frozen) {
      m.vx = m.vz = 0;
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
    if (r > reach) {
      x = (x / r) * reach;
      z = (z / r) * reach;
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
    // Space: hop, unless it's seated or being carried through a portal. The
    // body jumps; the walk goes on under it, steered as ever.
    const raw = rt.input.current;
    if (raw?.jump) {
      raw.jump = false;
      townLive.lastInputAt = performance.now();
      if (!townLive.seat && !townLive.frozen) herzie.jump();
    }
    // Aiming: gear off its back and in hand — and kept there while a disc
    // it threw is still on its way back to it.
    herzie.armed =
      combat.on ||
      discField.isOut(herzie, "held-l") ||
      discField.isOut(herzie, "held-r");
    herzie.update(dt, rt.playerSpeed);
    townLive.jumps = herzie.jumps;
    // Through a portal: spun down into the disc, and back up out of the
    // far one.
    const k = warpAmount();
    herzie.root.scale.setScalar(1 - 0.85 * k);
    herzie.root.rotation.y = k * k * Math.PI * 4;
  });

  return (
    <RigidBody
      ref={(b) => {
        body.current = b;
        rt.playerRigidBody = b;
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
