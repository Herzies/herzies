import { type ItemDef, RARITY_COLORS } from "@herzies/shared";
import { BOSS_STAND } from "@herzies/shared/combat";
import { itemVoxelMeshes, lootPillarMaterial } from "@herzies/shared/gl";
import type { LootDrop } from "@herzies/shared/town-net";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { notify } from "../../../lib/notices";
import { announcePickup } from "../../../lib/pickups";
import { herzies } from "../../../tauri-bridge";
import { keepAtHome } from "../HomeLayer";
import { homeMode } from "../homeMode";
import { townSave, useTownRuntime } from "../runtime";
import {
  type LootTier,
  sfxLootBurst,
  sfxLootHum,
  sfxLootLand,
  sfxLootPickup,
  sfxSpiritNotice,
} from "../sfx";
import { bossFight, useBossFight } from "./fight";
import {
  BOSS_ORIGIN,
  flightAt,
  LOOT,
  landingSpots,
  lootItem,
  restAt,
  tierOf,
  type Vec2,
} from "./loot";
import {
  bagFree,
  bagOpen,
  hasLootRoom,
  pushLootLog,
  roomVersion,
} from "./lootFeed";
import { combat, shake } from "./state";

/**
 * The boss's loot dropping in the cave (see loot.ts for the beat sheet and
 * every number): the stone boss bursting, the pieces fountaining out, then
 * lying in their pillars of light until you walk up to them or your spirit
 * fetches them. Only you see yours.
 */
export function LootDrops() {
  useBossFight();
  const victory = bossFight.victory;
  return (
    <>
      {victory ? <StoneBurst /> : null}
      {bossFight.loots.map((l) => (
        <Drops key={l.id} loot={l.drops} here={!!l.here} from={l.from} />
      ))}
    </>
  );
}

/** When the stone burst, for the victory it burst for: the loot comes out
 * of it. */
const burst = {
  for: null as object | null,
  at: null as number | null,
};

/** The burst's time once it has happened for the current victory, else
 * null. Also starts the clock on a dev drop (stamped NaN). */
function burstAt(now: number): number | null {
  const v = bossFight.victory;
  if (!v) return null;
  if (Number.isNaN(v.at)) v.at = now;
  for (const b of bossFight.loots) if (Number.isNaN(b.at)) b.at = now;
  // The boss's own loot (not a dev drop or a Tower mob's).
  const l = bossFight.loots.find((b) => !b.here && !b.from);
  if (burst.for !== v) {
    burst.for = v;
    burst.at = null;
  }
  if (burst.at === null) {
    const due = l
      ? Math.max(v.at + LOOT.burstAfterMs, l.at)
      : v.at + LOOT.burstFallbackMs;
    if (now >= due) burst.at = now;
  }
  return burst.at;
}

const scratchV = new THREE.Vector3();

/** The drop the spirit is on its way to or taking in, across every batch on
 * the ground: one at a time. */
let errand: Drop | null = null;
/** What it's been sent for and not got yet (on its way, taking it in):
 * counted against the bag before it goes for more, so it never goes for
 * what there's no room for. */
const claimed = new Set<Drop>();
/** What it put in the bag that the bag doesn't show yet (the app's update
 * is on its way): counted too, until the bag next changes (`roomVersion`
 * then), or for a few seconds at most. */
const justIn = new Map<Drop, { version: number; at: number }>();
const JUST_IN_MS = 3_000;
/** Sent off after something (vs following its herzie as usual). */
let out = false;

/** Drops the server turned down, by drop id (HomeDrops makes a new Drop when
 * one goes back on the ground, so not on the Drop). Neither the spirit nor
 * walking up tries one again by itself until the bag has more room than it
 * had then, or a while has passed: our idea of the bag was wrong once, and
 * going round again would just be refused again. */
const refusals = new Map<
  string,
  { free: number; until: number; tries: number; settleUntil: number }
>();
/** Turned down for room: tried again after this, if nothing's freed up. */
const REFUSED_FULL_MS = 60_000;
/** The call failed: tried again after this, doubling, up to a minute. */
const RETRY_MS = 4_000;
/** Right after a refusal the bag's count is still settling: the pickup's
 * undo, then the server's own count, land as updates of their own. Room
 * that turns up meanwhile is that, not a slot freed. */
const SETTLE_MS = 2_500;

function refused(dropId: string, now: number): boolean {
  const r = refusals.get(dropId);
  if (!r) return false;
  if (now < r.settleUntil) {
    r.free = Math.max(r.free, bagFree());
    return now < r.until;
  }
  if (now >= r.until || bagFree() > r.free) {
    // Left in the map for the backoff's count; it's small.
    r.until = 0;
    return false;
  }
  return true;
}

