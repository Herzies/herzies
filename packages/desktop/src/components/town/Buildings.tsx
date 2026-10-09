import { mulberry32 } from "@herzies/shared";
import { CuboidCollider } from "@react-three/rapier";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { seeThrough } from "./ambient";
import {
  type Building,
  buildingsOf,
  type CellRect,
  MAP_SIZE,
  type TownMap,
} from "./map";

// Houses after the early Pokémon towns: short cream walls on a dark
// footing, a big striped roof in a bold colour that does most of the
// talking, a round framed door with a step and a mailbox, framed windows either
// side of it, and a chimney on the bigger ones.

/** Doors are sized for a stage-3 herzie (about 2.35 tall and round):
 * this wide across, their bottom a little sunk into the step. */
const DOOR_RADIUS = 1.25;
const DOOR_Y = 1.15;
/** Window rows (their middles): downstairs, tops level with the door's;
 * upstairs, in the middle of the second storey. Between them, a trim band
 * marks the floor. */
const GROUND_FLOOR = 1.95;
const UPSTAIRS = 3.6;
const FLOOR_BAND = 2.86;

/** Wall height, and how far the roof reaches past the walls. */
const WALL = 4.6;
const OVERHANG = 0.35;
const FOOTING = 0.28;
/** Roof strips are about this deep, alternating light and dark. */
const STRIP = 0.32;
const WALLS = ["#efe6cf", "#f3eee2", "#e9dcc0", "#efe2d0"];
/** Roof colours, light and dark strip: red, blue, green, orange, purple. */
const ROOFS: [string, string][] = [
  ["#d4483b", "#a8332b"],
  ["#4a7fd0", "#3560a6"],
  ["#4fa35c", "#3a7d45"],
  ["#e08a3a", "#b86a28"],
  ["#8f5cc2", "#6f449c"],
];
const FOOTING_COLOR = "#7c7268";
const TRIM = "#fbf8f0";
/** Hobbit-door colours: green, brown, red, blue. */
const DOORS = ["#3f7a3a", "#5a3a24", "#9a3a2c", "#3a5a8a"];
const DOOR_FRAME = "#c9b28a";
const STEP = "#a29c92";
const CHIMNEY = "#9a5a44";
const MAILBOX = "#d4483b";
const POST = "#6a4a30";

const HALF = MAP_SIZE / 2;

/** A rect's extent in the world. */
function bounds(r: CellRect) {
  const x0 = r.col - HALF;
  const z0 = r.row - HALF;
  return { x0, x1: x0 + r.w, z0, z1: z0 + r.h };
}
type Bounds = ReturnType<typeof bounds>;

/** Paint a geometry one colour, in the shape mergeGeometries wants: no
 * index, no uvs, normals and colours. */
function painted(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  if (!out.attributes.normal) out.computeVertexNormals();
  const c = new THREE.Color(color);
  const n = out.attributes.position.count;
  out.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(
      Array.from({ length: n * 3 }, (_, i) => [c.r, c.g, c.b][i % 3]),
      3,
    ),
  );
  return out;
}

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

/** A round, flat thing facing out of a wall (+z): a door, a porthole. */
function disc(radius: number, depth: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius, radius, depth, 18).rotateX(
    Math.PI / 2,
  );
}

/** Triangles from points, as one geometry. */
function tris(...pts: number[][]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts.flat(), 3));
  g.computeVertexNormals();
  return g;
}

const lerp3 = (a: number[], b: number[], t: number) =>
  a.map((v, i) => v + (b[i] - v) * t);

/** How a rect's roof sits: the ridge along its longer side. */
function roofShape({ x0, x1, z0, z1 }: Bounds) {
  const alongX = x1 - x0 >= z1 - z0;
  // Worked as if the ridge runs along a (x), across b (z); swapped if not.
  const [a0, a1, b0, b1] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const half = (b1 - b0) / 2;
  const rise = Math.min(4.6, half * 1.5 + 1.5);
  return {
    alongX,
    a0,
    a1,
    b0,
    b1,
    bc: (b0 + b1) / 2,
    half,
    rise,
    top: WALL + rise,
    /** The roof's height above a point `d` across from the ridge. */
    heightAt: (d: number) => WALL + rise - (rise / half) * Math.abs(d),
    p: (a: number, y: number, b: number) => (alongX ? [a, y, b] : [b, y, a]),
  };
}

/** A gabled roof over a rect: each slope in strips, light and dark, a
 * ridge cap, a dark underside, and wall-coloured gable ends. */
