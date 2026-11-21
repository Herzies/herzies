import {
  getHerzieStats,
  NAKATA_KEY,
  SH,
  type ShipIndex,
  TOWN_SPRINT_SPEED,
} from "@herzies/shared";
import { HerzieModel, WALK_SPEED } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
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
import {
  crossAboard,
  crossAshore,
  keepOnDeck,
  keepOnIsland,
  standY,
} from "./airship/boarding";
import { onDeck } from "./airship/deck";
import { fleet } from "./airship/fleet";
import { useShipFrame } from "./airship/frames";
import { ambient, seasonNow } from "./ambient";
import { SEAT_Y } from "./Benches";
import type { ChatBubble } from "./chatBubbles";
import { discField } from "./combat/discs";
import { shoveFromBoss } from "./combat/fight";
import { combat } from "./combat/state";
import { applyDowned, youDown } from "./downed";
import { fighterPace, poseFighter } from "./duel/fx";
import { duel, duelHeld } from "./duel/store";
import { emotePlayed, emoteRequest } from "./emotes";
import { HeadBubble } from "./HeadBubble";
import { keepAtHome } from "./HomeLayer";
import { HomeShadow } from "./HomeShadow";
import { homeMode } from "./homeMode";
import type { TownInput } from "./input";
import { groundY, petWalkable, type TownMap } from "./map";
import {
  ICE_GRIP,
  type Mover,
  onIce,
  stepMover,
  walkAzimuth,
} from "./movement";
import { NAME_SHADOW } from "./nameFade";
import { AFK_MS, townNet } from "./net/townNet";
import { warp, warpAmount } from "./portal";
import { arriving, townLive, townSave, useTownRuntime } from "./runtime";
import { titleName, WORN_TITLE_COLOUR } from "./TitleLine";
import { wildsHeld } from "./wilds/store";

/** The player's herzie as it last was: a new Player (another island's
 * physics, stepping on or off a sky ship) carries on from it when the step
 * across is seamless, rather than starting afresh. */
let lastPlayerHerzie: HerzieModel | null = null;

/** The capsule the controller pushes around: radius and half-height of its
 * straight part, standing on the ground. */
const RADIUS = 0.55;
const HALF_HEIGHT = 0.35;
/** Gap the controller keeps from whatever it slides along. */
const SKIN = 0.02;
/** The body's props, made once: a new array each render would have rapier
 * rebuild the collider (and set the body back where it started). */
const CAPSULE_ARGS: [number, number] = [HALF_HEIGHT, RADIUS];
const CAPSULE_AT: [number, number, number] = [
  0,
  HALF_HEIGHT + RADIUS + SKIN,
  0,
];
const NO_ROTATION: [boolean, boolean, boolean] = [false, false, false];
/** How long it stands still, music playing, before it starts dancing (s):
 * a pause mid-walk isn't a dance. */
const DANCE_AFTER = 0.4;
/** How long the walk to a duel's mark takes (ms). */
const GLIDE_MS = 400;

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

/** The keys as they are, less any that walk: turning (and aiming) only. */
const heldInput: TownInput = { ...stillInput };
function heldStill(input: TownInput): TownInput {
  return Object.assign(heldInput, input, {
    forward: false,
    back: false,
    left: false,
    right: false,
    mouseLeft: false,
  });
}