function refuse(dropId: string, now: number, bagFull: boolean): void {
  const tries = (refusals.get(dropId)?.tries ?? 0) + 1;
  const wait = bagFull
    ? REFUSED_FULL_MS
    : Math.min(REFUSED_FULL_MS, RETRY_MS * 2 ** (tries - 1));
  refusals.set(dropId, {
    free: bagFree(),
    until: now + wait,
    tries,
    settleUntil: now + SETTLE_MS,
  });
}

/** The items counted against the bag on top of what it holds, but for
 * `except`. (What the server already took is in the bag already.) */
function alsoTaking(now: number, except?: Drop): string[] {
  const ids: string[] = [];
  for (const c of claimed) if (c !== except && !c.taken) ids.push(c.item.id);
  for (const [c, j] of justIn) {
    if (j.version !== roomVersion() || now - j.at > JUST_IN_MS)
      justIn.delete(c);
    else if (c !== except) ids.push(c.item.id);
  }
  return ids;
}

const reducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

// --- The burst ---------------------------------------------------------------

const SHARDS = 40;
const SHARD_LIFE_MS = 1_500;
const GRAVITY = 14;

/** The petrified boss cracking apart: a flash, a boom, stone flying. */
function StoneBurst() {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const flash = useRef<THREE.Mesh>(null);
  const shards = useMemo(
    () =>
      Array.from({ length: SHARDS }, () => {
        const a = Math.random() * Math.PI * 2;
        const out = 2 + Math.random() * 4;
        return {
          p: new THREE.Vector3(
            BOSS_STAND.x + Math.sin(a) * 0.6,
            BOSS_STAND.chest + (Math.random() - 0.3) * 1.6,
            BOSS_STAND.z + Math.cos(a) * 0.6,
          ),
          v: new THREE.Vector3(
            Math.sin(a) * out,
            3 + Math.random() * 5,
            Math.cos(a) * out,
          ),
          spin: new THREE.Euler(
            Math.random() * 6,
            Math.random() * 6,
            Math.random() * 6,
          ),
          size: 0.08 + Math.random() * 0.16,
        };
      }),
    [],
  );
  const started = useRef(false);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const s = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, frameDt) => {
    const now = performance.now();
    const at = burstAt(now);
    const since = at === null ? -1 : now - at;
    const inst = mesh.current;
    if (!inst || !flash.current) return;
    if (since < 0) {
      inst.visible = false;
      flash.current.visible = false;
      return;
    }
    if (!started.current) {
      started.current = true;
      sfxLootBurst();
      if (!reducedMotion()) {
        shake(0.55);
        combat.slowUntil = now + 120;
      }
    }
    // The flash: a white bloom swelling and gone in a quarter second.
    const f = since / 260;
    flash.current.visible = f < 1;
    flash.current.scale.setScalar(0.6 + f * 3.2);
    (flash.current.material as THREE.MeshBasicMaterial).opacity =
      0.85 * (1 - f) ** 2;

    const dt = Math.min(frameDt, 0.05);
    const life = since / SHARD_LIFE_MS;
    inst.visible = life < 1;
    if (life >= 1) return;
    shards.forEach((sh, i) => {
      sh.v.y -= GRAVITY * dt;
      sh.p.addScaledVector(sh.v, dt);
      if (sh.p.y < sh.size / 2) {
        sh.p.y = sh.size / 2;
        sh.v.y = Math.abs(sh.v.y) * 0.3;
        sh.v.x *= 0.6;
        sh.v.z *= 0.6;
      }
      sh.spin.x += dt * 5;
      sh.spin.y += dt * 4;
      q.setFromEuler(sh.spin);
      s.setScalar(sh.size * (1 - life ** 3));
      m.compose(sh.p, q, s);
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh
        ref={mesh}
        args={[undefined, undefined, SHARDS]}
        visible={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial color="#8d8a86" />
      </instancedMesh>
      <mesh
        ref={flash}
        position={[BOSS_STAND.x, BOSS_STAND.chest, BOSS_STAND.z]}
        visible={false}
      >
        <sphereGeometry args={[1, 24, 16]} />
        <meshBasicMaterial
          color="#fff6e0"
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
    </>
  );
}

// --- The drops ---------------------------------------------------------------

export type Phase =
  | "waiting"
  | "flying"
  | "resting"
  | "pulled"
  | "fetching"
  /** Taken back where it came from (picked up somewhere else, or by the
   * server for a spirit): drawn up and away (see HomeDrops). */
  | "vanishing"
  | "done";

export type Drop = {
  key: string;
  item: ItemDef;
  tier: LootTier;
  color: string;
  spot: Vec2;
  ejectAt: number;
  /** The ground drop it is (collect-drop claims it on pickup); empty for a
   * dev drop, which collects nothing. */
  dropId: string;
  /** Its place in the fountain. */
  order: number;
  /** Tossed down in front of you (the dev drop), not out of the boss. */
  here: boolean;
  /** Where it flies from (y above the floor), and how high it arcs. */
  origin: { x: number; y: number; z: number };
  apex: number;
  /** The floor's height where it lands. */
  ground: number;
  phase: Phase;
  /** When it entered its current phase. */
  since: number;
  /** When it came to rest (the spirit waits a beat after that). */
  restedAt: number;
  /** Where it is, the middle of the model. */
  pos: THREE.Vector3;
  /** Where a pull started from. */
  from: THREE.Vector3;
  /** The spirit's errand: on its way to it, or taking it in. */
  fetch: "going" | "absorb" | null;
  fetchAt: number;
  /** Fetched by a spirit on foot (the cat): it walks there and pounces,
   * rather than flying over and hovering. */
  onFoot?: boolean;
  /** When a cat sent for it gives up (it can't get there: water). */
  fetchBy?: number;
  /** A cat couldn't reach it: it's left for you to walk to. */
  unreachable?: boolean;
  spin: number;
  hum: ReturnType<typeof sfxLootHum>;
  /** Something that dropped while you listened (see HomeDrops), rather
   * than a fight's loot: it's only taken if the bag has room for it, and
   * is otherwise left lying there. */
  home?: boolean;
  /** Being picked up (collect-drop is on its way). */
  collecting?: boolean;
  /** Already in the bag: the server's spirit sweep took it while it was
   * being fetched or pulled to you. It plays out as it was; only
   * nothing more is collected. */
  taken?: boolean;
  /** Taken by the spirit: its light went out as it was taken in, so it
   * doesn't flash back up where it lay. */
  delivered?: boolean;
  /** When the bag-full notice was last given for it, so walking about
   * near it doesn't repeat it every frame. */
  fullNoticeAt?: number;
  /** Vanishing: where it's drawn up to, and how long it takes. */
  vanishTo?: THREE.Vector3;
  vanishMs?: number;
  view: {
    group: THREE.Group | null;
    model: THREE.Group | null;
    pillar: THREE.Group | null;
    ring: THREE.Mesh | null;
    dust: THREE.Mesh | null;
    /** The motes (a THREE.Points). */
    sparkles: THREE.Object3D | null;
    label: HTMLDivElement | null;
  };
};

function Drops({
  loot,
  here: dev,
  from,
}: {
  loot: LootDrop[];
  here: boolean;
  /** Out of a Tower mob where it fell, not the boss. */
  from?: { x: number; z: number };
}) {
  // Either way it's tossed out at once, not out of a stone burst.
  const here = dev || !!from;
  const rt = useTownRuntime();
  const drops = useMemo<Drop[]>(() => {
    const known = loot.flatMap((l) => {
      const item = lootItem(l.item);
      return item ? [{ dropId: l.id, item }] : [];
    });
    // Out of the boss toward you; or (the dev drop) tossed out a little way
    // in front of you, wherever you are.
    const herzie = rt.playerHerzie;
    const ground =
      here && herzie ? herzie.root.getWorldPosition(scratchV).y : 0;
    const fx = Math.sin(townSave.heading);
    const fz = Math.cos(townSave.heading);
    const spots = from
      ? known.map((_, i) => {
          const a = (i / Math.max(1, known.length)) * Math.PI * 2 + 0.7;
          const r = known.length > 1 ? 1.1 : 0.6;
          return { x: from.x + Math.sin(a) * r, z: from.z + Math.cos(a) * r };
        })
      : here && homeMode.on && homeMode.azimuth !== null
        ? // At Home the camera's in front of you: round the far side of
          // you instead, where it can see them.
          known.map((_, i) => {
            const t = known.length > 1 ? i / (known.length - 1) - 0.5 : 0;
            const a = (homeMode.azimuth ?? 0) + Math.PI + t * 2.4;
            return {
              x: townSave.x + Math.sin(a) * 2.2,
              z: townSave.z + Math.cos(a) * 2.2,
            };
          })
        : here
          ? known.map((_, i) => ({
              x:
                townSave.x + fx * 2.4 + fz * (i - (known.length - 1) / 2) * 1.6,
              z:
                townSave.z + fz * 2.4 - fx * (i - (known.length - 1) / 2) * 1.6,
            }))
          : landingSpots(known.length, { x: townSave.x, z: townSave.z });
    const origin = from
      ? { x: from.x, y: 0.8, z: from.z }
      : here
        ? {
            x: townSave.x + fx * 0.5,
            y: (herzie?.height ?? 1) * 0.7,
            z: townSave.z + fz * 0.5,
          }
        : BOSS_ORIGIN;
    return known.map(({ dropId, item }, i) => ({
      dropId,
      here,
      origin,
      apex: here ? 1.1 : LOOT.apex,
      ground,
      key: `${item.id}:${i}`,
      item,
      tier: tierOf(item.rarity),
      color: RARITY_COLORS[item.rarity],
      spot: spots[i],
      // Set once the stone has burst (see the frame loop).
      ejectAt: Number.NaN,
      order: i,
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
    }));
  }, [loot, here, from, rt]);

  useDropLoop(() => drops);

  // Leaving (or the room closing): stop the hums, call the spirit back if
  // it was out for one of these.
  useEffect(() => () => releaseDrops(drops, rt.playerHerzie), [drops, rt]);

  // Drawn at Home too (the test drop, pressed from Home), not only in the
  // world, which Home fades out.
  const group = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    if (group.current) keepAtHome(group.current);
  }, []);

  return (
    <group ref={group}>
      {drops.map((d) => (
        <DropView key={d.key} drop={d} />
      ))}
    </group>
  );
}