function roof(e: Bounds, colors: [string, string], wall: string) {
  const s = roofShape(e);
  const { a0, a1, b0, b1, bc, half, top, p } = s;
  const o = OVERHANG;
  const eave = s.heightAt(half + o);
  const out: THREE.BufferGeometry[] = [];
  for (const [edge, sign] of [
    [b0 - o, -1],
    [b1 + o, 1],
  ] as const) {
    const A = p(a0 - o, eave, edge);
    const B = p(a1 + o, eave, edge);
    const R0 = p(a0 - o, top, bc);
    const R1 = p(a1 + o, top, bc);
    const length = Math.hypot(half + o, top - eave);
    const n = Math.max(3, Math.round(length / STRIP));
    for (let i = 0; i < n; i++) {
      const [t0, t1] = [i / n, (i + 1) / n];
      const P0 = lerp3(A, R0, t0);
      const Q0 = lerp3(B, R1, t0);
      const P1 = lerp3(A, R0, t1);
      const Q1 = lerp3(B, R1, t1);
      out.push(painted(tris(P0, Q0, Q1, P0, Q1, P1), colors[i % 2]));
    }
    // The underside of the overhang.
    const Ai = p(a0 - o, eave, edge - sign * o);
    const Bi = p(a1 + o, eave, edge - sign * o);
    out.push(painted(tris(A, B, Bi, A, Bi, Ai), "#3a3430"));
  }
  // Ridge cap.
  const len = a1 - a0 + 2 * o;
  const cap = s.alongX
    ? box(len, 0.14, 0.26, (a0 + a1) / 2, top, bc)
    : box(0.26, 0.14, len, bc, top, (a0 + a1) / 2);
  out.push(painted(cap, colors[1]));
  // Gable ends, in the wall planes.
  out.push(
    painted(
      tris(
        p(a0, WALL, b0),
        p(a0, top, bc),
        p(a0, WALL, b1),
        p(a1, WALL, b0),
        p(a1, WALL, b1),
        p(a1, top, bc),
      ),
      wall,
    ),
  );
  return out;
}

type Wall = {
  side: "n" | "s" | "e" | "w";
  x: number;
  z: number;
  yaw: number;
  /** Where along this side of the rect, and how long the side is. */
  i: number;
  length: number;
};

/** Each cell's stretch of outside wall: its middle, and which way it
 * faces. */
function outsideWalls(
  r: CellRect,
  isH: (c: number, row: number) => boolean,
): Wall[] {
  const { x0, x1, z0, z1 } = bounds(r);
  const out: Wall[] = [];
  for (let i = 0; i < r.w; i++) {
    const x = x0 + i + 0.5;
    if (!isH(r.col + i, r.row - 1)) {
      out.push({ side: "n", x, z: z0, yaw: Math.PI, i, length: r.w });
    }
    if (!isH(r.col + i, r.row + r.h)) {
      out.push({ side: "s", x, z: z1, yaw: 0, i, length: r.w });
    }
  }
  for (let i = 0; i < r.h; i++) {
    const z = z0 + i + 0.5;
    if (!isH(r.col - 1, r.row + i)) {
      out.push({ side: "w", x: x0, z, yaw: -Math.PI / 2, i, length: r.h });
    }
    if (!isH(r.col + r.w, r.row + i)) {
      out.push({ side: "e", x: x1, z, yaw: Math.PI / 2, i, length: r.h });
    }
  }
  return out;
}

/** Windows come in pairs either side of a wall's middle, every other
 * cell: a 3-wide front gets one each side of the door. */
function hasWindow({ i, length }: Wall): boolean {
  const d = Math.abs(i - (length - 1) / 2);
  return length % 2 === 1 ? d % 2 === 1 : Math.floor(d) % 2 === 0;
}

/** Whether a stretch of wall gets a window: clear of the big round door
 * (and then every other cell out from it), or the usual pattern on walls
 * without one. */
function windowFits(w: Wall, door: Door | null): boolean {
  const d = alongDoorWall(w, door);
  if (d !== null) return d > DOOR_RADIUS + 0.5 && Math.round(d) % 2 === 0;
  return hasWindow(w);
}

type Door = { x: number; z: number; yaw: number };

/** How far along the door's wall a stretch of wall is from the door, or
 * null if it's on another wall. */