export function Player({
  map,
  look,
  spawn,
  respawn = 0,
  reach,
  bubble,
  deck = null,
  name,
  title,
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
  /** Aboard this sky ship: its physics are the deck's own (in the deck's
   * frame, at the scene's origin), and it's drawn on the ship, riding
   * through the sky with it. */
  deck?: ShipIndex | null;
  /** Your herzie's name, over its head (none: no label). */
  name?: string;
  /** The title you wear (a titles.ts id), over the name. */
  title?: string | null;
}) {
  const rt = useTownRuntime();
  const frame = useShipFrame(deck);
  // Where the body starts: where the save has it when it mounts (it moves
  // itself from then on; a respawn or a teleport puts it elsewhere) — on
  // a gangplank, partway up it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  const startAt = useMemo<[number, number, number]>(
    () => [townSave.x, standY(map, townSave.x, townSave.z), townSave.z],
    [],
  );
  const { world, rapier } = useRapier();
  /** The cat spirit's look ahead: is the way clear? (see petClear) */
  const petRay = useMemo(
    () => new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    [rapier],
  );
  const body = useRef<RapierRigidBody>(null);
  /** The Home visit its cat last came in for (see catToHome). */
  const catVisit = useRef(homeMode.visit);
  const collider = useRef<RapierCollider>(null);
  // Stepping on or off a ship, it carries on at the pace it was going.
  const mover = useRef<Mover>({
    vx: arriving.vx,
    vz: arriving.vz,
    heading: townSave.heading,
  });
  /** Where a step may take it: kept on the island (or a gangplank), or
   * aboard. */
  const kept = useRef({ x: 0, z: 0 });
  /** Whether it's on ice, and if it's pushing off, how fast its legs go:
   * as fast as they would on the ground (see movement.ts). */
  const ice = useRef({ on: false, pushing: false, stride: 0 });

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
  /** Where a glide to a duel's mark set off from (see townLive.glide). */
  const glideFrom = useRef({
    of: null as object | null,
    x: 0,
    z: 0,
    heading: 0,
  });
  /** Aboard: a marker on the body (where physics has it, in the deck's
   * frame) and what's drawn, which follows it on the ship. */
  const anchor = useRef<THREE.Group>(null);
  const visualRef = useRef<THREE.Group | null>(null);
  /** The island the save was on when this Player mounted (a map change
   * hands the save to the next one; see the step's first lines). */
  const mountedOn = useRef(townSave.map);

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
  // Rebuilt when its gear changes; the new one carries on from the last
  // (see carryOver), so putting a hat on doesn't reset it or its cat.
  const lastHerzie = useRef<HerzieModel | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const herzie = useMemo(() => {
    const next = new HerzieModel(look, {
      lighting: ambient,
      // Its ground accessories (the boombox) set down as Home always set
      // them: in the corner of the small window's frame, standing still
      // while a drag spins the herzie (see setAccessoryHeading below).
      layoutCols: HOME_LAYOUT_COLS,
      layoutRows: SH,
      anchorGround: true,
    });
    const last =
      lastHerzie.current ?? (arriving.seamless ? lastPlayerHerzie : null);
    if (last) {
      // In the space the last one was in, so what it carries over means
      // the same (the frame effect below moves it on to this one's).
      next.setFrame(last.frame);
      next.carryOver(last);
    }
    lastHerzie.current = next;
    lastPlayerHerzie = next;
    return next;
  }, [look.seed, look.stage, equippedKey]);
  // On a ship's deck its cat, companion and cloth live in the deck's
  // space (see HerzieModel.setFrame).
  useEffect(() => {
    herzie.setFrame(frame);
  }, [herzie, frame]);
  useEffect(() => {
    // Its cat spirit (if it has one) walks the same ground, round water —
    // or, on a deck, inside the rail.
    herzie.groundAt = (x, z) => groundY(map, x, z);
    const walkable = map.ship ? onDeck : petWalkable(map, reach);
    herzie.walkable = walkable;
    // Whether it can walk straight there: dry all the way, and nothing
    // solid (a wall, a tree, a stall) at a cat's height.
    const clear = (ax: number, az: number, bx: number, bz: number) => {
      const dx = bx - ax;
      const dz = bz - az;
      const d = Math.hypot(dx, dz);
      const n = Math.max(1, Math.ceil(d / 0.3));
      for (let i = 1; i <= n; i++) {
        if (!walkable(ax + (dx * i) / n, az + (dz * i) / n)) return false;
      }
      if (d < 1e-4) return true;
      petRay.origin.x = ax;
      petRay.origin.y = groundY(map, ax, az) + 0.3;
      petRay.origin.z = az;
      petRay.dir.x = dx / d;
      petRay.dir.y = 0;
      petRay.dir.z = dz / d;
      return !world.castRay(
        petRay,
        d,
        true,
        rapier.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        body.current ?? undefined,
      );
    };
    herzie.pathClear = clear;
    rt.petClear = clear;
    // And looks over at Nakata, who talks to cats, when it's near him.
    const nakata = map.spots[NAKATA_KEY];
    herzie.catGlanceAt = nakata
      ? new THREE.Vector3(
          nakata[0],
          groundY(map, nakata[0], nakata[1]) + 1.6,
          nakata[1],
        )
      : null;
    return () => {
      herzie.pathClear = null;
      if (rt.petClear === clear) rt.petClear = undefined;
    };
  }, [herzie, map, reach, world, rapier, petRay, rt]);
  useEffect(() => {
    herzie.heading = townSave.heading;
    // Drawn at Home too, over the fading world (see HomeLayer).
    keepAtHome(herzie.root);
    herzie.setAccessories(homeMode.accessories);
    rt.playerHerzie = herzie;
    return () => {
      if (rt.playerHerzie === herzie) rt.playerHerzie = null;
      // Freed after the next frame, unless it's been taken up again: the
      // Player that replaces this one (stepping aboard or ashore is a new
      // physics world, so a new Player) draws its herzie first, sharing
      // its shaders. Freed now, three would drop the shaders nothing
      // used any more and compile them all again for the new one — a
      // stall as the herzie crosses.
      requestAnimationFrame(() => {
        if (rt.playerHerzie !== herzie) herzie.dispose();
      });
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
    // Gone to another island (or onto a ship) since it mounted: the next
    // Player takes over as soon as it's up, and the save is already its —
    // this one stays put and keeps its hands off it.
    if (townSave.map !== mountedOn.current) return;
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
      const y = standY(map, to.x, to.z);
      b.setTranslation({ x: to.x, y, z: to.z }, true);
      b.setNextKinematicTranslation({ x: to.x, y, z: to.z });
      townSave.x = to.x;
      townSave.z = to.z;
      if (to.heading !== undefined) townSave.heading = m.heading = to.heading;
      rt.playerSpeed = townLive.speed = 0;
      return;
    }
    // Put on a duel's mark, or up or down a gangplank: walked there,
    // eased, turning to face the way it's going, rather than snapped.
    const glide = townLive.glide;
    if (glide) {
      const p = b.translation();
      const g = glideFrom.current;
      if (g.of !== glide)
        Object.assign(g, {
          of: glide,
          x: p.x,
          z: p.z,
          heading: herzie.heading,
        });
      const t = Math.min(
        1,
        (performance.now() - glide.from) / (glide.ms ?? GLIDE_MS),
      );
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const x = g.x + (glide.x - g.x) * e;
      const z = g.z + (glide.z - g.z) * e;
      const turn = glide.heading - g.heading;
      townLive.seat = null;
      m.vx = m.vz = 0;
      herzie.heading = m.heading =
        g.heading + Math.atan2(Math.sin(turn), Math.cos(turn)) * e;
      rt.playerSpeed = townLive.speed = Math.hypot(x - p.x, z - p.z) / dt;
      b.setNextKinematicTranslation({ x, y: standY(map, x, z), z });
      townSave.x = x;
      townSave.z = z;
      townSave.heading = herzie.heading;
      if (t >= 1) {
        townLive.glide = null;
        glide.after?.();
      }
      return;
    }
    // Going through a portal: carried, not walking. Knocked out (anywhere:
    // out of health, or taken down in the Wilds): lying where it fell, not
    // even turning. Winding up a Rimshot: planted where it stands.
    if (
      townLive.frozen ||
      youDown() ||
      performance.now() < combat.rootedUntil
    ) {
      m.vx = m.vz = 0;
      rt.playerSpeed = townLive.speed = 0;
      return;
    }
    // Going Home stands it up off its bench, as the camera swings round:
    // Home has no bench to sit on.
    if (homeMode.on && townLive.seat) townLive.standUp = true;
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
    // The camera's azimuth is the sky's; aboard, walking is in the deck's
    // frame, turned by the ship's heading.
    const cameraAz =
      deck === null
        ? rt.cameraAzimuth
        : rt.cameraAzimuth - fleet.poses[deck].yaw;
    walkAz.current = walkAzimuth(walkAz.current, cameraAz, input);
    m.heading = herzie.heading;
    // A duel's countdown, or stunned in one (or in the Wilds): held on the
    // spot, still free to turn (and aim).
    if (duelHeld() || wildsHeld()) {
      stepMover(m, heldStill(input), walkAz.current, dt, speedScale);
      m.vx = m.vz = 0;
      herzie.heading = m.heading;
      townSave.heading = herzie.heading;
      rt.playerSpeed = townLive.speed = 0;
      return;
    }
    // On ice: slippery — its legs go as fast as ever as it pushes off,
    // but it gets less far for them, and glides when it stops.
    const here = b.translation();
    const iced = onIce(map, here.x, here.z, seasonNow.look.ice);
    ice.current.on = iced;
    ice.current.pushing =
      input.forward ||
      input.back ||
      input.left ||
      input.right ||
      (input.mouseLeft && input.mouseRight);
    ice.current.stride =
      (input.sprint ? TOWN_SPRINT_SPEED : WALK_SPEED) * speedScale;
    stepMover(m, input, walkAz.current, dt, speedScale, iced ? ICE_GRIP : 1);
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
    // On the island (and a moored ship's gangplank), or on deck.
    ({ x, z } =
      deck === null
        ? keepOnIsland(map, reach, p.x, p.z, x, z, kept.current)
        : keepOnDeck(deck, p.x, p.z, x, z, kept.current));
    // The walk cycle follows the distance actually covered: pushing into a
    // tree stops the feet too.
    rt.playerSpeed = Math.hypot(x - p.x, z - p.z) / dt;
    townLive.speed = rt.playerSpeed;
    // Over hill and dale (and up a gangplank): the body is always on what's
    // under it.
    b.setNextKinematicTranslation({ x, y: standY(map, x, z), z });
    townSave.x = x;
    townSave.z = z;
    townSave.heading = herzie.heading;
    // Through a ship's gangway: aboard, or ashore.
    if (deck === null) crossAboard(map, m);
    else crossAshore(deck, m);
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
  rt.playerFootSpread = herzie.footSpread;
  useFrame((_, dt) => {
    // Knocked out: lying where it fell (see downed), off the floor's seat
    // too, and nothing it does until it's back up.
    const down = youDown();
    if (down) herzie.floorSit = false;
    // Sitting: on the seat, not the ground.
    herzie.root.position.y = townLive.seat ? SEAT_Y : 0;
    herzie.sitting = !!townLive.seat;
    // Standing still to music: dance.
    stillFor.current = rt.playerSpeed > 0.05 ? 0 : stillFor.current + dt;
    townLive.dancing =
      townLive.music &&
      !down &&
      !townLive.seat &&
      !herzie.floorSit &&
      stillFor.current >= DANCE_AFTER;
    herzie.dancing = townLive.dancing;
    // Space: hop, unless it's seated, knocked out or being carried through
    // a portal. The body jumps; the walk goes on under it, steered as ever.
    const raw = rt.input.current;
    if (raw?.jump) {
      raw.jump = false;
      townLive.lastInputAt = performance.now();
      if (
        !down &&
        !townLive.seat &&
        !townLive.frozen &&
        performance.now() >= combat.rootedUntil &&
        !duelHeld() &&
        !wildsHeld()
      )
        herzie.jump();
    }
    // An emote from the Alt bar: played here and sent to the room. Not
    // mid-fight (combat mode), carried through a portal or knocked out.
    const emote = emoteRequest.id;
    if (emote) {
      emoteRequest.id = null;
      townLive.lastInputAt = performance.now();
      if (!combat.on && !down && !townLive.frozen && herzie.emote(emote)) {
        emotePlayed(emote);
        townNet().sendEmote(emote);
      }
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
    // Its cat spirit (if it has one) curls up when the player's away.
    herzie.afk = performance.now() - townLive.lastInputAt > AFK_MS;
    // And at Home it comes in the same way each time: out, back in behind
    // the herzie (away from the camera), up on the boombox or down beside.
    herzie.homeFacing = homeMode.on
      ? (homeMode.azimuth ?? herzie.heading)
      : null;
    if (homeMode.visit !== catVisit.current) {
      catVisit.current = homeMode.visit;
      if (homeMode.on) herzie.catToHome();
    }
    // A duel's hit-stop and finishing slow-down hold its pose, not the
    // world.
    herzie.update(
      dt * fighterPace(duel.you, performance.now()),
      ice.current.on
        ? ice.current.pushing
          ? ice.current.stride
          : 0
        : rt.playerSpeed,
    );
    downed.current = applyDowned(herzie, down, downed.current, dt);
    // A duel's blows and its end, on your herzie (see duel/fx).
    poseFighter(herzie, duel.you, performance.now(), dt);
    townLive.jumps = herzie.jumps;
    // Through a portal: spun down into the disc, and back up out of the
    // far one. Through a door, just walked through.
    const k = warp.door ? 0 : warpAmount();
    herzie.root.scale.setScalar(1 - 0.85 * k);
    herzie.root.rotation.y = k * k * Math.PI * 4;
  });

  const wornTitle = titleName(title);

  // Aboard, what's drawn rides on the ship: kept where the body is, in the
  // deck's frame (the body is at the scene's origin, in the deck's own
  // coordinates, interpolated by now; the camera reads it at -2).
  useFrame(() => {
    const a = anchor.current;
    const v = visualRef.current;
    if (!frame || !a || !v) return;
    a.getWorldPosition(v.position);
  }, -2.5);

  const visual = (
    <group
      ref={(g) => {
        rt.playerBody = g;
        visualRef.current = g;
      }}
    >
      <primitive object={herzie.root} />
      <HomeShadow radius={Math.max(0.5, herzie.height * 0.42)} />
      {/* The title you wear and your own name under it, as everyone
          else's reads (RemotePlayers) — always full: you're never far from
          yourself. What you just said stacks over them. */}
      <Html position={[0, herzie.height + 0.3, 0]} zIndexRange={[19, 0]}>
        <div className="pointer-events-none flex -translate-x-1/2 -translate-y-full flex-col items-center">
          {bubble ? <HeadBubble key={bubble.key} bubble={bubble} /> : null}
          {wornTitle ? (
            <div
              className="whitespace-nowrap text-[9px] font-medium leading-tight"
              style={{ color: WORN_TITLE_COLOUR, textShadow: NAME_SHADOW }}
            >
              {wornTitle}
            </div>
          ) : null}
          {name ? (
            <div
              className="whitespace-nowrap text-[11px] font-medium leading-tight text-white"
              style={{ textShadow: NAME_SHADOW }}
            >
              {name}
            </div>
          ) : null}
        </div>
      </Html>
    </group>
  );
  const physical = (
    <RigidBody
      ref={(b) => {
        body.current = b;
        rt.playerRigidBody = b;
      }}
      type="kinematicPosition"
      colliders={false}
      position={startAt}
      enabledRotations={NO_ROTATION}
    >
      <CapsuleCollider
        ref={collider}
        args={CAPSULE_ARGS}
        position={CAPSULE_AT}
      />
      {frame ? <group ref={anchor} /> : visual}
    </RigidBody>
  );
  return frame ? (
    <>
      {physical}
      {createPortal(visual, frame)}
    </>
  ) : (
    physical
  );
}