/** How long a drop's name shows at Home after it lands. */
const HOME_LABEL_MS = 2_600;

/** How often the bag-full notice may repeat for one drop. */
const FULL_NOTICE_MS = 4_000;

/** Stops a batch's hums, and calls the spirit back if it was out for one of
 * them (leaving, or the room closing). */
export function releaseDrops(
  drops: readonly Drop[],
  herzie: { fetch(at: THREE.Vector3 | null): void } | null,
): void {
  for (const d of drops) {
    d.hum?.stop();
    d.hum = null;
    claimed.delete(d);
  }
  if (errand && drops.includes(errand)) {
    errand = null;
    out = false;
    herzie?.fetch(null);
  }
}

/**
 * Runs drops on the ground, every frame: out of the air, landing, lying in
 * their light; pulled to you as you walk up, or fetched by your spirit
 * (one errand at a time, across every batch); picked up. `source` hands
 * over the drops this frame.
 */
export function useDropLoop(
  source: () => readonly Drop[],
  /** While true, nothing's picked up: they lie where they are, and the
   * spirit stays by you (Home, where they aren't shown). */
  hold: () => boolean = () => false,
): void {
  const rt = useTownRuntime();
  // Pickups in a row climb a scale.
  const step = useRef(0);
  const scratch = useMemo(
    () => ({ spirit: new THREE.Vector3(), player: new THREE.Vector3() }),
    [],
  );

  /** Into the bag, now: walked into, or the moment the spirit takes it in
   * (it doesn't have to bring it back first). */
  const collect = (d: Drop, now: number) => {
    const bySpirit = d.phase === "fetching";
    if (errand === d) errand = null;
    claimed.delete(d);
    const name = d.item.name;
    // No room after all (the bag filled meanwhile): the spirit leaves it
    // lying where it was, until there is.
    if (
      bySpirit &&
      !d.taken &&
      d.dropId !== "" &&
      !hasLootRoom(d.item.id, alsoTaking(now, d))
    ) {
      d.fetch = null;
      d.phase = "resting";
      d.since = now;
      d.restedAt = now;
      d.pos.set(d.spot.x, d.ground, d.spot.z);
      if (!bagOpen() && now - (d.fullNoticeAt ?? 0) > FULL_NOTICE_MS) {
        d.fullNoticeAt = now;
        notify("Bag full");
      }
      return;
    }
    d.delivered = bySpirit;
    d.fetch = null;
    d.phase = "done";
    d.since = now;
    d.collecting = true;
    d.hum?.stop();
    d.hum = null;
    sfxLootPickup(step.current++, d.tier);
    // Already in the bag: the server's spirit sweep took it while this one
    // was on its way, and said so then.
    if (d.taken) return;
    // A dev drop: nothing behind it to collect.
    if (!d.dropId) {
      announcePickup(name, {
        log: `Picked up "${name}" (test, nothing granted)`,
      }).confirm();
      return;
    }
    // Refused like Home refuses it: an over-capacity item would have no slot
    // to show in. It isn't lost; it's one more drop on the Home ground. Not
    // retried here, so a full bank can't send the spirit round in circles.
    const waiting = d.home
      ? `"${name}" is still lying there`
      : `"${name}" is waiting on your Home ground`;
    if (!hasLootRoom(d.item.id)) {
      pushLootLog(`Bag full — ${waiting}`);
      return;
    }
    // In the bag now, and said now: the app adds it before the server's
    // answer (and takes it back out if the server says no).
    justIn.set(d, { version: roomVersion(), at: now });
    const pickup = announcePickup(name);
    const dropId = d.dropId;
    herzies
      .collectDrop(dropId)
      .then((outcome) => {
        if (outcome === "collected") {
          refusals.delete(dropId);
          pickup.confirm();
          return;
        }
        // Not ours to say: "gone" is most likely the server's spirit having
        // taken it (it says so itself); "bag-full" stays on the ground.
        pickup.refuse();
        justIn.delete(d);
        if (outcome === "bag-full") {
          refuse(dropId, performance.now(), true);
          if (!bagOpen()) notify("Bag full");
          pushLootLog(`Bag full — ${waiting}`);
        }
      })
      .catch(() => {
        pickup.refuse();
        justIn.delete(d);
        refuse(dropId, performance.now(), false);
        notify(`Couldn't pick up "${name}"`);
        pushLootLog(`Couldn't pick that up — ${waiting}`);
      });
  };

  useFrame((_, frameDt) => {
    const now = performance.now();
    const dt = Math.min(frameDt, 0.05);
    const herzie = rt.playerHerzie;
    const feet = herzie ? herzie.root.getWorldPosition(scratchV).y : 0;
    const player = scratch.player.set(townSave.x, feet, townSave.z);
    const chest = feet + (herzie ? herzie.height * 0.55 : 0.6);
    const spirit = herzie?.hasCompanion
      ? herzie.companionPosition(scratch.spirit)
      : null;
    // The spirit runs one errand at a time: busy from the moment it's sent
    // (two pieces landing on the same frame, or in two batches, mustn't both
    // be given to it). A finished errand frees it.
    if (errand && errand.fetch === null) errand = null;
    // Anything taken off it some other way (a batch closed, the ground
    // changed under it) is no longer its business, or it would hold up the
    // hand-over and count against the bag for good.
    for (const d of claimed) if (d.phase !== "fetching") claimed.delete(d);
    const onFoot = herzie?.companionKind === "walker";

    const drops = source();
    const held = hold();
    for (const d of drops) {
      const flat = Math.hypot(d.pos.x - player.x, d.pos.z - player.z);
      // Something that dropped while you listened is only taken with room
      // in the bag for it; otherwise it stays lying there, and says why
      // when you walk up to it.
      const room = !d.home || hasLootRoom(d.item.id);
      // Turned down by the server a moment ago: left be (see refusals).
      const refusedHere = d.dropId !== "" && refused(d.dropId, now);
      switch (d.phase) {
        case "waiting": {
          const at = d.here ? now : burstAt(now);
          if (at !== null && Number.isNaN(d.ejectAt))
            d.ejectAt =
              Math.max(at + LOOT.ejectAfterMs, now) + d.order * LOOT.staggerMs;
          if (now >= d.ejectAt) {
            d.phase = "flying";
            d.since = d.ejectAt;
          }
          break;
        }
        case "flying": {
          const ms = now - d.since;
          const p = flightAt(d.spot, ms, d.origin, d.apex);
          d.pos.set(p.x, p.y + d.ground, p.z);
          if (ms >= LOOT.flightMs) {
            d.phase = "resting";
            d.since = now;
            d.restedAt = now;
            sfxLootLand(d.tier);
            d.hum = sfxLootHum(d.tier);
          }
          break;
        }
        case "resting":
        case "fetching": {
          if (d.phase === "resting") {
            const r = restAt(now - d.since);
            d.pos.set(d.spot.x, r.y + d.ground, d.spot.z);
          }
          // Held: one the spirit was going for stays where it lies.
          if (held && d.phase === "fetching" && d.fetch === "going") {
            d.fetch = null;
            d.phase = "resting";
            d.restedAt = now;
            claimed.delete(d);
            if (errand === d) errand = null;
          }
          if (
            !held &&
            !room &&
            !bagOpen() &&
            flat < LOOT.magnetRadius &&
            now - (d.fullNoticeAt ?? 0) > FULL_NOTICE_MS
          ) {
            d.fullNoticeAt = now;
            notify("Bag full");
          }
          // Walk into it: it comes to you (and the spirit can stand down).
          if (
            !held &&
            !refusedHere &&
            room &&
            flat < LOOT.magnetRadius &&
            now - d.restedAt > 120
          ) {
            if (errand === d) errand = null;
            d.fetch = null;
            d.phase = "pulled";
            d.since = now;
            d.from.copy(d.pos);
            break;
          }
          if (d.phase === "fetching" && spirit) {
            const r = restAt(now - d.since);
            if (d.fetch !== "absorb")
              d.pos.set(d.spot.x, r.y + d.ground, d.spot.z);
            // Taken the moment it passes over it, without stopping: the
            // spirit's free for the next one at once, while this one zips
            // into it. (Or a cat pounced on it; or a spirit never quite got
            // there, but long enough on its way.)
            const over =
              Math.hypot(spirit.x - d.spot.x, spirit.z - d.spot.z) <
              (d.onFoot ? LOOT.catTouchRadius : LOOT.spiritTouchRadius);
            if (
              d.fetch === "going" &&
              (over ||
                (d.onFoot && herzie?.companionCaught) ||
                (!d.onFoot && now - d.fetchAt > 2_500))
            ) {
              d.fetch = "absorb";
              d.fetchAt = now;
              d.from.copy(d.pos);
              if (errand === d) errand = null;
            } else if (
              d.fetch === "going" &&
              d.onFoot &&
              now > (d.fetchBy ?? 0)
            ) {
              // It can't get there: left for you.
              d.fetch = null;
              d.phase = "resting";
              d.unreachable = true;
              d.onFoot = false;
              errand = null;
              claimed.delete(d);
            } else if (d.fetch === "absorb") {
              const t = Math.min(1, (now - d.fetchAt) / LOOT.spiritAbsorbMs);
              d.pos.lerpVectors(d.from, spirit, t * t);
              if (t >= 1) collect(d, now);
            }
          }
          break;
        }
        case "pulled": {
          const t = Math.min(1, (now - d.since) / LOOT.magnetMs);
          const e = t * t;
          d.pos.set(
            d.from.x + (player.x - d.from.x) * e,
            d.from.y + (chest - d.from.y) * e + Math.sin(t * Math.PI) * 0.35,
            d.from.z + (player.z - d.from.z) * e,
          );
          if (t >= 1) collect(d, now);
          break;
        }
        case "vanishing": {
          const t = Math.max(
            0,
            Math.min(1, (now - d.since) / (d.vanishMs ?? 400)),
          );
          if (d.vanishTo) d.pos.lerpVectors(d.from, d.vanishTo, t * t);
          if (t >= 1) {
            d.phase = "done";
            d.since = now;
          }
          break;
        }
        case "done":
          break;
      }
      draw(d, now, dt, flat);
    }

    // Free: off after the next thing in reach (the nearest, once it's on a
    // run), or home.
    if (!errand && spirit && herzie) {
      const next = held ? null : nextErrand(drops, player, spirit, now);
      if (next) send(next, spirit, now, onFoot, herzie);
      else if (out) {
        out = false;
        herzie.fetch(null);
      }
    }
  });
}