function alongDoorWall(w: Wall, door: Door | null): number | null {
  if (!door || Math.abs(w.yaw - door.yaw) > 1e-6) return null;
  const facesZ = Math.abs(Math.cos(door.yaw)) > 0.5;
  if (Math.abs(facesZ ? w.z - door.z : w.x - door.x) > 0.01) return null;
  return Math.abs(facesZ ? w.x - door.x : w.z - door.z);
}

/** Something flat on a wall: `out` in front of it, at `y`, facing `yaw`. */
function onWall(
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  yaw: number,
  out: number,
): THREE.BufferGeometry {
  g.translate(0, y, out);
  g.rotateY(yaw);
  return g.translate(x, 0, z);
}

/** Whether a cell is part of this building. */
function partOf(b: Building): (c: number, r: number) => boolean {
  const cells = new Set(
    b.rects.flatMap((r) =>
      Array.from(
        { length: r.w * r.h },
        (_, i) => `${r.col + (i % r.w)},${r.row + Math.floor(i / r.w)}`,
      ),
    ),
  );
  return (c, r) => cells.has(`${c},${r}`);
}

/** Where the door is: mid-way along its side, facing out (yaw). */
function doorAt(b: Building): { x: number; z: number; yaw: number } | null {
  if (!b.door) return null;
  const r = bounds(b.rects[b.door.rect]);
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const [x, z, yaw] = {
    n: [cx, r.z0, Math.PI],
    s: [cx, r.z1, 0],
    w: [r.x0, cz, -Math.PI / 2],
    e: [r.x1, cz, Math.PI / 2],
  }[b.door.side];
  return { x, z, yaw };
}

/** Steady per building, but neighbours differ. */
const randomFor = (b: Building) =>
  mulberry32(Math.imul(b.seed, 2654435761) ^ 0x9e3779b9);

/** A framed window, lit from inside, with a cross of glazing bars. */
function framedWindow(
  w: Wall,
  body: THREE.BufferGeometry[],
  glow: THREE.BufferGeometry[],
  y = GROUND_FLOOR,
) {
  const on = (g: THREE.BufferGeometry, dy: number, out: number) =>
    onWall(g, w.x, y + dy, w.z, w.yaw, out);
  body.push(
    painted(on(new THREE.BoxGeometry(0.78, 0.98, 0.06), 0, 0.02), TRIM),
    painted(on(new THREE.BoxGeometry(0.05, 0.82, 0.04), 0, 0.08), TRIM),
    painted(on(new THREE.BoxGeometry(0.62, 0.05, 0.04), 0, 0.08), TRIM),
    painted(on(new THREE.BoxGeometry(0.88, 0.07, 0.14), -0.52, 0.05), TRIM),
  );
  glow.push(on(new THREE.BoxGeometry(0.62, 0.82, 0.04), 0, 0.05));
}

/** Where a home's chimney stands (if it's big enough for one): its
 * footing on the roof, and how tall it is. */
function chimneyAt(b: Building) {
  const main = b.rects[0];
  if (main.w * main.h < 4) return null;
  const s = roofShape(bounds(main));
  const a = s.a0 + (s.a1 - s.a0) * 0.72;
  const d = s.half * 0.45;
  const base = s.heightAt(d) - 0.25;
  const h = s.top + 0.45 - base;
  const [x, , z] = s.p(a, 0, s.bc + d);
  return { x, z, base, h };
}

/** The tops of every chimney on the map, for smoke (see Particles). */
export function chimneysOf(map: TownMap): [number, number, number][] {
  return buildingsOf(map).flatMap((b) => {
    if (b.kind !== "home") return [];
    // The same draws, in the same order, as homeGeometry makes.
    const rand = randomFor(b);
    rand();
    rand();
    const c = rand() < 0.65 ? chimneyAt(b) : null;
    return c
      ? [[c.x, c.base + c.h + 0.1, c.z] as [number, number, number]]
      : [];
  });
}

/** A home: cream walls, a big striped gabled roof, a framed door with a
 * step and a mailbox, windows either side, maybe a chimney. */
