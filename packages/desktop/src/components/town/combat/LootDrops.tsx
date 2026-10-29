import { type ItemDef, RARITY_COLORS } from "@herzies/shared";
import { BOSS_STAND } from "@herzies/shared/combat";
import { itemVoxelMeshes, lootPillarMaterial } from "@herzies/shared/gl";
import type { LootDrop } from "@herzies/shared/town-net";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { herzies } from "../../../tauri-bridge";
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
import { hasLootRoom, pushLootLog } from "./lootFeed";
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

/** The drop the spirit is busy with (sent for it, or carrying it back),
 * across every batch on the ground: it runs one errand at a time. */
let errand: Drop | null = null;

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

type Phase =
  | "waiting"
  | "flying"
  | "resting"
  | "pulled"
  | "fetching"
  | "carried"
  | "done";

type Drop = {
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
  /** The spirit's errand: on its way, hovering over it, taking it in. */
  fetch: "going" | "hover" | "absorb" | null;
  fetchAt: number;
  spin: number;
  hum: ReturnType<typeof sfxLootHum>;
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
      : here
        ? known.map((_, i) => ({
            x: townSave.x + fx * 2.4 + fz * (i - (known.length - 1) / 2) * 1.6,
            z: townSave.z + fz * 2.4 - fx * (i - (known.length - 1) / 2) * 1.6,
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

  // Pickups in a row climb a scale.
  const step = useRef(0);
  const scratch = useMemo(
    () => ({ spirit: new THREE.Vector3(), player: new THREE.Vector3() }),
    [],
  );

  // Leaving (or the room closing): stop the hums, call the spirit back if
  // it was out for one of these.
  useEffect(
    () => () => {
      for (const d of drops) d.hum?.stop();
      if (errand && drops.includes(errand)) {
        errand = null;
        rt.playerHerzie?.fetch(null);
      }
    },
    [drops, rt],
  );

  const collect = (d: Drop, now: number) => {
    if (errand === d) errand = null;
    d.phase = "done";
    d.since = now;
    d.hum?.stop();
    d.hum = null;
    sfxLootPickup(step.current++, d.tier);
    const name = d.item.name;
    // A dev drop: nothing behind it to collect.
    if (!d.dropId) {
      pushLootLog(`Picked up "${name}" (test, nothing granted)`);
      return;
    }
    // Refused like Home refuses it: an over-capacity item would have no slot
    // to show in. It isn't lost; it's one more drop on the Home ground. Not
    // retried here, so a full bank can't send the spirit round in circles.
    const waiting = `"${name}" is waiting on your Home ground`;
    if (!hasLootRoom(d.item.id)) {
      pushLootLog(`Inventory full — ${waiting}`);
      return;
    }
    // Collected as on Home: the bag updates at once, and the app logs
    // `Picked up "<name>"` itself.
    herzies
      .collectDrop(d.dropId)
      .then((ok) => {
        if (!ok) pushLootLog(`Couldn't pick that up — ${waiting}`);
      })
      .catch(() => pushLootLog(`Couldn't pick that up — ${waiting}`));
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
    if (errand && errand.fetch === null && errand.phase !== "carried")
      errand = null;

    for (const d of drops) {
      const flat = Math.hypot(d.pos.x - player.x, d.pos.z - player.z);
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
          // Walk into it: it comes to you (and the spirit can stand down).
          if (flat < LOOT.magnetRadius && now - d.restedAt > 120) {
            if (d.fetch) herzie?.fetch(null);
            if (errand === d) errand = null;
            d.fetch = null;
            d.phase = "pulled";
            d.since = now;
            d.from.copy(d.pos);
            break;
          }
          // The spirit spots it: one errand at a time, the grandest last.
          if (
            d.phase === "resting" &&
            spirit &&
            !errand &&
            now - d.restedAt > LOOT.spiritDelayMs &&
            flat < LOOT.spiritRadius &&
            d ===
              drops
                .filter((x) => x.phase === "resting")
                .sort((a, b) => a.tier - b.tier)[0]
          ) {
            d.phase = "fetching";
            d.fetch = "going";
            errand = d;
            d.fetchAt = now;
            sfxSpiritNotice();
            herzie?.fetch(
              new THREE.Vector3(
                d.spot.x,
                d.ground + LOOT.hover + 0.55,
                d.spot.z,
              ),
            );
          }
          if (d.phase === "fetching" && spirit) {
            const r = restAt(now - d.since);
            if (d.fetch !== "absorb")
              d.pos.set(d.spot.x, r.y + d.ground, d.spot.z);
            const reach = spirit.distanceTo(d.pos);
            // There, or (never stuck on a spot it can't quite reach) long
            // enough on its way.
            if (
              d.fetch === "going" &&
              (reach < 0.75 || now - d.fetchAt > 2_500)
            ) {
              d.fetch = "hover";
              d.fetchAt = now;
            } else if (
              d.fetch === "hover" &&
              now - d.fetchAt > LOOT.spiritHoverMs
            ) {
              d.fetch = "absorb";
              d.fetchAt = now;
              d.from.copy(d.pos);
            } else if (d.fetch === "absorb") {
              const t = Math.min(1, (now - d.fetchAt) / LOOT.spiritAbsorbMs);
              d.pos.lerpVectors(d.from, spirit, t * t);
              if (t >= 1) {
                d.fetch = null;
                d.phase = "carried";
                d.since = now;
                d.hum?.stop();
                d.hum = null;
                herzie?.fetch(null);
              }
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
        case "carried":
          // Brought home: the payoff is when it reaches you.
          if (
            !spirit ||
            Math.hypot(spirit.x - player.x, spirit.z - player.z) <
              LOOT.deliverRadius ||
            now - d.since > 4_000
          )
            collect(d, now);
          break;
        case "done":
          break;
      }
      draw(d, now, dt, flat);
    }
  });

  return (
    <>
      {drops.map((d) => (
        <DropView key={d.key} drop={d} />
      ))}
    </>
  );
}

/** Puts one drop's parts where its state says, this frame. */
function draw(d: Drop, now: number, dt: number, flat: number) {
  const v = d.view;
  if (!v.group || !v.model || !v.pillar || !v.ring || !v.dust) return;
  const show = d.phase !== "waiting" && d.phase !== "carried";
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
  } else if (d.phase === "done") {
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

  // Its name, close up.
  if (v.label) {
    const near = landed && d.phase !== "pulled";
    const o = near
      ? Math.max(0, Math.min(1, (LOOT.labelRadius - flat) / 2))
      : 0;
    v.label.style.opacity = String(o);
  }
  d.hum?.level(Math.max(0, 1 - flat / 14));
}

/** One drop's model, beam, floor glow and name. */
function DropView({ drop }: { drop: Drop }) {
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
        <primitive object={plain} />
        <primitive object={glow} />
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
