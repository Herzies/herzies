import { RARITY_COLORS } from "@herzies/shared";
import { itemVoxelMeshes, lootPillarMaterial } from "@herzies/shared/gl";
import {
  WILDS_CACHE_HOLD_MS,
  WILDS_CACHE_HOLD_RADIUS,
} from "@herzies/shared/wilds-loot";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CylinderCollider } from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ambient } from "../ambient";
import { LOOT, lootItem } from "../combat/loot";
import { groundY, type TownMap } from "../map";
import {
  HUNT_CRYSTAL_GEOMETRY,
  HUNT_MOTE_GEOMETRY,
  HUNT_RING_GEOMETRY,
  type HuntUniforms,
  huntCrystalMaterial,
  huntMotesMaterial,
  huntRingMaterial,
} from "./huntCrystalModel";
import {
  type CacheSpot,
  type GroundCard,
  heldBy,
  heldByOthers,
  takeable,
  useWildsLoot,
  wildsLoot,
} from "./loot";

/**
 * The Wilds' loot in the world (see loot.ts for what it is): every card a
 * herzie dropped where it fell, turning over the ground in its rarity's
 * light once it's yours to take (grey and dark while it's someone else's
 * first, with how long that lasts), and the cache, a treasure crystal the
 * Hunt Crystal's light points toward, in a ring on the ground: stand in
 * it long enough and it's yours. The ring fills round in gold as you
 * hold it and in red as someone else does, and flashes red while it's
 * contested (the HUD says so too: see CacheHud); opened, the crystal
 * bursts. A card is picked up with E (the prompt: see TownCanvas), or left
 * lying; what a cache holds fountains out as ordinary loot (LootDrops).
 *
 * Mounted on the Wilds only, in the island's frame.
 */
export function WildsLoot({ map }: { map: TownMap }) {
  useWildsLoot();
  const cache = wildsLoot.cache;
  const opened = wildsLoot.opened;
  return (
    <>
      {[...wildsLoot.drops.values()].map((d) => (
        <DroppedCard key={d.id} drop={d} map={map} />
      ))}
      {cache ? <Cache key={cache.id} cache={cache} map={map} /> : null}
      {opened ? <CacheBurst key={opened.at} at={opened} map={map} /> : null}
    </>
  );
}

/** Locked (someone else's first): grey. */
const LOCKED = new THREE.Color("#8a8a92");

function DroppedCard({ drop, map }: { drop: GroundCard; map: TownMap }) {
  const item = lootItem(drop.item);
  const ground = groundY(map, drop.x, drop.z);
  const rarity = item ? RARITY_COLORS[item.rarity] : "#ffffff";
  const color = useMemo(() => new THREE.Color(rarity), [rarity]);
  const meshes = useMemo(() => (item ? itemVoxelMeshes(item) : null), [item]);
  useEffect(
    () => () => {
      for (const m of meshes ?? []) {
        (m.material as THREE.Material).dispose();
        m.dispose();
      }
    },
    [meshes],
  );
  const pillar = useMemo(() => lootPillarMaterial(color), [color]);
  useEffect(() => () => pillar.dispose(), [pillar]);
  const spin = useMemo(() => Math.random() * Math.PI * 2, []);

  const model = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const label = useRef<HTMLDivElement>(null);
  const shown = useRef("");
  useFrame(({ clock }) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const open = takeable(drop, wildsLoot.you, now);
    const mine = drop.firstFor !== null && drop.firstFor === wildsLoot.you;
    // Pops up out of the ground, then turns over it.
    const pop = Math.min(1, (now - drop.at) / 350);
    if (model.current) {
      model.current.position.y = 0.55 + Math.sin(t * 2.2 + spin) * 0.06;
      model.current.rotation.y = spin + t * 1.4;
      model.current.scale.setScalar(LOOT.modelScale * (0.4 + 0.6 * pop));
    }
    pillar.uniforms.uOpacity.value = open ? 0.7 + Math.sin(t * 3) * 0.12 : 0;
    if (ring.current) {
      const m = ring.current.material as THREE.MeshBasicMaterial;
      m.color.copy(open ? color : LOCKED);
      m.opacity = open ? 0.85 : 0.35;
    }
    // Its name, and whose it is for how long yet.
    const left = Math.ceil((drop.firstUntil - now) / 1000);
    const text = open
      ? mine && left > 0
        ? `${item?.name ?? drop.item} · yours ${left}s`
        : (item?.name ?? drop.item)
      : `${item?.name ?? drop.item} · ${left}s`;
    const el = label.current;
    if (el && text !== shown.current) {
      shown.current = text;
      el.textContent = text;
      el.style.color = open ? rarity : "#a8a8b0";
    }
  });

  if (!meshes) return null;
  return (
    <group position={[drop.x, ground, drop.z]}>
      <group ref={model}>
        <primitive object={meshes[0]} />
        <primitive object={meshes[1]} />
      </group>
      {/* The pillar's shader wants a unit cylinder: scaled to its height. */}
      <mesh material={pillar} position={[0, 1.1, 0]} scale={[1, 2.2, 1]}>
        <cylinderGeometry args={[0.22, 0.3, 1, 20, 1, true]} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[0.5, 0.7, 48]} />
        <meshBasicMaterial
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      <Html
        center
        position={[0, 1.35, 0]}
        zIndexRange={[18, 0]}
        style={{ pointerEvents: "none" }}
      >
        <div
          ref={label}
          className="whitespace-nowrap text-[11px] font-bold [text-shadow:0_1px_2px_#000,0_0_6px_#000]"
        />
      </Html>
    </group>
  );
}

