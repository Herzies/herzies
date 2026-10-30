import { getHerzieStats, SH } from "@herzies/shared";
import { HerzieModel } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import {
  CapsuleCollider,
  type RapierCollider,
  type RapierRigidBody,
  RigidBody,
  useBeforePhysicsStep,
  useRapier,
} from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Look } from "../TownScene";
import { ambient } from "./ambient";
import { SEAT_Y } from "./Benches";
import type { ChatBubble } from "./chatBubbles";
import { discField } from "./combat/discs";
import { shoveFromBoss } from "./combat/fight";
import { combat } from "./combat/state";
import { applyDowned, downInRaid } from "./downed";
import { HeadBubble } from "./HeadBubble";
import { keepAtHome } from "./HomeLayer";
import { HomeShadow } from "./HomeShadow";
import { homeMode } from "./homeMode";
import type { TownInput } from "./input";
import { groundY, type TownMap } from "./map";
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
/** Nothing held: at Home the herzie stands, whatever's down (a key held
 * since before it came Home walks it once it's out). */
const stillInput: TownInput = {
  ...aimingInput,
  mouseRight: false,
};

/** The columns Home lays a herzie's props out against (HerzieWithSky: the
 * small window's width in its 3px cells), so its ground accessories stand
 * where Home stood them. */
const HOME_LAYOUT_COLS = Math.floor(380 / 3);

/** Spinning the herzie at Home with a drag, as Home always could: radians
 * per px dragged, and how much of a flick's speed is kept each 60fps
 * frame (as HerzieView). */
const SPIN_PER_PX = Math.PI / 200;
const SPIN_FRICTION = 0.92;

/** The keys as they are, with the mouse read as steering (combat mode). */
function aiming(input: TownInput): TownInput {
  return Object.assign(aimingInput, input, {
    mouseLeft: false,
    mouseRight: true,
  });
}

