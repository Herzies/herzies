import { RARITY_COLORS } from "@herzies/shared";
import type { HerzieModel } from "@herzies/shared/gl";
import { useFrame, useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import * as THREE from "three";
import {
  type Drop,
  DropView,
  releaseDrops,
  useDropLoop,
} from "./combat/LootDrops";
import { LOOT, lootItem, tierOf } from "./combat/loot";
import {
  type DropSpot,
  HOME_DROPS,
  homeDropFeed,
  loadSpots,
  placeDrop,
  saveSpots,
  type Vec2,
} from "./dropSpots";
import { HOME_LAYER } from "./HomeLayer";
import { HomeShadow } from "./HomeShadow";
import { homeAzimuth } from "./homeCamera";
import { homeMode } from "./homeMode";
import {
  cellAt,
  groundY,
  inland,
  isSunk,
  objectAt,
  type TownMap,
  terrainAt,
  worldRadius,
} from "./map";
import { townSave, useTownRuntime } from "./runtime";
import { sfxRiftClose, sfxRiftEject, sfxRiftOpen, sfxRiftWork } from "./sfx";
import { RIFT, type Rift, RiftView, riftEndsAt, riftWorkMs } from "./vfx/Rifts";

/** How much of the picture (normalised device coordinates) a drop may land
 * in: in from the sides, below the player card, above what's playing. */
const VIEW = { x: 0.78, top: 0.42, bottom: -0.62 } as const;
const scratchNdc = new THREE.Vector3();
/** In the big window, where Home's cards are (NDC): drops keep left of
 * neither's corner (see HomeView's `big`). */
const BIG_CARD = { x: -0.55, y: 0.1 } as const;
const BIG_CHAT = { x: -0.2, y: -0.4 } as const;
const scratchProp = new THREE.Vector3();
const scratchEdge = new THREE.Vector3();
const scratchScreen = new THREE.Vector2();
const scratchHit = new THREE.Vector3();
const scratchNear = new THREE.Vector3();
const scratchBox = new THREE.Box3();
/** The ground under the herzie, flat (its constant set to the feet). */
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const scratchRight = new THREE.Vector3();

/** Where the herzie and its boombox are on screen (NDC boxes: middle and
 * half-size, with room to spare), for drops to keep clear of. */
function screenClear(
  herzie: HerzieModel | null,
  camera: THREE.Camera,
): { x: number; y: number; w: number; h: number }[] {
  if (!herzie) return [];
  const out: { x: number; y: number; w: number; h: number }[] = [];
  scratchRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  // Half its width and half its height (world units), round `centre`.
  const box = (centre: THREE.Vector3, wide: number, tall: number) => {
    const c = centre.clone().project(camera);
    const e = scratchEdge
      .copy(centre)
      .addScaledVector(scratchRight, wide)
      .project(camera);
    const w = Math.abs(e.x - c.x);
    // NDC is stretched across a narrow window: as tall in px as wide.
    const aspect = (camera as THREE.PerspectiveCamera).aspect || 1;
    out.push({
      x: c.x,
      y: c.y,
      w: w + 0.06,
      h: w * aspect * (tall / wide) + 0.06,
    });
  };
  const at = herzie.root.getWorldPosition(scratchProp);
  box(
    at.clone().setY(at.y + herzie.height / 2),
    herzie.height * 0.3,
    herzie.height * 0.55,
  );
  // The boombox: its box's corners, as they land on screen.
  const prop = herzie.accessoryWorldBox(scratchBox);
  if (prop) {
    let x0 = 1;
    let x1 = -1;
    let y0 = 1;
    let y1 = -1;
    for (let i = 0; i < 8; i++) {
      const p = scratchEdge
        .set(
          i & 1 ? prop.max.x : prop.min.x,
          i & 2 ? prop.max.y : prop.min.y,
          i & 4 ? prop.max.z : prop.min.z,
        )
        .project(camera);
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    out.push({
      x: (x0 + x1) / 2,
      y: (y0 + y1) / 2,
      w: (x1 - x0) / 2 + 0.08,
      h: (y1 - y0) / 2 + 0.1,
    });
  }
  return out;
}

/** What a drop can lie on: nothing, or the low things it'd lie among. */
const OPEN_GROUND = new Set([".", "v", "*", "m"]);

/**
 * What drops while you listen, lying on the ground around you in the Town
 * — the same drops Home always showed, now where your herzie is.
 *
 * Each arrives out of a little black hole (vfx/Rifts) that opens in the air
 * near you, works away for a moment, lets go of what it picked, and closes.
 * It lands far enough off that standing still doesn't pick it up: walk
 * over to it, or wear a spirit to fetch it (the same pickups as the boss's
 * loot: LootDrops). Each is remembered where it lies (dropSpots), so it's
 * still there next time; one left on another island, or far off, is
 * brought to you again when you go Home. One taken some other way (the
 * server's spirit, while the app was hidden) is drawn back into a hole.
 *
 * Only on islands you don't fight on: the cave's and the Tower's loot is
 * their own (LootDrops), and listening drops wait until you're out.
 */
export function HomeDrops({ map }: { map: TownMap }) {
  const rt = useTownRuntime();
  const { world, rapier } = useRapier();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const s = useRef({
    /** The drops in the world, by drop id. */
    live: new Map<string, Drop>(),
    /** The same, as a list for the loop (rebuilt when it changes). */
    list: [] as Drop[],
    rifts: [] as Rift[],
    /** Waiting to be summoned, in order. */
    queue: [] as { id: string; itemId: string }[],
    queued: new Set<string>(),
    spots: loadSpots(),
    seenVersion: -1,
    /** The visit, and the ground as it was, when what's out of Home's
     * picture was last brought into it. */
    passVisit: -1,
    passVersion: -1,
    /** Every drop seen on the ground this session: a spot is only forgotten
     * once its drop was seen and is gone (the app starts with an empty
     * ground until its first sync, which mustn't wipe them all). */
    seen: new Set<string>(),
    /** The spots changed since they were last saved. */
    spotsDirty: false,
    lastReconcile: 0,
    nextSummonAt: 0,
    /** Drawn on Home's layer alone (the world fading under it), or the
     * world's: what the groups below were last put on. */
    overlay: null as boolean | null,
    groups: new Set<THREE.Object3D>(),
    /** The work hums still going, by rift. */
    hums: new Map<string, { stop: () => void }>(),
    keySeq: 0,
  });

  useDropLoop(() => s.current.list);

  // Leaving the island (a new physics world): stop the hums, call the
  // spirit back.
  useEffect(() => {
    const st = s.current;
    return () => {
      releaseDrops(st.list, rt.playerHerzie);
      for (const h of st.hums.values()) h.stop();
      st.hums.clear();
    };
  }, [rt]);

  /** Whether a drop can lie at (x, z): on the island, on dry, flat ground,
   * with nothing standing there. */
  const groundOk = useCallback(
    (x: number, z: number): boolean => {
      if (Math.hypot(x, z) > worldRadius(map) - 1.5) return false;
      const [col, row] = cellAt(map, x, z);
      if (!inland(map, col, row)) return false;
      if (isSunk(terrainAt(map, col, row))) return false;
      if (!OPEN_GROUND.has(objectAt(map, col, row))) return false;
      const y = groundY(map, x, z);
      for (const [dx, dz] of [
        [0.5, 0],
        [-0.5, 0],
        [0, 0.5],
        [0, -0.5],
      ])
        if (Math.abs(groundY(map, x + dx, z + dz) - y) > 0.45) return false;
      // Nothing solid there (a wall, a bench, a lamp post).
      const hit = world.intersectionWithShape(
        { x, y: y + 0.75, z },
        { x: 0, y: 0, z: 0, w: 1 },
        new rapier.Ball(0.5),
        rapier.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        rt.playerRigidBody ?? undefined,
      );
      return hit === null;
    },
    [map, world, rapier, rt],
  );

  // Where it lands must be in the picture, too: clear of the window's edges,
  // of Home's cards (the player card up top, what's playing below), and of
  // the herzie itself.
  const camera = useThree((state) => state.camera);
  const spotOk = useCallback(
    (x: number, z: number): boolean => {
      if (!groundOk(x, z)) return false;
      const y = groundY(map, x, z);
      // In the picture, and not hidden behind (or sat on) the herzie or its
      // boombox there.
      const clear = screenClear(rt.playerHerzie, camera);
      for (const h of [0.2, LOOT.hover, LOOT.hover + 0.5]) {
        const p = scratchNdc.set(x, y + h, z).project(camera);
        if (
          p.z > 1 ||
          Math.abs(p.x) > VIEW.x ||
          p.y < VIEW.bottom ||
          p.y > VIEW.top
        )
          return false;
        for (const c of clear)
          if (Math.abs(p.x - c.x) < c.w && Math.abs(p.y - c.y) < c.h)
            return false;
        // At Home, a little behind the herzie: up close or level with
        // it, they'd loom (the lens is wide at the edges).
        if (homeMode.on) {
          const herzie = rt.playerHerzie;
          if (herzie) {
            const there = herzie.root.getWorldPosition(scratchEdge);
            const toHerzie = camera.position.distanceTo(there);
            if (
              camera.position.distanceTo(scratchNear.set(x, y + h, z)) <
              toHerzie * 1.15
            )
              return false;
          }
        }
        // The big window's column of cards: the player card up top, the
        // chat at the bottom, both at the left.
        if (homeMode.on && homeMode.frame?.big) {
          if (p.x < BIG_CARD.x && p.y > BIG_CARD.y) return false;
          if (p.x < BIG_CHAT.x && p.y < BIG_CHAT.y) return false;
        }
      }
      // Apart on screen too, not just on the ground (one far behind
      // another would hide it).
      const at = scratchNdc.set(x, y + LOOT.hover, z).project(camera);
      const ax = at.x;
      const ay = at.y;
      for (const d of s.current.live.values()) {
        const o = scratchEdge
          .set(d.spot.x, d.ground + LOOT.hover, d.spot.z)
          .project(camera);
        if (Math.abs(o.x - ax) < 0.18 && Math.abs(o.y - ay) < 0.17)
          return false;
      }
      return true;
    },
    [groundOk, map, camera, rt],
  );

  // Where the next one lands. At Home, settled, the picture is narrow and
  // mostly herzie: a spot's picked on screen — anywhere there's open
  // ground to see, out to the sides and back — and found on the ground
  // under it, so they spread across what's in view. Out walking, round the
  // herzie beyond it from the camera (placeDrop).
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const place = useCallback(
    (player: Vec2, away: number): Vec2 | null => {
      if (homeMode.on && homeMode.blend === 1) {
        const feet = rt.playerHerzie?.root.getWorldPosition(scratchProp).y ?? 0;
        plane.constant = -feet;
        for (let i = 0; i < 96; i++) {
          scratchScreen.set(
            (Math.random() * 2 - 1) * VIEW.x,
            VIEW.bottom + Math.random() * (VIEW.top - VIEW.bottom),
          );
          raycaster.setFromCamera(scratchScreen, camera);
          const hit = raycaster.ray.intersectPlane(plane, scratchHit);
          if (!hit) continue;
          const d = Math.hypot(hit.x - player.x, hit.z - player.z);
          if (d < HOME_DROPS.near || d > HOME_DROPS.widest) continue;
          // A slope makes the ground there higher or lower than the plane.
          if (Math.abs(groundY(map, hit.x, hit.z) - feet) > 0.6) continue;
          if (spotOk(hit.x, hit.z)) return { x: hit.x, z: hit.z };
        }
      }
      const taken = [...s.current.live.values()].map((d) => d.spot);
      return (
        placeDrop({ player, away, taken, ok: spotOk }) ??
        // No room left in the picture (the ground's whole cap of ten, round
        // a herzie standing in a corner): it still lands, just out of
        // shot, rather than waiting for room that won't come.
        placeDrop({ player, away, taken, ok: groundOk })
      );
    },
    [camera, raycaster, map, rt, spotOk, groundOk],
  );

  /** Whether a drop's in the picture (loosely: anywhere on screen). */
  const inPicture = useCallback(
    (d: Drop): boolean => {
      const p = scratchNdc
        .set(d.spot.x, d.ground + LOOT.hover, d.spot.z)
        .project(camera);
      return p.z <= 1 && Math.abs(p.x) <= 0.95 && Math.abs(p.y) <= 0.95;
    },
    [camera],
  );

  useFrame(() => {
    const st = s.current;
    const now = performance.now();
    const herzie = rt.playerHerzie;
    if (!herzie) return;
    const player: Vec2 = { x: townSave.x, z: townSave.z };
    // Seen from where: Home's camera at Home (in front of the herzie),
    // else the one behind it. Drops land beyond the herzie from it.
    const away = homeMode.on
      ? (homeMode.azimuth ?? homeAzimuth(herzie.heading)) + Math.PI
      : rt.cameraAzimuth + Math.PI;
    let changed = false;

    const pending = homeDropFeed.drops;
    const pendingIds = new Set(pending.map((d) => d.id));

    // What's on the ground, against what's drawn.
    if (
      st.seenVersion !== homeDropFeed.version ||
      now - st.lastReconcile > 1_000
    ) {
      st.seenVersion = homeDropFeed.version;
      st.lastReconcile = now;
      for (const p of pending) {
        const d = st.live.get(p.id);
        if (d) {
          // Picked up, but it's still there (the bag refused it, or the
          // pickup failed): back on the ground where it was.
          if (d.phase === "done" && d.collecting && now - d.since > 1_500) {
            dropDrop(st, p.id);
            restDrop(st, p.id, p.itemId, d.spot, map, now);
            changed = true;
          }
          continue;
        }
        if (st.queued.has(p.id)) continue;
        const spot = st.spots.get(p.id);
        if (!spot) enqueue(st, p.id, p.itemId);
        else if (spot.map === map.id) {
          restDrop(st, p.id, p.itemId, spot, map, now);
          changed = true;
        } else if (homeMode.on) enqueue(st, p.id, p.itemId);
      }
      // Gone from the ground some other way: drawn back into a hole. One
      // we picked up ourselves just goes.
      for (const [id, d] of st.live) {
        if (pendingIds.has(id)) continue;
        if (d.collecting || d.phase === "done") {
          if (d.phase === "done" && now - d.since > 600) {
            dropDrop(st, id);
            changed = true;
          }
          continue;
        }
        if (d.phase === "vanishing") continue;
        if (d.phase === "waiting" || d.phase === "flying") {
          // Still on its way out: the hole takes it back unseen.
          dropDrop(st, id);
          changed = true;
          continue;
        }
        vanish(st, d, now);
        changed = true;
      }
      // Queued, but gone meanwhile.
      st.queue = st.queue.filter((q) => {
        if (pendingIds.has(q.id)) return true;
        st.queued.delete(q.id);
        return false;
      });
      // Spots of drops that were on the ground and aren't any more.
      for (const id of pendingIds) st.seen.add(id);
      for (const id of st.spots.keys()) {
        if (st.seen.has(id) && !pendingIds.has(id)) {
          st.spots.delete(id);
          st.spotsDirty = true;
        }
      }
    }

    // At Home, settled: whatever's lying out of the picture (on another
    // island, back where you were, off to a side) is brought into it —
    // gone from where nobody can see it, and summoned again near you. Once
    // a visit, and again whenever the ground changes.
    if (
      homeMode.on &&
      homeMode.blend === 1 &&
      (st.passVisit !== homeMode.visit ||
        st.passVersion !== homeDropFeed.version)
    ) {
      st.passVisit = homeMode.visit;
      st.passVersion = homeDropFeed.version;
      for (const [id, d] of st.live) {
        if (d.phase !== "resting" || inPicture(d)) continue;
        dropDrop(st, id);
        enqueue(st, id, d.item.id);
        changed = true;
      }
      for (const p of pending) {
        const spot = st.spots.get(p.id);
        if (spot && spot.map !== map.id && !st.live.has(p.id))
          enqueue(st, p.id, p.itemId);
      }
    }

    if (st.spotsDirty) {
      st.spotsDirty = false;
      saveSpots(st.spots);
    }

    // One at a time, a beat apart — and never while the camera's swinging
    // to or from Home (they'd land out of the picture it ends on).
    const settled = homeMode.blend === 0 || homeMode.blend === 1;
    if (st.queue.length > 0 && settled && now >= st.nextSummonAt) {
      const next = st.queue[0];
      if (
        summon(st, next.id, next.itemId, player, place(player, away), map, now)
      ) {
        st.queue.shift();
        st.queued.delete(next.id);
        st.nextSummonAt = now + HOME_DROPS.staggerMs;
        changed = true;
      } else {
        // Nowhere to put it yet: try again in a moment.
        st.nextSummonAt = now + 1_000;
      }
    }

    // The holes: their sounds on cue, and gone when they're done.
    for (const r of st.rifts) {
      const hum = st.hums.get(r.key);
      if (!r.vanish && now >= r.ejectAt && hum) {
        st.hums.delete(r.key);
        sfxRiftEject(r.tier);
      }
      if (now >= r.closeAt && !closed.has(r)) {
        closed.add(r);
        sfxRiftClose();
      }
    }
    const before = st.rifts.length;
    st.rifts = st.rifts.filter((r) => now < riftEndsAt(r));
    if (st.rifts.length !== before) changed = true;
    // Vanished ones, gone for good.
    for (const [id, d] of st.live) {
      if (d.phase === "done" && !d.collecting && now - d.since > 200) {
        dropDrop(st, id);
        changed = true;
      }
    }

    // Over the fading world on the way Home, everything here is drawn on
    // Home's layer alone (drawing its glows twice would double them).
    const overlay = homeMode.overlay;
    if (overlay !== st.overlay) {
      st.overlay = overlay;
      for (const g of st.groups) putOnLayer(g, overlay);
    }

    if (changed) {
      st.list = [...st.live.values()];
      rerender();
    }
  });

  const st = s.current;
  const track = useCallback(
    (g: THREE.Object3D | null, was?: THREE.Object3D | null) => {
      const groups = s.current.groups;
      if (was) groups.delete(was);
      if (g) {
        groups.add(g);
        putOnLayer(g, s.current.overlay ?? homeMode.overlay);
      }
    },
    [],
  );

  return (
    <>
      {st.list.map((d) => (
        <HomeDropView key={d.key} drop={d} track={track} />
      ))}
      {st.rifts.map((r) => (
        <TrackedRift key={r.key} rift={r} track={track} />
      ))}
    </>
  );
}

type State = {
  live: Map<string, Drop>;
  rifts: Rift[];
  queue: { id: string; itemId: string }[];
  queued: Set<string>;
  spots: Map<string, DropSpot>;
  spotsDirty: boolean;
  hums: Map<string, { stop: () => void }>;
  keySeq: number;
};

/** Rifts whose closing sound has played. */
const closed = new WeakSet<Rift>();

function enqueue(st: State, id: string, itemId: string) {
  if (st.queued.has(id)) return;
  st.queued.add(id);
  st.queue.push({ id, itemId });
}

function dropDrop(st: State, id: string) {
  const d = st.live.get(id);
  if (!d) return;
  d.hum?.stop();
  d.hum = null;
  st.live.delete(id);
}

/** A new drop, as LootDrops runs them. */
function makeDrop(
  st: State,
  dropId: string,
  itemId: string,
  spot: Vec2,
  ground: number,
): Drop | null {
  const item = lootItem(itemId);
  if (!item) return null;
  return {
    key: `${dropId}:${st.keySeq++}`,
    dropId,
    item,
    tier: tierOf(item.rarity),
    color: RARITY_COLORS[item.rarity],
    spot,
    ejectAt: Number.NaN,
    order: 0,
    here: true,
    home: true,
    origin: { x: spot.x, y: 0, z: spot.z },
    apex: 0.5,
    ground,
    phase: "waiting",
    since: 0,
    restedAt: 0,
    pos: new THREE.Vector3(),
    from: new THREE.Vector3(),
    fetch: null,
    fetchAt: 0,
    spin: Math.random() * Math.PI * 2,
    hum: null,
    view: {
      group: null,
      model: null,
      pillar: null,
      ring: null,
      dust: null,
      sparkles: null,
      label: null,
    },
  };
}

/** A drop that's already lying there: no arrival, just there. */
function restDrop(
  st: State,
  id: string,
  itemId: string,
  spot: Vec2,
  map: TownMap,
  now: number,
) {
  const d = makeDrop(st, id, itemId, spot, groundY(map, spot.x, spot.z));
  if (!d) return;
  d.phase = "resting";
  // Past its landing bounces: hovering, already lit.
  d.since = now - 2_000;
  d.restedAt = now - 2_000;
  d.pos.set(spot.x, d.ground + LOOT.hover, spot.z);
  st.live.set(id, d);
}

/**
 * A drop arriving: a spot picked for it near you, a hole opened above it,
 * and the drop let go of when the hole's done working (LootDrops flies it
 * from there onto its spot). False if there's nowhere to put it yet.
 */
function summon(
  st: State,
  id: string,
  itemId: string,
  player: Vec2,
  /** Where it lands (null: nowhere yet). */
  spot: Vec2 | null,
  map: TownMap,
  now: number,
): boolean {
  const item = lootItem(itemId);
  if (!item) {
    // A build that doesn't know it: nothing to show (Home's bag will).
    return true;
  }
  if (!spot) return false;
  const ground = groundY(map, spot.x, spot.z);
  const d = makeDrop(st, id, itemId, spot, ground);
  if (!d) return true;
  // The hole hangs above, a little further from you than where it lands,
  // so what it lets go of falls toward you.
  const dx = spot.x - player.x;
  const dz = spot.z - player.z;
  const len = Math.hypot(dx, dz) || 1;
  const hx = spot.x + (dx / len) * 0.55;
  const hz = spot.z + (dz / len) * 0.55;
  const tier = d.tier;
  const openAt = now;
  const ejectAt = openAt + RIFT.openMs + riftWorkMs(tier);
  const rift: Rift = {
    key: `rift:${id}:${st.keySeq++}`,
    at: new THREE.Vector3(hx, ground + RIFT.height, hz),
    tier,
    color: new THREE.Color(d.color),
    openAt,
    ejectAt,
    closeAt: ejectAt + RIFT.lingerMs,
    vanish: false,
  };
  d.origin = { x: hx, y: RIFT.height, z: hz };
  d.ejectAt = ejectAt;
  st.live.set(id, d);
  st.rifts.push(rift);
  st.spots.set(id, { map: map.id, x: spot.x, z: spot.z });
  st.spotsDirty = true;
  sfxRiftOpen();
  const hum = sfxRiftWork((ejectAt - now) / 1000, tier);
  if (hum) st.hums.set(rift.key, hum);
  return true;
}

/** Taken some other way: a hole opens over it and draws it in. */
function vanish(st: State, d: Drop, now: number) {
  d.hum?.stop();
  d.hum = null;
  const at = new THREE.Vector3(d.pos.x, d.ground + RIFT.height * 0.85, d.pos.z);
  const rift: Rift = {
    key: `rift:${d.dropId}:${st.keySeq++}`,
    at,
    tier: d.tier,
    color: new THREE.Color(d.color),
    openAt: now,
    ejectAt: now + RIFT.vanishOpenMs + RIFT.vanishPullMs,
    closeAt: now + RIFT.vanishOpenMs + RIFT.vanishPullMs,
    vanish: true,
  };
  st.rifts.push(rift);
  d.phase = "vanishing";
  d.since = now + RIFT.vanishOpenMs;
  d.from.copy(d.pos);
  d.vanishTo = at.clone();
  d.vanishMs = RIFT.vanishPullMs;
  sfxRiftOpen();
}

/** Puts an object on Home's layer alone (`home`), or the world's. */
function putOnLayer(object: THREE.Object3D, home: boolean) {
  object.traverse((o) => {
    if (home) o.layers.set(HOME_LAYER);
    else o.layers.set(0);
  });
}

/** One drop, with its shadow at Home. */
function HomeDropView({
  drop,
  track,
}: {
  drop: Drop;
  track: (g: THREE.Object3D | null, was?: THREE.Object3D | null) => void;
}) {
  const group = useRef<THREE.Group>(null);
  useEffect(() => {
    const g = group.current;
    track(g);
    return () => track(null, g);
  }, [track]);
  return (
    <>
      <group ref={group}>
        <DropView drop={drop} />
      </group>
      <group position={[drop.spot.x, drop.ground, drop.spot.z]}>
        <HomeShadow
          radius={0.42}
          strength={() =>
            drop.phase === "resting" || drop.phase === "fetching"
              ? Math.min(1, (performance.now() - drop.restedAt) / 300)
              : 0
          }
        />
      </group>
    </>
  );
}

function TrackedRift({
  rift,
  track,
}: {
  rift: Rift;
  track: (g: THREE.Object3D | null, was?: THREE.Object3D | null) => void;
}) {
  const last = useRef<THREE.Object3D | null>(null);
  const onGroup = useCallback(
    (g: THREE.Group | null) => {
      track(g, last.current);
      last.current = g;
    },
    [track],
  );
  return <RiftView rift={rift} onGroup={onGroup} />;
}
