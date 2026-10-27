import { ELITE, gapColour, MOB, WARDEN } from "@herzies/shared/tower";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NAME_SHADOW } from "../nameFade";
import { liveDummies } from "./Dummies";
import { type DummyState, newTarget } from "./dummy";
import {
  bossFight,
  MOB_DELAY_MS,
  type MobView,
  mobAt,
  towerMobs,
  useBossFight,
} from "./fight";

/**
 * The Tower's mobs: Thornlings, little bramble balls with glowing eyes,
 * drawn where the server says they are (a moment behind, smoothly). Green
 * brutes, purple spitters (a snout to lob from) and long-spined red
 * lungers; an elite is bigger and gilded, the Warden huge and dark. Each
 * crouches and reddens as it winds up an attack, flashes when hit, and
 * shrinks into the grass when it falls. A tag over it gives its level,
 * coloured by how far above you it is, and its health.
 *
 * Each living mob also stands in the training dummies' list, so the aim,
 * the aim assist and the waves find it the same way; the server judges
 * what they did.
 */
export function Mobs() {
  useBossFight();
  const ids = [...towerMobs.keys()];
  return (
    <>
      {ids.map((id) => (
        <Mob key={`${bossFight.tower?.floor}:${id}`} id={id} />
      ))}
    </>
  );
}

/** How long a fallen mob takes to shrink away, ms. */
const FALL_MS = 450;
const FLASH_MS = 120;

/** A Thornling's colours and spines. */
type Breed = {
  body: string;
  bramble: readonly string[];
  leaf: string;
  eye: string;
  foot: string;
  /** Spine length. */
  spine: number;
  /** A snout to spit from. */
  snout?: string;
};

const BREEDS = {
  brute: {
    body: "#3f7f3a",
    bramble: ["#2f6a2c", "#4f9a46", "#5fae4f"],
    leaf: "#7fc96b",
    eye: "#ffe36b",
    foot: "#5a3e26",
    spine: 0.32,
  },
  spitter: {
    body: "#6a4a9a",
    bramble: ["#4f3478", "#7c5bb0", "#9670c8"],
    leaf: "#c39be8",
    eye: "#b8ff6b",
    foot: "#3e2f52",
    spine: 0.22,
    snout: "#9fe05c",
  },
  lunger: {
    body: "#8e3a2a",
    bramble: ["#6e2a1e", "#b0503a", "#c8664a"],
    leaf: "#e08a5a",
    eye: "#fff3d6",
    foot: "#4a2a1e",
    spine: 0.48,
  },
  warden: {
    body: "#2c3a2a",
    bramble: ["#1e2a1c", "#3c4e38", "#d4af37"],
    leaf: "#d4af37",
    eye: "#ff5a3c",
    foot: "#2a1e14",
    spine: 0.4,
  },
} as const satisfies Record<string, Breed>;

function part(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  const c = new THREE.Color(color);
  out.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(
      Array.from(
        { length: out.attributes.position.count * 3 },
        (_, i) => [c.r, c.g, c.b][i % 3],
      ),
      3,
    ),
  );
  return out;
}

