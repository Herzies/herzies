import { DUEL } from "@herzies/shared/duel";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { entityAt } from "../combat/skills";
import { groundY, type TownMap } from "../map";
import { NAME_SHADOW } from "../nameFade";
import { townSave } from "../runtime";
import { duelFeel, MARKER_DROP_MS, stepDuelFeel, WINNER_MS } from "./feel";
import { kneeling } from "./fx";
import { type DuelView, duel, localOf, RING_FADE_MS, useDuel } from "./store";

/**
 * Duels in the world: each one's ring on the ground (a thin line everyone
 * sees, its nearest stretch glowing up into a low wall as a duelist comes
 * to the edge), the marker that drops in at its middle, music notes
 * circling a beaten herzie, and WINNER over the one who won. Also runs the
 * duel's moments on the clock (feel.ts).
 */

/** Segments round a ring. */
const SEGMENTS = 96;
/** The ring line's width, and the wall's height (world units). */
const LINE = 0.15;
const WALL = 1;
/** The ring drawn outward after the marker lands (ms). */
const DRAW_MS = 350;
/** The marker's squash on landing (ms), and the height it drops from. */
const SQUASH_MS = 120;
const DROP_FROM = 6;
/** How bright the ring is, seen from anywhere. */
const BASE = 0.35;
/** Within this of the edge, the stretch nearest you lights up. */
const EDGE_BAND = DUEL.ringRadius - DUEL.ringWarn;

const CALM = new THREE.Color("#9fe8ff");
const SUDDEN = new THREE.Color("#ffae3a");
const MARKER = new THREE.Color("#ffd84a");