/** What the spirit goes for next, if anything: what's lying in reach of
 * you, and fits in the bag on top of what it's just put there or is
 * getting. Setting out, the humblest first; on a run, whatever's nearest
 * where it is. */
function nextErrand(
  drops: readonly Drop[],
  player: THREE.Vector3,
  spirit: THREE.Vector3,
  now: number,
): Drop | null {
  let best: Drop | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const onRun = out;
  const taking = alsoTaking(now);
  for (const x of drops) {
    if (
      x.phase !== "resting" ||
      x.unreachable ||
      (x.dropId !== "" && refused(x.dropId, now)) ||
      // No room for it on top of what it's already got: left lying there
      // until there is. (A test drop grants nothing, so always fits.)
      (x.dropId !== "" && !hasLootRoom(x.item.id, taking)) ||
      now - x.restedAt <= LOOT.spiritDelayMs ||
      Math.hypot(x.pos.x - player.x, x.pos.z - player.z) >= LOOT.spiritRadius
    )
      continue;
    const near = Math.hypot(x.spot.x - spirit.x, x.spot.z - spirit.z);
    const score = onRun ? near : x.tier * 1e4 + near;
    if (score < bestScore) {
      bestScore = score;
      best = x;
    }
  }
  return best;
}

/** Sends the spirit for `d`. */
function send(
  d: Drop,
  spirit: THREE.Vector3,
  now: number,
  onFoot: boolean,
  herzie: { fetch(at: THREE.Vector3 | null): void },
) {
  d.phase = "fetching";
  d.fetch = "going";
  d.fetchAt = now;
  errand = d;
  claimed.add(d);
  // Only the first of a run is announced.
  if (!out) sfxSpiritNotice();
  out = true;
  d.onFoot = onFoot;
  if (onFoot) {
    // On foot: there at a run, with time to spare (or it can't get there,
    // and gives up).
    const far = Math.hypot(d.spot.x - spirit.x, d.spot.z - spirit.z);
    d.fetchBy = now + LOOT.catPatienceMs + far * LOOT.catMsPerUnit;
  }
  herzie.fetch(
    new THREE.Vector3(
      d.spot.x,
      onFoot ? d.ground : d.ground + LOOT.hover + 0.55,
      d.spot.z,
    ),
  );
}