/** A Thornling, facing +z, standing on the ground at the origin. */
function thornling(b: Breed): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const r = MOB.radius;
  const cy = MOB.chest;
  parts.push(
    part(new THREE.IcosahedronGeometry(r, 1).translate(0, cy, 0), b.body),
  );
  // Spikes all over it, leaning out from the middle.
  const spikes = 18;
  for (let i = 0; i < spikes; i++) {
    const y = 1 - (2 * (i + 0.5)) / spikes;
    const a = i * 2.39996;
    const ring = Math.sqrt(1 - y * y);
    const dir = new THREE.Vector3(Math.cos(a) * ring, y, Math.sin(a) * ring);
    // None straight down (it stands there), none over the face.
    if (dir.y < -0.6 || (dir.z > 0.55 && Math.abs(dir.y) < 0.45)) continue;
    const cone = new THREE.ConeGeometry(0.09, b.spine, 4);
    cone.translate(0, b.spine / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir,
    );
    cone.applyQuaternion(q);
    cone.translate(dir.x * r * 0.9, cy + dir.y * r * 0.9, dir.z * r * 0.9);
    parts.push(part(cone, b.bramble[i % b.bramble.length]));
  }
  // A leaf on top.
  parts.push(
    part(
      new THREE.ConeGeometry(0.16, 0.36, 3)
        .rotateZ(0.5)
        .translate(0.1, cy + r + 0.12, 0),
      b.leaf,
    ),
  );
  // Eyes, glowing.
  for (const sx of [-1, 1])
    parts.push(
      part(
        new THREE.SphereGeometry(0.075, 6, 4)
          .scale(1, 1.4, 0.6)
          .translate(sx * 0.17, cy + 0.08, r * 0.93),
        b.eye,
      ),
    );
  // A spitter's snout, under the eyes.
  if (b.snout)
    parts.push(
      part(
        new THREE.CylinderGeometry(0.08, 0.13, 0.26, 6)
          .rotateX(Math.PI / 2)
          .translate(0, cy - 0.12, r * 0.98),
        b.snout,
      ),
    );
  // Stubby feet.
  for (const sx of [-1, 1])
    parts.push(
      part(
        new THREE.SphereGeometry(0.13, 6, 4)
          .scale(1, 0.6, 1.3)
          .translate(sx * 0.2, 0.08, 0.05),
        b.foot,
      ),
    );
  return mergeGeometries(parts) as THREE.BufferGeometry;
}
const GEOMETRY = {
  brute: thornling(BREEDS.brute),
  spitter: thornling(BREEDS.spitter),
  lunger: thornling(BREEDS.lunger),
  warden: thornling(BREEDS.warden),
};

/** How much bigger than a plain mob it's drawn. */
const scaleOf = (m: MobView) =>
  m.rank === 2 ? WARDEN.scale : m.rank === 1 ? ELITE.scale : 1;

const TAG_W = 128;
const TAG_H = 40;
const GAP_COLOURS = {
  grey: "#9a9aa0",
  white: "#f2f2f2",
  orange: "#ffb347",
  red: "#ff5a4f",
} as const;

/** The health bar over a mob, drawn on a canvas. (Its level is a label
 * over it: text this small doesn't survive the Town's pixelation.) */
function drawTag(ctx: CanvasRenderingContext2D, hp: number, maxHp: number) {
  ctx.clearRect(0, 0, TAG_W, TAG_H);
  const w = 100;
  const x = (TAG_W - w) / 2;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x - 2, 26, w + 4, 10);
  ctx.fillStyle = "#e0453a";
  ctx.fillRect(x, 28, w * Math.max(0, Math.min(1, hp / maxHp)), 6);
}