function homeGeometry(b: Building) {
  const isH = partOf(b);
  const rand = randomFor(b);
  const wall = WALLS[Math.floor(rand() * WALLS.length)];
  const roofColors = ROOFS[Math.floor(rand() * ROOFS.length)];
  const chimney = rand() < 0.65;
  const doorColor = DOORS[Math.floor(rand() * DOORS.length)];
  const body: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];

  // The door, with its frame, a step and a mailbox.
  const door = doorAt(b);
  if (door) {
    const { x, z, yaw } = door;
    const at = (
      g: THREE.BufferGeometry,
      y: number,
      out: number,
      color: string,
    ) => body.push(painted(onWall(g, x, y, z, yaw, out), color));
    // A round door, like a hobbit's (herzies are round too), in a frame,
    // with its knob in the middle.
    at(disc(DOOR_RADIUS + 0.14, 0.08), DOOR_Y, 0.03, DOOR_FRAME);
    at(disc(DOOR_RADIUS, 0.08), DOOR_Y, 0.07, doorColor);
    at(disc(0.11, 0.08), DOOR_Y, 0.14, "#e0c060");
    at(new THREE.BoxGeometry(2.1, 0.12, 0.6), 0.06, 0.32, STEP);
    // The mailbox, on a post off to the door's right.
    const side = new THREE.Vector3(1, 0, 0).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yaw,
    );
    const mx = x + side.x * 1.75;
    const mz = z + side.z * 1.75;
    body.push(
      painted(
        onWall(new THREE.BoxGeometry(0.07, 0.7, 0.07), mx, 0.35, mz, yaw, 0.7),
        POST,
      ),
      painted(
        onWall(new THREE.BoxGeometry(0.22, 0.2, 0.3), mx, 0.78, mz, yaw, 0.7),
        MAILBOX,
      ),
    );
  }

  for (const r of b.rects) {
    const e = bounds(r);
    const cx = (e.x0 + e.x1) / 2;
    const cz = (e.z0 + e.z1) / 2;
    body.push(
      painted(box(r.w, WALL, r.h, cx, WALL / 2, cz), wall),
      // A dark footing, and a white band under the eaves.
      painted(
        box(r.w + 0.08, FOOTING, r.h + 0.08, cx, FOOTING / 2, cz),
        FOOTING_COLOR,
      ),
      // (Kept below the roof: it stands proud of the walls, and the roof
      // slopes down past them.)
      painted(box(r.w + 0.04, 0.1, r.h + 0.04, cx, WALL - 0.17, cz), TRIM),
      painted(box(r.w + 0.04, 0.1, r.h + 0.04, cx, FLOOR_BAND, cz), TRIM),
      ...roof(e, roofColors, wall),
    );
    for (const w of outsideWalls(r, isH)) {
      if (windowFits(w, door)) framedWindow(w, body, glow);
      // Upstairs: a row of windows, and a round one over the door.
      const d = alongDoorWall(w, door);
      if (d !== null && d < 0.1) {
        const at = (g: THREE.BufferGeometry, out: number) =>
          onWall(g, w.x, UPSTAIRS, w.z, w.yaw, out);
        body.push(painted(at(disc(0.46, 0.06), 0.02), TRIM));
        glow.push(at(disc(0.34, 0.04), 0.05));
      } else if (hasWindow(w)) {
        framedWindow(w, body, glow, UPSTAIRS);
      }
    }
  }

  // A brick chimney on the bigger houses, poking out of the back slope.
  const c = chimney ? chimneyAt(b) : null;
  if (c) {
    const { x, z, base, h } = c;
    body.push(
      painted(box(0.36, h, 0.36, x, base + h / 2, z), CHIMNEY),
      painted(box(0.44, 0.1, 0.44, x, base + h, z), "#6a3a2c"),
    );
  }

  return { body, glow };
}

/** Shops: white walls a little taller than a home's, a flat roof in the
 * shop's colour with a dark cornice, a sign over glass double doors, and
 * big lit shop windows under striped awnings along the front — a Poké
 * Mart, more or less. Other walls get ordinary windows. */
const SHOP_WALL_HEIGHT = 5.2;
const SHOP_WALL = "#f4f2ec";
/** The sign: just over the door, however tall the shop. */
const SIGN_Y = 3.0;
/** The shop's upstairs windows, over a band at SHOP_FLOOR_BAND. */
const SHOP_UPSTAIRS = 4.2;
const SHOP_FLOOR_BAND = 3.55;
const SHOPS: [string, string][] = [
  ["#3f72d0", "#2c559f"],
  ["#d4483b", "#a8332b"],
  ["#4fa35c", "#3a7d45"],
  ["#e08a3a", "#b86a28"],
];

