import { gapColour, MOB } from "@herzies/shared/tower";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
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
 * drawn where the server says they are (a moment behind, smoothly). Each
 * crouches and reddens as it winds up a swing, flashes when hit, and
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

const BODY = "#3f7f3a";
const BRAMBLE = ["#2f6a2c", "#4f9a46", "#5fae4f"];
const EYE = "#ffe36b";
const FOOT = "#5a3e26";

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
function thornling(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const r = MOB.radius;
  const cy = MOB.chest;
  parts.push(
    part(new THREE.IcosahedronGeometry(r, 1).translate(0, cy, 0), BODY),
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
    const cone = new THREE.ConeGeometry(0.09, 0.32, 4);
    cone.translate(0, 0.16, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir,
    );
    cone.applyQuaternion(q);
    cone.translate(dir.x * r * 0.9, cy + dir.y * r * 0.9, dir.z * r * 0.9);
    parts.push(part(cone, BRAMBLE[i % BRAMBLE.length]));
  }
  // A leaf on top.
  parts.push(
    part(
      new THREE.ConeGeometry(0.16, 0.36, 3)
        .rotateZ(0.5)
        .translate(0.1, cy + r + 0.12, 0),
      "#7fc96b",
    ),
  );
  // Eyes, glowing.
  for (const sx of [-1, 1])
    parts.push(
      part(
        new THREE.SphereGeometry(0.075, 6, 4)
          .scale(1, 1.4, 0.6)
          .translate(sx * 0.17, cy + 0.08, r * 0.93),
        EYE,
      ),
    );
  // Stubby feet.
  for (const sx of [-1, 1])
    parts.push(
      part(
        new THREE.SphereGeometry(0.13, 6, 4)
          .scale(1, 0.6, 1.3)
          .translate(sx * 0.2, 0.08, 0.05),
        FOOT,
      ),
    );
  return mergeGeometries(parts) as THREE.BufferGeometry;
}
const GEOMETRY = thornling();

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

function Mob({ id }: { id: number }) {
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
    target.current = t;
    liveDummies.push(t);
    return () => {
      const i = liveDummies.indexOf(t);
      if (i >= 0) liveDummies.splice(i, 1);
    };
  }, [id]);

  const tower = bossFight.tower;
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
      body.current.scale.set(1 + c * 0.15, 1 - c * 0.22 + bob, 1 + c * 0.15);
    }
    const flash = Math.max(0, 1 - (now - m.hitAt) / FLASH_MS);
    material.emissive.setRGB(1, 1 - c * 0.85, 1 - c * 0.85);
    material.emissiveIntensity = Math.max(flash ** 2 * 0.9, c * 0.45);

    const tower = bossFight.tower;
    if (tower && tag.current) {
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
        geometry={GEOMETRY}
        material={material}
        castShadow
        receiveShadow
      />
      <sprite
        ref={tag}
        material={tagMaterial}
        position-y={MOB.top + 0.45}
        scale={[1.3, (1.3 * TAG_H) / TAG_W, 1]}
        renderOrder={10}
      />
      {tower ? (
        // Just over the bar, as a name tag is: crisp at any pixel size.
        <Html position={[0, MOB.top + 0.56, 0]} center zIndexRange={[19, 0]}>
          <div
            ref={label}
            className="pointer-events-none whitespace-nowrap text-[11px] font-bold leading-none"
            style={{
              color: GAP_COLOURS[gapColour(tower.level - tower.you)],
              textShadow: NAME_SHADOW,
            }}
          >
            Lv {tower.level}
          </div>
        </Html>
      ) : null}
    </group>
  );
}