export function DuelScene({ map }: { map: TownMap }) {
  useDuel();
  useFrame(() => stepDuelFeel(performance.now()));
  return (
    <>
      {[...duel.rooms.values()].map((d) => (
        <Ring key={d.id} duel={d} map={map} />
      ))}
      <Floaters />
    </>
  );
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** One duel's ring and marker. */
function Ring({ duel: d, map }: { duel: DuelView; map: TownMap }) {
  const parts = useMemo(() => {
    const line = new THREE.BufferGeometry();
    const wall = new THREE.BufferGeometry();
    const verts = SEGMENTS * 4;
    for (const g of [line, wall]) {
      g.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(verts * 3), 3),
      );
      g.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(verts * 3), 3),
      );
      const index: number[] = [];
      for (let i = 0; i < SEGMENTS; i++) {
        const o = i * 4;
        index.push(o, o + 1, o + 2, o + 2, o + 1, o + 3);
      }
      g.setIndex(index);
    }
    const glow = () =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    const marker = new THREE.MeshBasicMaterial({
      color: MARKER,
      transparent: true,
      toneMapped: false,
    });
    return {
      line,
      wall,
      lineMat: glow(),
      wallMat: glow(),
      marker,
      pole: new THREE.CylinderGeometry(0.05, 0.07, 1.7, 8),
      flag: new THREE.BoxGeometry(0.6, 0.38, 0.04),
      knob: new THREE.SphereGeometry(0.11, 12, 8),
      /** The radius last laid out (re-laid only while it grows). */
      laid: -1,
    };
  }, []);
  useEffect(
    () => () => {
      for (const x of [
        parts.line,
        parts.wall,
        parts.lineMat,
        parts.wallMat,
        parts.marker,
        parts.pole,
        parts.flag,
        parts.knob,
      ])
        x.dispose();
    },
    [parts],
  );
  const markerGroup = useRef<THREE.Group>(null);
  const colour = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
    const now = performance.now();
    const fade =
      d.endedAt === null
        ? 1
        : Math.max(0, 1 - (now - d.endedAt) / RING_FADE_MS);
    // The marker falls, lands with a squash, and the ring runs out from it.
    const since = now - d.seenAt;
    const fall = Math.min(1, Math.max(0, since / MARKER_DROP_MS));
    const landed = since - MARKER_DROP_MS;
    const grown = landed <= 0 ? 0 : easeOut(Math.min(1, landed / DRAW_MS));
    const radius = DUEL.ringRadius * grown;
    if (Math.abs(radius - parts.laid) > 1e-3) {
      layOut(parts.line, parts.wall, d, map, radius);
      parts.laid = radius;
    }
    // Sudden death turns it gold-red, and it beats.
    const sudden = d.endedAt === null && now >= localOf(d.suddenAt);
    colour.copy(sudden ? SUDDEN : CALM);
    const beat = sudden ? 0.85 + 0.15 * Math.sin(now / 120) : 1;
    // Yours: the stretch nearest you lights up as you near the edge.
    const mine = d.a === duel.you || d.b === duel.you;
    const off = Math.hypot(townSave.x - d.x, townSave.z - d.z);
    const edge =
      mine && d.endedAt === null
        ? Math.min(
            1,
            Math.max(0, (off - (DUEL.ringRadius - EDGE_BAND)) / EDGE_BAND),
          )
        : 0;
    const toward = Math.atan2(townSave.x - d.x, townSave.z - d.z);
    paint(parts.line, parts.wall, colour, BASE * beat, edge, toward);
    parts.lineMat.opacity = fade;
    parts.wallMat.opacity = fade;
    parts.line.attributes.color.needsUpdate = true;
    parts.wall.attributes.color.needsUpdate = true;
    const g = markerGroup.current;
    if (g) {
      const y = groundY(map, d.x, d.z);
      g.position.set(d.x, y + (1 - fall * fall) * DROP_FROM, d.z);
      const squash =
        landed > 0 && landed < SQUASH_MS
          ? 0.85 + 0.15 * (landed / SQUASH_MS)
          : 1;
      g.scale.set(fade, squash * fade, fade);
      g.visible = fade > 0.01 && since >= 0;
      parts.marker.opacity = fade;
    }
  });

  return (
    <>
      <mesh
        geometry={parts.line}
        material={parts.lineMat}
        frustumCulled={false}
      />
      <mesh
        geometry={parts.wall}
        material={parts.wallMat}
        frustumCulled={false}
      />
      <group ref={markerGroup}>
        <mesh geometry={parts.pole} material={parts.marker} position-y={0.85} />
        <mesh
          geometry={parts.flag}
          material={parts.marker}
          position={[0.32, 1.45, 0]}
        />
        <mesh geometry={parts.knob} material={parts.marker} position-y={1.75} />
      </group>
    </>
  );
}

/** The ring's line (flat on the ground, following it up and down) and its
 * wall, at `radius`. */