/** The hold ring's gold. */
const GOLD = new THREE.Color("#ffd36a");

/** The hold ring's bands, inner and outer radius (world units): its line
 * at the hold radius (the edge you must stay within), your hold filling
 * just inside it, and someone else's inside that. */
const R = WILDS_CACHE_HOLD_RADIUS;
const RING_BANDS = [
  [R - 0.5, R],
  [R - 0.95, R - 0.6],
  [R - 1.35, R - 1.05],
] as const;
/** Segments round the ring, and how far it floats over the ground. */
const RING_SEGS = 128;
const RING_LIFT = 0.05;
const RIVAL = new THREE.Color("#ff5a4f");
const RING_LINE = new THREE.Color("#ffe7a3");

/**
 * The hold ring round a cache at (cx, cz), lying on the ground: each band
 * two rows of points, every one at the ground's height under it (as the
 * dome's line does: see DomeVFX), so it follows the slope rather than
 * cutting into it. Each point knows how far round it is (`aT`, 0–1
 * clockwise from the north), how far across its band (`aAcross`) and
 * which band (`aBand`); the shader fills them. Built once per cache.
 */
function holdRingGeometry(
  map: TownMap,
  cx: number,
  cz: number,
): THREE.BufferGeometry {
  const rows = RING_BANDS.length * 2;
  const n = rows * (RING_SEGS + 1);
  const pos = new Float32Array(n * 3);
  const t = new Float32Array(n);
  const across = new Float32Array(n);
  const band = new Float32Array(n);
  const index: number[] = [];
  for (let b = 0; b < RING_BANDS.length; b++)
    for (let side = 0; side < 2; side++) {
      const row = b * 2 + side;
      const r = RING_BANDS[b][side];
      for (let j = 0; j <= RING_SEGS; j++) {
        const k = row * (RING_SEGS + 1) + j;
        const ph = (j / RING_SEGS) * Math.PI * 2;
        const x = cx + Math.sin(ph) * r;
        const z = cz - Math.cos(ph) * r;
        pos[k * 3] = x;
        pos[k * 3 + 1] = groundY(map, x, z) + RING_LIFT;
        pos[k * 3 + 2] = z;
        t[k] = j / RING_SEGS;
        across[k] = side;
        band[k] = b;
        if (side === 1 && j < RING_SEGS) {
          const a = k - (RING_SEGS + 1);
          index.push(a, a + 1, k, k, a + 1, k + 1);
        }
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aT", new THREE.BufferAttribute(t, 1));
  g.setAttribute("aAcross", new THREE.BufferAttribute(across, 1));
  g.setAttribute("aBand", new THREE.BufferAttribute(band, 1));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

const RING_VERTEX = /* glsl */ `
  attribute float aT;
  attribute float aAcross;
  attribute float aBand;
  varying float vT;
  varying float vAcross;
  varying float vBand;
  void main() {
    vT = aT;
    vAcross = aAcross;
    vBand = aBand;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const RING_FRAGMENT = /* glsl */ `
  uniform vec3 uLine;
  uniform vec3 uGold;
  uniform vec3 uRival;
  uniform float uLineA;
  uniform float uWarn;
  uniform float uMineFill;
  uniform float uMineOn;
  uniform float uRivalFill;
  uniform float uRivalOn;
  varying float vT;
  varying float vAcross;
  varying float vBand;
  void main() {
    float soft = sin(vAcross * 3.14159265);
    vec3 col;
    float a;
    if (vBand < 0.5) {
      // The edge: brightest at the line, washing in toward the cache; the
      // rival's colour, pulsing, while it's contested.
      a = pow(vAcross, 2.5) * (1.0 - smoothstep(0.85, 1.0, vAcross)) * uLineA;
      col = mix(uLine, uRival, uWarn);
    } else if (vBand < 1.5) {
      // Your hold, filling round from the north; what's left of it faint.
      a = soft * uMineOn * mix(0.14, 1.0, step(vT, uMineFill));
      col = uGold;
    } else {
      a = soft * uRivalOn * mix(0.12, 0.9, step(vT, uRivalFill));
      col = uRival;
    }
    gl_FragColor = vec4(col, a);
  }
`;

function holdRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLine: { value: RING_LINE },
      uGold: { value: GOLD },
      uRival: { value: RIVAL },
      uLineA: { value: 0 },
      uWarn: { value: 0 },
      uMineFill: { value: 0 },
      uMineOn: { value: 0 },
      uRivalFill: { value: 0 },
      uRivalOn: { value: 0 },
    },
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
}

/** The treasure crystal's size against the Hunt Crystal's, how high it
 * floats (its middle, in its own scaled frame), and how long it takes to
 * rise out of the ground. */
const TREASURE_SCALE = 0.8;
const TREASURE_FLOAT = 1.5;
const POP_MS = 600;
/** Held this far, it trembles: it's about to go. */
const TREMBLE_FROM = 0.8;

/**
 * The cache: a treasure crystal, a small Hunt Crystal floating over the
 * ground in its hold ring. Grey stone with a glint now and then (look for
 * it), it fills with gold from the foot as it's held (the furthest hold),
 * spinning up as it fills and trembling near the end; opened, it bursts
 * (CacheBurst) and its loot fountains out (LootDrops). Solid.
 */
function Cache({ cache, map }: { cache: CacheSpot; map: TownMap }) {
  const ground = groundY(map, cache.x, cache.z);
  const ring = useMemo(() => holdRingMaterial(), []);
  const ringGeometry = useMemo(
    () => holdRingGeometry(map, cache.x, cache.z),
    [map, cache.x, cache.z],
  );
  const parts = useMemo(() => {
    const u: HuntUniforms = {
      uTime: ambient.uTime,
      uCharge: { value: 0 },
      uHunt: { value: 0 },
      uBurst: { value: 0 },
    };
    return {
      u,
      crystal: huntCrystalMaterial(u),
      motes: huntMotesMaterial(u),
      body: null as THREE.Group | null,
      spin: null as THREE.Group | null,
      angle: 0,
    };
  }, []);
  useEffect(() => () => ring.dispose(), [ring]);
  useEffect(() => () => ringGeometry.dispose(), [ringGeometry]);
  useEffect(
    () => () => {
      parts.crystal.dispose();
      parts.motes.dispose();
    },
    [parts],
  );
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const now = performance.now();
    const pop = Math.min(1, (now - cache.at) / POP_MS);
    // Who's holding it: you (gold, just inside the line) and the furthest
    // of anyone else (red, inside that), counted on from the room's word.
    const mine = heldBy(wildsLoot.you, now);
    const theirs = heldByOthers(wildsLoot.you, now);
    const held = Math.max(mine ?? 0, theirs ?? 0) / WILDS_CACHE_HOLD_MS;
    const u = ring.uniforms;
    u.uMineFill.value = (mine ?? 0) / WILDS_CACHE_HOLD_MS;
    u.uMineOn.value = mine === null ? 0 : 1;
    u.uRivalFill.value = (theirs ?? 0) / WILDS_CACHE_HOLD_MS;
    u.uRivalOn.value = theirs === null ? 0 : 1;
    u.uWarn.value = wildsLoot.hold?.contested
      ? 0.55 + 0.45 * Math.sin(t * 9)
      : 0;
    u.uLineA.value =
      (mine !== null ? 0.95 : 0.55 + Math.sin(t * 2) * 0.1) * pop;
    // The crystal: gold to the hold (eased, so a word from the room
    // glides), a glint every few seconds while nobody's holding it.
    const c = parts.u;
    c.uCharge.value += (held - c.uCharge.value) * (1 - Math.exp(-dt * 8));
    c.uBurst.value = held > 0 ? 0 : 0.35 * Math.max(0, Math.sin(t * 1.7)) ** 16;
    const fill = c.uCharge.value;
    parts.angle += Math.min(dt, 0.1) * (0.4 + 4 * fill * fill);
    if (parts.body) parts.body.scale.setScalar(pop * TREASURE_SCALE);
    if (parts.spin) {
      const shake =
        Math.max(0, (fill - TREMBLE_FROM) / (1 - TREMBLE_FROM)) * 0.06;
      parts.spin.rotation.y = parts.angle;
      parts.spin.position.set(
        (Math.random() - 0.5) * shake,
        TREASURE_FLOAT + Math.sin(t * 1.3) * 0.08,
        (Math.random() - 0.5) * shake,
      );
    }
  });
  return (
    <>
      <group
        ref={(g) => {
          parts.body = g;
        }}
        position={[cache.x, ground, cache.z]}
        scale={0}
      >
        <group
          ref={(g) => {
            parts.spin = g;
          }}
          position-y={TREASURE_FLOAT}
        >
          <mesh
            geometry={HUNT_CRYSTAL_GEOMETRY}
            material={parts.crystal}
            castShadow
          />
        </group>
        <points
          geometry={HUNT_MOTE_GEOMETRY}
          material={parts.motes}
          position-y={TREASURE_FLOAT}
          frustumCulled={false}
        />
      </group>
      <CylinderCollider
        args={[0.8, 0.45]}
        position={[cache.x, ground + 0.8, cache.z]}
      />
      {/* In the island's frame: its points stand on the ground themselves. */}
      <mesh geometry={ringGeometry} material={ring} />
    </>
  );
}

/** How long a treasure crystal's burst lasts (s), its flash's share of
 * that, how many shards fly, and how far its ring rolls out. */
const BURST_S = 1.4;
const FLASH_S = 0.45;
const SHARDS = 16;
const BURST_RING = 9;
const GRAVITY = 14;

const shardGeometry = new THREE.OctahedronGeometry(0.11, 0).scale(1, 1.8, 1);
const flashGeometry = new THREE.IcosahedronGeometry(1, 2);

/**
 * A treasure crystal opened: it explodes where it floated, a flash of
 * gold-white swelling and gone, shards of gold flung out and falling, a
 * ring rolling out over the ground, all over in BURST_S. A burst over
 * stays hidden till the next.
 */
function CacheBurst({
  at,
  map,
}: {
  at: { x: number; z: number; at: number };
  map: TownMap;
}) {
  const y = groundY(map, at.x, at.z) + TREASURE_FLOAT * TREASURE_SCALE;
  const parts = useMemo(() => {
    const u: HuntUniforms = {
      uTime: ambient.uTime,
      uCharge: { value: 1 },
      uHunt: { value: 0 },
      uBurst: { value: 1 },
    };
    const glow = () =>
      new THREE.MeshBasicMaterial({
        color: "#ffd86b",
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    return {
      u,
      ring: huntRingMaterial(u),
      flash: glow(),
      shard: glow(),
      // Each shard's way out: across, up, and how fast it turns.
      flights: Array.from({ length: SHARDS }, (_, i) => {
        const a = (i / SHARDS) * Math.PI * 2 + Math.random() * 0.4;
        const v = 3 + Math.random() * 4;
        return {
          vx: Math.cos(a) * v,
          vz: Math.sin(a) * v,
          vy: 3 + Math.random() * 5,
          spin: (Math.random() - 0.5) * 20,
        };
      }),
      root: null as THREE.Group | null,
      flashMesh: null as THREE.Mesh | null,
      ringMesh: null as THREE.Mesh | null,
      shards: [] as (THREE.Mesh | null)[],
    };
  }, []);
  useEffect(
    () => () => {
      parts.ring.dispose();
      parts.flash.dispose();
      parts.shard.dispose();
    },
    [parts],
  );
  useFrame(() => {
    const s = (performance.now() - at.at) / 1000;
    if (parts.root) parts.root.visible = s >= 0 && s < BURST_S;
    if (s < 0 || s >= BURST_S) return;
    const k = s / BURST_S;
    if (parts.flashMesh) {
      const f = Math.min(1, s / FLASH_S);
      parts.flashMesh.visible = f < 1;
      parts.flashMesh.scale.setScalar(0.4 + 3.2 * (1 - (1 - f) ** 3));
      parts.flash.opacity = (1 - f) ** 2;
    }
    parts.u.uBurst.value = (1 - k) ** 2;
    parts.ringMesh?.scale.setScalar(1 + (1 - (1 - k) ** 2) * BURST_RING);
    parts.shard.opacity = 1 - k * k;
    parts.flights.forEach((f, i) => {
      const m = parts.shards[i];
      if (!m) return;
      m.position.set(f.vx * s, f.vy * s - 0.5 * GRAVITY * s * s, f.vz * s);
      m.rotation.set(f.spin * s, f.spin * s * 0.7, 0);
      m.scale.setScalar(1 - k * 0.6);
    });
  });
  return (
    <group
      ref={(g) => {
        parts.root = g;
      }}
      position={[at.x, y, at.z]}
    >
      <mesh
        ref={(m) => {
          parts.flashMesh = m;
        }}
        geometry={flashGeometry}
        material={parts.flash}
      />
      {parts.flights.map((_, i) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed shards
          key={i}
          ref={(m) => {
            parts.shards[i] = m;
          }}
          geometry={shardGeometry}
          material={parts.shard}
        />
      ))}
      <mesh
        ref={(m) => {
          parts.ringMesh = m;
        }}
        geometry={HUNT_RING_GEOMETRY}
        material={parts.ring}
        position-y={0.06 - TREASURE_FLOAT * TREASURE_SCALE}
      />
    </group>
  );
}