function shopGeometry(b: Building) {
  const isPart = partOf(b);
  const [color, dark] = SHOPS[Math.floor(randomFor(b)() * SHOPS.length)];
  const H = SHOP_WALL_HEIGHT;
  const body: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const door = doorAt(b);
  if (door) {
    const { x, z, yaw } = door;
    const at = (g: THREE.BufferGeometry, y: number, out: number, c: string) =>
      body.push(painted(onWall(g, x, y, z, yaw, out), c));
    // A round glass door in a dark frame, split down the middle.
    at(disc(DOOR_RADIUS + 0.14, 0.08), DOOR_Y, 0.03, "#3a3a44");
    glow.push(onWall(disc(DOOR_RADIUS, 0.04), x, DOOR_Y, z, yaw, 0.07));
    at(
      new THREE.BoxGeometry(0.08, DOOR_RADIUS * 2, 0.04),
      DOOR_Y,
      0.1,
      "#3a3a44",
    );
    at(new THREE.BoxGeometry(2.3, 0.12, 0.6), 0.06, 0.32, STEP);
    // The sign: a board in the shop's colour with a white band across it.
    at(new THREE.BoxGeometry(2.4, 0.6, 0.1), SIGN_Y, 0.06, color);
    at(new THREE.BoxGeometry(2.0, 0.14, 0.06), SIGN_Y, 0.13, TRIM);
  }

  for (const r of b.rects) {
    const e = bounds(r);
    const cx = (e.x0 + e.x1) / 2;
    const cz = (e.z0 + e.z1) / 2;
    body.push(
      painted(box(r.w, H, r.h, cx, H / 2, cz), SHOP_WALL),
      painted(
        box(r.w + 0.08, FOOTING, r.h + 0.08, cx, FOOTING / 2, cz),
        FOOTING_COLOR,
      ),
      // The flat roof: a cornice, the roof itself, and a low step on top.
      painted(box(r.w + 0.04, 0.1, r.h + 0.04, cx, SHOP_FLOOR_BAND, cz), dark),
      painted(box(r.w + 0.5, 0.12, r.h + 0.5, cx, H + 0.02, cz), dark),
      painted(box(r.w + 0.4, 0.28, r.h + 0.4, cx, H + 0.22, cz), color),
      painted(
        box(
          Math.max(0.3, r.w - 0.4),
          0.18,
          Math.max(0.3, r.h - 0.4),
          cx,
          H + 0.44,
          cz,
        ),
        dark,
      ),
    );
    for (const w of outsideWalls(r, isPart)) {
      if (door && Math.hypot(w.x - door.x, w.z - door.z) < DOOR_RADIUS + 0.3) {
        continue;
      }
      if (b.door && w.side === b.door.side) {
        // Shop window: big, framed, under a striped awning.
        const on = (g: THREE.BufferGeometry, y: number, out: number) =>
          onWall(g, w.x, y, w.z, w.yaw, out);
        body.push(
          painted(
            on(new THREE.BoxGeometry(0.94, 1.32, 0.06), 1.5, 0.02),
            "#3a3a44",
          ),
        );
        glow.push(on(new THREE.BoxGeometry(0.82, 1.2, 0.04), 1.5, 0.05));
        for (let i = 0; i < 4; i++) {
          const strip = new THREE.BoxGeometry(0.25, 0.04, 0.6).rotateX(0.45);
          strip.translate(-0.375 + i * 0.25, 0, 0);
          body.push(painted(on(strip, 2.4, 0.3), i % 2 === 0 ? color : TRIM));
        }
      } else if (hasWindow(w)) {
        framedWindow(w, body, glow);
      }
      // Upstairs windows all round, above the awnings and the sign.
      if (hasWindow(w) && !(door && alongDoorWall(w, door) === 0)) {
        framedWindow(w, body, glow, SHOP_UPSTAIRS);
      }
    }
  }
  return { body, glow };
}

/** Caves: a mound of mossy rock over the patch, highest in the middle,
 * with a dark arched mouth (framed in boulders) facing town. */
const ROCK = new THREE.Color("#8a8072");
const DEEP_ROCK = new THREE.Color("#5e564d");
const MOSS = new THREE.Color("#567f40");