function layOut(
  line: THREE.BufferGeometry,
  wall: THREE.BufferGeometry,
  d: DuelView,
  map: TownMap,
  radius: number,
) {
  const lp = line.attributes.position.array as Float32Array;
  const wp = wall.attributes.position.array as Float32Array;
  const inner = Math.max(0, radius - LINE / 2);
  const outer = radius + LINE / 2;
  for (let i = 0; i < SEGMENTS; i++) {
    const a0 = (i / SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
    const o = i * 12;
    let k = 0;
    for (const a of [a0, a1]) {
      const sx = Math.sin(a);
      const cz = Math.cos(a);
      const x = d.x + sx * radius;
      const z = d.z + cz * radius;
      const y = groundY(map, x, z) + 0.05;
      // Line: inner and outer edge.
      lp[o + k] = d.x + sx * inner;
      lp[o + k + 1] = y;
      lp[o + k + 2] = d.z + cz * inner;
      lp[o + k + 3] = d.x + sx * outer;
      lp[o + k + 4] = y;
      lp[o + k + 5] = d.z + cz * outer;
      // Wall: foot and top.
      wp[o + k] = x;
      wp[o + k + 1] = y;
      wp[o + k + 2] = z;
      wp[o + k + 3] = x;
      wp[o + k + 4] = y + WALL;
      wp[o + k + 5] = z;
      k += 6;
    }
  }
  line.attributes.position.needsUpdate = true;
  wall.attributes.position.needsUpdate = true;
  line.computeBoundingSphere();
  wall.computeBoundingSphere();
}

/** Colours the ring: `base` all round, brightening toward angle `toward`
 * by `edge` (0–1), where the wall rises too, fading up its height. */
function paint(
  line: THREE.BufferGeometry,
  wall: THREE.BufferGeometry,
  colour: THREE.Color,
  base: number,
  edge: number,
  toward: number,
) {
  const lc = line.attributes.color.array as Float32Array;
  const wc = wall.attributes.color.array as Float32Array;
  for (let i = 0; i < SEGMENTS; i++) {
    const o = i * 12;
    let k = 0;
    for (const step of [i, i + 1]) {
      const a = (step / SEGMENTS) * Math.PI * 2;
      const off = Math.abs(
        Math.atan2(Math.sin(a - toward), Math.cos(a - toward)),
      );
      const near = edge * Math.exp(-(off * off) / 0.12);
      const l = base + (1 - base) * near;
      const w = near * 0.8;
      for (let j = 0; j < 3; j++) {
        const c = j === 0 ? colour.r : j === 1 ? colour.g : colour.b;
        lc[o + k + j] = c * l;
        lc[o + k + 3 + j] = c * l;
        wc[o + k + j] = c * w;
        wc[o + k + 3 + j] = 0;
      }
      k += 6;
    }
  }
}

/** Notes circling herzies on their knees, and WINNER over those who won. */
function Floaters() {
  const [shown, setShown] = useState<{ notes: number[]; winners: number[] }>({
    notes: [],
    winners: [],
  });
  const key = useRef("");
  useFrame(() => {
    const now = performance.now();
    const notes: number[] = [];
    for (const d of duel.rooms.values())
      for (const id of [d.a, d.b]) if (kneeling(id, now)) notes.push(id);
    const winners: number[] = [];
    for (const [id, at] of duelFeel.winners)
      if (now - at < WINNER_MS) winners.push(id);
    const k = `${notes.join(",")}|${winners.join(",")}`;
    if (k !== key.current) {
      key.current = k;
      setShown({ notes, winners });
    }
  });
  return (
    <>
      {shown.notes.map((id) => (
        <Over key={`n${id}`} id={id} lift={0.15}>
          <div
            aria-hidden
            className="pointer-events-none relative h-6 w-12 -translate-x-1/2 -translate-y-full text-[13px] text-[#ffd84a]"
            style={{ textShadow: NAME_SHADOW }}
          >
            {["♪", "♫", "♪"].map((n, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: three fixed notes
                key={i}
                className="absolute top-1/2 left-1/2 motion-safe:animate-[duel-notes_1.4s_linear_infinite]"
                style={{ animationDelay: `${(-1.4 * i) / 3}s` }}
              >
                {n}
              </span>
            ))}
          </div>
        </Over>
      ))}
      {shown.winners.map((id) => (
        <Over key={`w${id}`} id={id} lift={0.9}>
          <div
            role="status"
            className="pointer-events-none -translate-x-1/2 -translate-y-full text-[13px] font-black tracking-widest text-[#ffd84a] [text-shadow:0_2px_0_#3a2200,0_0_10px_rgba(255,190,60,0.7)] motion-safe:animate-[duel-winner_1.5s_ease-out_forwards]"
          >
            WINNER
          </div>
        </Over>
      ))}
    </>
  );
}

/** Something over herzie `id`'s head, following it. */
function Over({
  id,
  lift,
  children,
}: {
  id: number;
  lift: number;
  children: React.ReactNode;
}) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const at = entityAt.get(id);
    if (at && g.current) g.current.position.set(at.x, at.top + lift, at.z);
  });
  return (
    <group ref={g}>
      <Html zIndexRange={[18, 0]}>{children}</Html>
    </group>
  );
}