/** Re-rendered only when its own props change, not on every fight update. */
const Mob = memo(function Mob({ id }: { id: number }) {
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Mesh>(null);
  const tag = useRef<THREE.Sprite>(null);
  const material = useMemo(
    () =>
      new THREE.MeshLambertMaterial({
        vertexColors: true,
        flatShading: true,
        emissive: new THREE.Color("#ffffff"),
        emissiveIntensity: 0,
      }),
    [],
  );
  const canvas = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = TAG_W;
    c.height = TAG_H;
    return c;
  }, []);
  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [canvas]);
  const tagMaterial = useMemo(
    () =>
      new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        transparent: true,
      }),
    [texture],
  );
  useEffect(
    () => () => {
      material.dispose();
      texture.dispose();
      tagMaterial.dispose();
    },
    [material, texture, tagMaterial],
  );

  // Stands in the dummies' list while it's up, for the aim and the waves.
  const target = useRef<DummyState | null>(null);
  useLayoutEffect(() => {
    const m = towerMobs.get(id);
    if (!m) return;
    const at = mobAt(m, performance.now() - MOB_DELAY_MS);
    const t = newTarget(`mob${id}`, at.x, at.z, at.yaw, id);
    t.size = scaleOf(m);
    target.current = t;
    liveDummies.push(t);
    return () => {
      const i = liveDummies.indexOf(t);
      if (i >= 0) liveDummies.splice(i, 1);
    };
  }, [id]);

  const tower = bossFight.tower;
  const view = towerMobs.get(id);
  const kind = view?.kind ?? "brute";
  const rank = view?.rank ?? 0;
  const size = view ? scaleOf(view) : 1;
  const drawn = useRef({ hp: -1 });
  const label = useRef<HTMLDivElement>(null);
  const crouch = useRef(0);
  useFrame((_, frameDt) => {
    const m: MobView | undefined = towerMobs.get(id);
    const g = group.current;
    if (!m || !g) return;
    const dt = Math.min(frameDt, 0.1);
    const now = performance.now();
    const at = mobAt(m, now - MOB_DELAY_MS);
    g.position.set(at.x, 0, at.z);
    g.rotation.y = at.yaw;

    // Fallen: out of the targets, and shrinking into the grass.
    const t = target.current;
    if (m.downAt !== null) {
      if (t) {
        const i = liveDummies.indexOf(t);
        if (i >= 0) liveDummies.splice(i, 1);
        target.current = null;
      }
      const u = Math.min(1, (now - m.downAt) / FALL_MS);
      g.scale.setScalar(Math.max(0.001, 1 - u * u));
      g.position.y = -u * 0.3;
      if (tag.current) tag.current.visible = false;
      if (label.current) label.current.style.display = "none";
      if (u >= 1) g.visible = false;
      return;
    }
    if (t) {
      t.x = at.x;
      t.z = at.z;
      t.yaw = at.yaw;
    }
    // Winding up: it crouches and goes red; then springs back.
    crouch.current +=
      ((m.windup ? 1 : 0) - crouch.current) * (1 - Math.exp(-dt * 10));
    const c = crouch.current;
    const bob = Math.sin(now / 180 + id) * 0.03 * (1 - c);
    if (body.current) {
      const k = scaleOf(m);
      body.current.scale.set(
        k * (1 + c * 0.15),
        k * (1 - c * 0.22 + bob),
        k * (1 + c * 0.15),
      );
    }
    const flash = Math.max(0, 1 - (now - m.hitAt) / FLASH_MS);
    // An elite smoulders gold between swings.
    const glow = m.rank === 1 ? 0.12 + 0.06 * Math.sin(now / 240 + id) : 0;
    if (c > 0.02 || flash > 0 || !glow) {
      material.emissive.setRGB(1, 1 - c * 0.85, 1 - c * 0.85);
      material.emissiveIntensity = Math.max(flash ** 2 * 0.9, c * 0.45);
    } else {
      material.emissive.setRGB(1, 0.8, 0.3);
      material.emissiveIntensity = glow;
    }

    // The health bar, in the Tower and the cave alike.
    if (tag.current) {
      const d = drawn.current;
      if (d.hp !== m.hp) {
        const ctx = canvas.getContext("2d");
        if (ctx) drawTag(ctx, m.hp, m.maxHp);
        texture.needsUpdate = true;
        d.hp = m.hp;
      }
    }
  });

  return (
    <group ref={group}>
      <mesh
        ref={body}
        geometry={GEOMETRY[rank === 2 ? "warden" : kind]}
        material={material}
        castShadow
        receiveShadow
      />
      <sprite
        ref={tag}
        material={tagMaterial}
        position-y={MOB.top * size + 0.45}
        scale={[1.3, (1.3 * TAG_H) / TAG_W, 1]}
        renderOrder={10}
      />
      {tower ? (
        // Just over the bar, as a name tag is: crisp at any pixel size.
        <Html
          position={[0, MOB.top * size + 0.56, 0]}
          center
          zIndexRange={[19, 0]}
        >
          <div
            ref={label}
            className="pointer-events-none whitespace-nowrap text-[11px] font-bold leading-none"
            style={{
              color: GAP_COLOURS[gapColour(tower.level - tower.you)],
              textShadow: NAME_SHADOW,
            }}
          >
            Lv {tower.level}
            {rank === 2 ? " Warden" : rank === 1 ? " Elite" : ""}
          </div>
        </Html>
      ) : null}
    </group>
  );
});