function caveGeometry(b: Building) {
  const isPart = partOf(b);
  const body: THREE.BufferGeometry[] = [];
  const cells = b.rects.flatMap((r) =>
    Array.from({ length: r.w * r.h }, (_, i) => [
      r.col + (i % r.w),
      r.row + Math.floor(i / r.w),
    ]),
  );
  // How far in from the edge each cell is (1 at the edge).
  const depth = (c: number, r: number) => {
    for (let d = 1; d < 8; d++) {
      for (let dr = -d; dr <= d; dr++) {
        for (let dc = -d; dc <= d; dc++) {
          if (!isPart(c + dc, r + dr)) return d;
        }
      }
    }
    return 8;
  };
  for (const [c, r] of cells) {
    const rand = mulberry32(c * 7919 + r * 104729 + 31);
    const h = Math.min(7.5, 2.4 + depth(c, r) * 1.7) + (rand() - 0.5) * 0.6;
    const wide = 1.2 + rand() * 0.3;
    const g = new THREE.IcosahedronGeometry(1, 1);
    g.scale(wide, h, wide);
    g.rotateY(rand() * Math.PI);
    g.translate(c - HALF + 0.5, 0, r - HALF + 0.5);
    // Rock darkening toward the ground, moss on top.
    const pos = g.attributes.position;
    const colors: number[] = [];
    const col = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, pos.getY(i)) / h;
      if (t > 0.86) col.copy(MOSS);
      else col.lerpColors(DEEP_ROCK, ROCK, Math.min(1, t * 1.6));
      colors.push(col.r, col.g, col.b);
    }
    g.deleteAttribute("uv");
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    body.push(g);
  }
  const door = doorAt(b);
  if (door) {
    const { x, z, yaw } = door;
    // The mouth: round, like every door here, and running back into the
    // rock, so it reads as a hole from any angle. (Its bottom sinks into
    // the ground.)
    body.push(
      painted(
        onWall(disc(DOOR_RADIUS + 0.1, 2.4), x, DOOR_Y, z, yaw, -0.3),
        "#15120f",
      ),
    );
    // Boulders framing it.
    for (const [dx, y, s] of [
      [-1.55, 0.6, 0.7],
      [1.55, 0.6, 0.7],
      [-0.95, 2.2, 0.65],
      [0.95, 2.3, 0.68],
      [0, 2.65, 0.6],
    ]) {
      const g = new THREE.IcosahedronGeometry(s, 0);
      g.translate(dx, 0, 0);
      body.push(painted(onWall(g, x, y, z, yaw, 1.0), "#6b6258"));
    }
  }
  return { body, glow: [] as THREE.BufferGeometry[] };
}

/** Every part of a building, by kind, merged. */
function buildingGeometry(b: Building) {
  const { body, glow } =
    b.kind === "shop"
      ? shopGeometry(b)
      : b.kind === "cave"
        ? caveGeometry(b)
        : homeGeometry(b);
  return {
    body: mergeGeometries(body) as THREE.BufferGeometry,
    glow:
      glow.length > 0 ? (mergeGeometries(glow) as THREE.BufferGeometry) : null,
  };
}

const bodyMaterial = seeThrough(
  new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    side: THREE.DoubleSide,
  }),
);
/** Unlit, so the windows glow against the evening sky; the day cycle
 * turns them down by day (see DayLight). */
export const windowMaterial = seeThrough(
  new THREE.MeshBasicMaterial({ color: "#ffd98a" }),
);

/**
 * The buildings — homes, shops and caves — each patch of cells as one,
 * its door toward the middle of town. All of them merged into one mesh
 * (plus one for the lit windows).
 */
export function Buildings({ map }: { map: TownMap }) {
  const built = useMemo(() => {
    const parts = buildingsOf(map).map(buildingGeometry);
    if (parts.length === 0) return null;
    const glows = parts.flatMap((p) => (p.glow ? [p.glow] : []));
    return {
      body: mergeGeometries(parts.map((p) => p.body)) as THREE.BufferGeometry,
      glow:
        glows.length > 0
          ? (mergeGeometries(glows) as THREE.BufferGeometry)
          : null,
    };
  }, [map]);
  useLayoutEffect(
    () => () => {
      built?.body.dispose();
      built?.glow?.dispose();
    },
    [built],
  );
  if (!built) return null;
  return (
    <>
      <mesh
        geometry={built.body}
        material={bodyMaterial}
        castShadow
        receiveShadow
      />
      {built.glow && <mesh geometry={built.glow} material={windowMaterial} />}
    </>
  );
}

/** A box collider per building rectangle. */
export function BuildingColliders({ map }: { map: TownMap }) {
  const rects = useMemo(() => buildingsOf(map).flatMap((b) => b.rects), [map]);
  return (
    <>
      {rects.map((r) => {
        const e = bounds(r);
        return (
          <CuboidCollider
            key={`h${r.col},${r.row}`}
            args={[r.w / 2, WALL / 2, r.h / 2]}
            position={[(e.x0 + e.x1) / 2, WALL / 2, (e.z0 + e.z1) / 2]}
          />
        );
      })}
    </>
  );
}