/** Puts one drop's parts where its state says, this frame. */
function draw(d: Drop, now: number, dt: number, flat: number) {
  const v = d.view;
  if (!v.group || !v.model || !v.pillar || !v.ring || !v.dust) return;
  const show = d.phase !== "waiting";
  v.model.visible = show && d.phase !== "done";
  v.model.position.copy(d.pos);

  // Turning: tumbling through the air, a slow turn at rest.
  if (d.phase === "flying") {
    d.spin += dt * 9;
    v.model.rotation.set(d.spin * 0.6, d.spin, 0);
  } else {
    d.spin += dt * LOOT.spinPerSecond;
    v.model.rotation.set(0, d.spin, 0);
  }
  let scale = 1;
  let squashX = 1;
  let squashY = 1;
  if (d.phase === "resting" || d.phase === "fetching") {
    const r = restAt(now - d.since);
    squashX = 1 + r.squash;
    squashY = 1 - r.squash;
  }
  if (d.phase === "pulled") {
    scale = 1 - 0.8 * Math.min(1, (now - d.since) / LOOT.magnetMs);
  }
  if (d.fetch === "absorb") {
    const t = Math.min(1, (now - d.fetchAt) / LOOT.spiritAbsorbMs);
    scale = 1 - t;
    v.model.rotation.y += t * 8;
  }
  if (d.phase === "vanishing") {
    const t = Math.max(0, Math.min(1, (now - d.since) / (d.vanishMs ?? 400)));
    scale = 1 - t * t;
    v.model.rotation.y += t * t * 10;
  }
  v.model.scale.set(scale * squashX, scale * squashY, scale * squashX);

  // The pillar and the glow on the floor: in once it lands, pulsing for the
  // grand ones, collapsing upward when it's taken.
  const landed =
    d.phase === "resting" || d.phase === "fetching" || d.phase === "pulled";
  const since = now - d.since;
  const pillarMat = (v.pillar.children[0] as THREE.Mesh)
    .material as THREE.ShaderMaterial;
  const ringMat = v.ring.material as THREE.MeshBasicMaterial;
  const pulse =
    d.tier >= 3 ? 0.8 + 0.2 * Math.sin((now / 1000) * Math.PI * 2 * 0.9) : 1;
  let pillar = 0;
  let pillarH = 1;
  if (landed) {
    pillar = Math.min(1, (now - d.restedAt) / 300) * pulse;
    if (d.phase === "pulled") pillar *= 1 - Math.min(1, since / LOOT.magnetMs);
  } else if ((d.phase === "done" && !d.delivered) || d.phase === "vanishing") {
    const t = Math.min(1, since / 350);
    pillar = (1 - t) * 0.8;
    pillarH = 1 + t * 0.6;
    v.pillar.scale.x = v.pillar.scale.z = 1 - t * 0.85;
  }
  v.pillar.visible = pillar > 0.001;
  v.pillar.position.set(d.spot.x, d.ground, d.spot.z);
  v.pillar.scale.y = LOOT.pillarHeight[d.tier] * pillarH;
  if (d.phase !== "done") v.pillar.scale.x = v.pillar.scale.z = 1;
  pillarMat.uniforms.uOpacity.value = pillar * LOOT.pillarGlow[d.tier];
  v.ring.visible = v.pillar.visible;
  v.ring.position.set(d.spot.x, d.ground + 0.03, d.spot.z);
  v.ring.scale.setScalar(1 + 0.08 * Math.sin((now / 1000) * Math.PI * 1.6));
  ringMat.opacity = pillar * 0.75;

  // A puff of dust where it hit, spreading and gone.
  const dustT = (now - d.restedAt) / 450;
  v.dust.visible = d.restedAt > 0 && dustT < 1;
  v.dust.position.set(d.spot.x, d.ground + 0.04, d.spot.z);
  v.dust.scale.setScalar(0.4 + dustT * 1.6);
  (v.dust.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - dustT);

  // Rare and up: motes circling it.
  if (v.sparkles) {
    v.sparkles.visible = landed && d.phase !== "pulled";
    v.sparkles.position.set(d.spot.x, d.ground, d.spot.z);
    v.sparkles.rotation.y = now / 1400;
    ((v.sparkles as THREE.Points).material as THREE.PointsMaterial).opacity =
      pillar;
  }

  // Its name, close up. At Home, where everything's close and the names
  // would pile up, only as it lands: what came, said once.
  if (v.label) {
    const near = landed && d.phase !== "pulled";
    let o = near ? Math.max(0, Math.min(1, (LOOT.labelRadius - flat) / 2)) : 0;
    if (d.home && homeMode.on)
      o *= Math.max(
        0,
        Math.min(1, 1 - (now - d.restedAt - HOME_LABEL_MS) / 500),
      );
    v.label.style.opacity = String(o);
  }
  d.hum?.level(Math.max(0, 1 - flat / 14));
}