export function Player({
  map,
  look,
  spawn,
  respawn = 0,
  reach,
  bubble,
}: {
  /** The island it walks on: its ground's ups and downs. */
  map: TownMap;
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
  // Its gear's move speed (the Tailwind Cloak): no die can raise it
  // (noUpgrade), so the catalog's number off `equipped` is the whole of it.
  // Not its ground accessories': they stay Home (and the town server, which
  // checks the speed, never sees them).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const speedScale = useMemo(
    () =>
      1 +
      getHerzieStats(
        look.equipped && {
          ...look.equipped,
          ground_left: undefined,
          ground_right: undefined,
        },
      ).moveSpeed /
        100,
    [equippedKey],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const herzie = useMemo(
    () =>
      new HerzieModel(look, {
        lighting: ambient,
        // Its ground accessories (the boombox) set down as Home always set
        // them: in the corner of the small window's frame, standing still
        // while a drag spins the herzie (see setAccessoryHeading below).
        layoutCols: HOME_LAYOUT_COLS,
        layoutRows: SH,
        anchorGround: true,
      }),
    [look.seed, look.stage, equippedKey],
  );
  useEffect(() => {
    herzie.heading = townSave.heading;
    // Drawn at Home too, over the fading world (see HomeLayer).
    keepAtHome(herzie.root);
    herzie.setAccessories(homeMode.accessories);
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
    const y = groundY(map, x, z);
    body.current?.setTranslation({ x, y, z }, true);
    body.current?.setNextKinematicTranslation({ x, y, z });
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
    const input = homeMode.on
      ? stillInput
      : combat.on && raw
        ? aiming(raw)
        : raw;
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
      const y = groundY(map, to.x, to.z);
      b.setTranslation({ x: to.x, y, z: to.z }, true);
      b.setNextKinematicTranslation({ x: to.x, y, z: to.z });
      townSave.x = to.x;
      townSave.z = to.z;
      if (to.heading !== undefined) townSave.heading = m.heading = to.heading;
      rt.playerSpeed = townLive.speed = 0;
      return;
    }
    // Going through a portal: carried, not walking. Knocked out in a raid:
    // lying where it fell, for a Bard to find.
    if (townLive.frozen || downInRaid()) {
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
      // On the seat: its bench's ground; stood up: the ground there.
      const y = standing ? groundY(map, x, z) : seat.y;
      b.setNextKinematicTranslation({ x, y, z });
      townSave.x = x;
      townSave.z = z;
      townSave.heading = seat.heading;
      rt.playerSpeed = townLive.speed = 0;
      return;
    }
    townLive.standUp = false;
    walkAz.current = walkAzimuth(walkAz.current, rt.cameraAzimuth, input);
    m.heading = herzie.heading;
    stepMover(m, input, walkAz.current, dt, speedScale);
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
    // A roaming boss shoves you aside.
    ({ x, z } = shoveFromBoss(x, z));
    const r = Math.hypot(x, z);
    if (r > reach) {
      x = (x / r) * reach;
      z = (z / r) * reach;
    }
    // The walk cycle follows the distance actually covered: pushing into a
    // tree stops the feet too.
    rt.playerSpeed = Math.hypot(x - p.x, z - p.z) / dt;
    townLive.speed = rt.playerSpeed;
    // Over hill and dale: the body is always on the ground under it.
    b.setNextKinematicTranslation({ x, y: groundY(map, x, z), z });
    townSave.x = x;
    townSave.z = z;
    townSave.heading = herzie.heading;
  });

  const stillFor = useRef(0);
  const downed = useRef(0);

  // At Home, a drag spins the herzie where it stands (the view stays put),
  // with a flick's spin running on and slowing.
  const surface = useThree((s) => s.gl.domElement);
  const camera = useThree((s) => s.camera);
  const spin = useRef({ dragging: false, x: 0, velocity: 0, over: false });
  useEffect(() => {
    const sp = spin.current;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const sphere = new THREE.Sphere();
    /** Whether the pointer's over the herzie (it's what a drag spins, as on
     * Home): a grab cursor, and a press there isn't "outside" a window
     * open over Home (data-window-safe), which would close it. */
    const hover = (e: PointerEvent) => {
      let over = false;
      if (homeMode.on && homeMode.blend === 1) {
        const r = surface.getBoundingClientRect();
        ndc.set(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1,
        );
        ray.setFromCamera(ndc, camera);
        herzie.root.getWorldPosition(sphere.center);
        sphere.center.add(herzie.bounds.center);
        sphere.radius = herzie.bounds.radius * 0.8;
        over = ray.ray.intersectsSphere(sphere);
      }
      if (over === sp.over) return;
      sp.over = over;
      if (over) surface.dataset.windowSafe = "";
      else delete surface.dataset.windowSafe;
      if (!sp.dragging) surface.style.cursor = over ? "grab" : "";
    };
    const onDown = (e: PointerEvent) => {
      if (!homeMode.on || e.button !== 0 || !sp.over) return;
      sp.dragging = true;
      sp.x = e.clientX;
      sp.velocity = 0;
      surface.setPointerCapture(e.pointerId);
      surface.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!sp.dragging) {
        hover(e);
        return;
      }
      const dx = e.clientX - sp.x;
      sp.x = e.clientX;
      herzie.heading += dx * SPIN_PER_PX;
      sp.velocity = dx * SPIN_PER_PX;
    };
    const onUp = (e: PointerEvent) => {
      if (!sp.dragging) return;
      sp.dragging = false;
      if (surface.hasPointerCapture(e.pointerId))
        surface.releasePointerCapture(e.pointerId);
      surface.style.cursor = sp.over ? "grab" : "";
    };
    surface.addEventListener("pointerdown", onDown);
    surface.addEventListener("pointermove", onMove);
    surface.addEventListener("pointerup", onUp);
    surface.addEventListener("pointercancel", onUp);
    return () => {
      surface.removeEventListener("pointerdown", onDown);
      surface.removeEventListener("pointermove", onMove);
      surface.removeEventListener("pointerup", onUp);
      surface.removeEventListener("pointercancel", onUp);
      delete surface.dataset.windowSafe;
      surface.style.cursor = "";
    };
  }, [surface, herzie, camera]);
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
    // A flick, spinning on at Home.
    const sp = spin.current;
    if (sp.over && !homeMode.on) {
      sp.over = false;
      delete surface.dataset.windowSafe;
      surface.style.cursor = "";
    }
    if (!sp.dragging && sp.velocity !== 0) {
      if (!homeMode.on) sp.velocity = 0;
      herzie.heading += sp.velocity * dt * 60;
      sp.velocity *= SPIN_FRICTION ** (dt * 60);
      if (Math.abs(sp.velocity) < 0.0005) sp.velocity = 0;
    }
    // Its ground accessories (the boombox) are Home's: there, and gone as
    // it walks off.
    herzie.setAccessories(homeMode.accessories);
    // Set down facing Home's camera, as Home's own view faced them.
    herzie.setAccessoryHeading(homeMode.azimuth ?? herzie.heading);
    herzie.update(dt, rt.playerSpeed);
    downed.current = applyDowned(herzie, downInRaid(), downed.current, dt);
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
      position={[townSave.x, groundY(map, townSave.x, townSave.z), townSave.z]}
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
        <HomeShadow radius={Math.max(0.5, herzie.height * 0.42)} />
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