/** One drop's model, beam, floor glow and name. */
export function DropView({ drop }: { drop: Drop }) {
  const color = useMemo(() => new THREE.Color(drop.color), [drop.color]);
  const [plain, glow] = useMemo(() => itemVoxelMeshes(drop.item), [drop.item]);
  useEffect(
    () => () => {
      for (const m of [plain, glow]) {
        (m.material as THREE.Material).dispose();
        m.dispose();
      }
    },
    [plain, glow],
  );
  const pillarMaterial = useMemo(() => lootPillarMaterial(color), [color]);
  const sparkles = useMemo(() => {
    if (drop.tier < 2) return null;
    const n = 6 + drop.tier * 3;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 0.55 + Math.random() * 0.35;
      pts[i * 3] = Math.sin(a) * r;
      pts[i * 3 + 1] = 0.2 + Math.random() * 1.4;
      pts[i * 3 + 2] = Math.cos(a) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    return g;
  }, [drop.tier]);

  const v = drop.view;
  return (
    <group
      ref={(g) => {
        v.group = g;
      }}
    >
      <group
        ref={(g) => {
          v.model = g;
        }}
        visible={false}
      >
        <group scale={LOOT.modelScale}>
          <primitive object={plain} />
          <primitive object={glow} />
        </group>
        <Html
          center
          position={[0, 0.95, 0]}
          zIndexRange={[18, 0]}
          style={{ pointerEvents: "none" }}
        >
          <div
            ref={(el) => {
              v.label = el;
            }}
            // Its name stays up at Home, where the rest of the Town's
            // labels go (see TownWorld).
            data-home-keep={drop.home ? "" : undefined}
            className="whitespace-nowrap text-[11px] font-bold [text-shadow:0_1px_2px_#000,0_0_6px_#000] transition-opacity duration-200"
            style={{ color: drop.color, opacity: 0 }}
          >
            {drop.item.name}
          </div>
        </Html>
      </group>
      <group
        ref={(g) => {
          v.pillar = g;
        }}
        visible={false}
      >
        <mesh material={pillarMaterial} position={[0, 0.5, 0]}>
          <cylinderGeometry args={[0.22, 0.3, 1, 20, 1, true]} />
        </mesh>
      </group>
      <mesh
        ref={(m) => {
          v.ring = m;
        }}
        rotation={[-Math.PI / 2, 0, 0]}
        visible={false}
      >
        <ringGeometry args={[0.5, 0.7, 48]} />
        <meshBasicMaterial
          color={color}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      <mesh
        ref={(m) => {
          v.dust = m;
        }}
        rotation={[-Math.PI / 2, 0, 0]}
        visible={false}
      >
        <ringGeometry args={[0.55, 0.8, 40]} />
        <meshBasicMaterial color="#d8cfc0" transparent depthWrite={false} />
      </mesh>
      {sparkles ? (
        <points
          ref={(p) => {
            v.sparkles = p;
          }}
          geometry={sparkles}
          visible={false}
        >
          <pointsMaterial
            color={color}
            size={0.09}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </points>
      ) : null}
    </group>
  );
}
