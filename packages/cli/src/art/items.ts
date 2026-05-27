import chalk from "chalk";

export type Rarity = "common" | "uncommon" | "rare" | "legendary";

export interface ItemDef {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  art: string[];
  frames: string[][];
  stackable?: boolean;
  equipable?: boolean;
  equipSlot?: "head";
  sellPrice?: number;
}

export const RARITY_COLORS: Record<Rarity, string> = {
  common: "#9d9d9d",
  uncommon: "#1eff00",
  rare: "#0070dd",
  legendary: "#ff8000",
};

export const RARITY_LABELS: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  legendary: "Legendary",
};

// --- 3D Math ---
type V3 = [number, number, number];
type V2 = [number, number];

function rotY(p: V3, a: number): V3 {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

function rotZ(p: V3, a: number): V3 {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(v: V3): V3 {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// --- Constants ---
const SW = 30; // screen width
const SH = 18; // screen height
const CHAR_ASPECT = 2.1; // terminal chars are ~2x taller than wide
const CARD_HW = 0.85; // card half-width
const CARD_HH = 1.3; // card half-height
const TILT = 12 * (Math.PI / 180);
const CAM = 4.5;
const LIGHT = norm([0.4, -0.6, -0.8]);
const RAMP = " .·:;=+*#%@█";

// Card corners: TL, TR, BR, BL
const CORNERS: V3[] = [
  [-CARD_HW, -CARD_HH, 0],
  [CARD_HW, -CARD_HH, 0],
  [CARD_HW, CARD_HH, 0],
  [-CARD_HW, CARD_HH, 0],
];
const UVS: V2[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

// --- Card textures ---
function frontTexture(u: number, v: number): number {
  const bw = 0.055;
  // Outer border
  if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) return 0.9;

  // Inner border line
  const ib = 0.11;
  const ibw = 0.012;
  if (
    (u > ib - ibw && u < ib + ibw && v > ib && v < 1 - ib) ||
    (u > 1 - ib - ibw && u < 1 - ib + ibw && v > ib && v < 1 - ib) ||
    (v > ib - ibw && v < ib + ibw && u > ib && u < 1 - ib) ||
    (v > 1 - ib - ibw && v < 1 - ib + ibw && u > ib && u < 1 - ib)
  )
    return 0.65;

  // Corner diamonds (diamond shape)
  const diamonds: V2[] = [
    [0.16, 0.1],
    [0.84, 0.1],
    [0.16, 0.9],
    [0.84, 0.9],
  ];
  for (const [dx, dy] of diamonds) {
    const du = Math.abs(u - dx) / 0.035;
    const dv = Math.abs(v - dy) / 0.045;
    if (du + dv < 1) return 1.0;
  }

  // Large "1" in center — built from rectangles
  const cx = 0.5,
    cy = 0.5;
  const blocks: [number, number, number, number][] = [
    // Vertical stem
    [cx - 0.03, cy - 0.16, cx + 0.03, cy + 0.13],
    // Top serif / flag
    [cx - 0.08, cy - 0.13, cx - 0.02, cy - 0.09],
    [cx - 0.055, cy - 0.16, cx - 0.02, cy - 0.13],
    // Base
    [cx - 0.09, cy + 0.13, cx + 0.09, cy + 0.17],
  ];
  for (const [x1, y1, x2, y2] of blocks) {
    if (u >= x1 && u <= x2 && v >= y1 && v <= y2) return 0.95;
  }

  // Card face background
  return 0.3;
}

function backTexture(u: number, v: number): number {
  const bw = 0.055;
  if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) return 0.7;

  // Crosshatch pattern
  const g = 0.065;
  const w = 0.018;
  const onU = u % g < w;
  const onV = v % g < w;
  if (onU || onV) return 0.5;
  return 0.28;
}

// --- Projection ---
function project(p: V3): V2 {
  const z = p[2] + CAM;
  const s = CAM / z;
  return [
    SW / 2 + p[0] * s * SW * 0.22 * CHAR_ASPECT,
    SH / 2 + p[1] * s * SH * 0.28,
  ];
}

// --- Barycentric UV interpolation in a triangle ---
function triUV(
  px: number,
  py: number,
  ax: number,
  ay: number,
  au: number,
  av: number,
  bx: number,
  by: number,
  bu: number,
  bv: number,
  cx: number,
  cy: number,
  cu: number,
  cv: number,
): V2 | null {
  const v0x = cx - ax,
    v0y = cy - ay;
  const v1x = bx - ax,
    v1y = by - ay;
  const v2x = px - ax,
    v2y = py - ay;

  const d00 = v0x * v0x + v0y * v0y;
  const d01 = v0x * v1x + v0y * v1y;
  const d02 = v0x * v2x + v0y * v2y;
  const d11 = v1x * v1x + v1y * v1y;
  const d12 = v1x * v2x + v1y * v2y;

  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-10) return null;

  const inv = 1 / den;
  const s = (d11 * d02 - d01 * d12) * inv;
  const t = (d00 * d12 - d01 * d02) * inv;

  if (s < -0.001 || t < -0.001 || s + t > 1.001) return null;
  const w = 1 - s - t;
  return [w * au + t * bu + s * cu, w * av + t * bv + s * cv];
}

// --- Render a single frame ---
function renderFrame(yAngle: number): string[] {
  // Transform corners
  const xf = CORNERS.map((v) => rotY(rotZ(v, TILT), yAngle));

  // Face normal
  const e1: V3 = [
    xf[1][0] - xf[0][0],
    xf[1][1] - xf[0][1],
    xf[1][2] - xf[0][2],
  ];
  const e2: V3 = [
    xf[3][0] - xf[0][0],
    xf[3][1] - xf[0][1],
    xf[3][2] - xf[0][2],
  ];
  const faceN = norm(cross(e1, e2));
  const front = faceN[2] < 0;
  const diffuse = Math.abs(dot3(faceN, LIGHT));

  // Project
  const pr = xf.map((v) => project(v));

  // Rasterize
  const bright: number[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(-1),
  );
  const isContent: boolean[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(false),
  );

  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < SW; sx++) {
      const px = sx + 0.5,
        py = sy + 0.5;

      // Try two triangles: 0-1-2 and 0-2-3
      const uv =
        triUV(
          px,
          py,
          pr[0][0],
          pr[0][1],
          UVS[0][0],
          UVS[0][1],
          pr[1][0],
          pr[1][1],
          UVS[1][0],
          UVS[1][1],
          pr[2][0],
          pr[2][1],
          UVS[2][0],
          UVS[2][1],
        ) ??
        triUV(
          px,
          py,
          pr[0][0],
          pr[0][1],
          UVS[0][0],
          UVS[0][1],
          pr[2][0],
          pr[2][1],
          UVS[2][0],
          UVS[2][1],
          pr[3][0],
          pr[3][1],
          UVS[3][0],
          UVS[3][1],
        );

      if (!uv) continue;

      let [u, v] = uv;
      if (!front) u = 1 - u; // mirror for back face

      const tex = front ? frontTexture(u, v) : backTexture(u, v);
      const lit = tex * (0.2 + 0.8 * diffuse);
      bright[sy][sx] = lit;
      isContent[sy][sx] = front && tex > 0.5;
    }
  }

  // Map to colored characters
  const g = chalk.hex("#FFD700");
  const d = chalk.hex("#8B6914");
  const b = chalk.hex("#654A0E");

  return bright.map((row, y) =>
    row
      .map((val, x) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP.length - 1)),
          RAMP.length - 1,
        );
        const ch = RAMP[idx];
        if (ch === " ") return " ";
        return isContent[y][x] ? g(ch) : front ? d(ch) : b(ch);
      })
      .join(""),
  );
}

// --- Generate all frames ---
function generateFrames(): string[][] {
  const frames: string[][] = [];
  const spinCount = 36;

  for (let i = 0; i < spinCount; i++) {
    frames.push(renderFrame((i / spinCount) * Math.PI * 2));
  }

  return frames;
}

const firstEditionFrames = generateFrames();

// --- CD disc rendering ---
const CD_RADIUS = 1.1;
const CD_HOLE = 0.18; // center hole radius

/** Check if a 3D point (on the XY plane) is inside the disc */
function insideDisc(u: number, v: number): boolean {
  const dx = u - 0.5,
    dy = v - 0.5;
  const r = Math.sqrt(dx * dx + dy * dy);
  return r <= 0.5;
}

function cdFrontTexture(u: number, v: number): number {
  const dx = u - 0.5,
    dy = v - 0.5;
  const r = Math.sqrt(dx * dx + dy * dy);

  // Outside disc
  if (r > 0.5) return -1;
  // Center hole
  if (r < 0.08) return -1;
  // Hole rim
  if (r < 0.1) return 0.9;

  // Concentric ring pattern (rainbow-ish data tracks)
  const ring = (r * 40) % 1;
  const base = 0.3 + 0.4 * (1 - r / 0.5); // brighter toward center

  // Thin shiny rings
  if (ring < 0.15) return base + 0.2;
  // Label area (inner ring)
  if (r > 0.14 && r < 0.25) return 0.55;

  return base;
}

function cdBackTexture(u: number, v: number): number {
  const dx = u - 0.5,
    dy = v - 0.5;
  const r = Math.sqrt(dx * dx + dy * dy);

  if (r > 0.5) return -1;
  if (r < 0.08) return -1;
  if (r < 0.1) return 0.7;

  // Plain reflective back
  return 0.35 + 0.15 * Math.sin(r * 30);
}

// CD uses a circular bounding quad, same rendering approach
const CD_HW = CD_RADIUS;
const CD_HH = CD_RADIUS;
const CD_CORNERS: V3[] = [
  [-CD_HW, -CD_HH, 0],
  [CD_HW, -CD_HH, 0],
  [CD_HW, CD_HH, 0],
  [-CD_HW, CD_HH, 0],
];

function renderCdFrame(yAngle: number): string[] {
  const xf = CD_CORNERS.map((v) => rotY(rotZ(v, TILT), yAngle));

  const e1: V3 = [
    xf[1][0] - xf[0][0],
    xf[1][1] - xf[0][1],
    xf[1][2] - xf[0][2],
  ];
  const e2: V3 = [
    xf[3][0] - xf[0][0],
    xf[3][1] - xf[0][1],
    xf[3][2] - xf[0][2],
  ];
  const faceN = norm(cross(e1, e2));
  const front = faceN[2] < 0;
  const diffuse = Math.abs(dot3(faceN, LIGHT));

  const pr = xf.map((v) => project(v));

  const bright: number[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(-1),
  );

  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < SW; sx++) {
      const px = sx + 0.5,
        py = sy + 0.5;

      const uv =
        triUV(
          px,
          py,
          pr[0][0],
          pr[0][1],
          UVS[0][0],
          UVS[0][1],
          pr[1][0],
          pr[1][1],
          UVS[1][0],
          UVS[1][1],
          pr[2][0],
          pr[2][1],
          UVS[2][0],
          UVS[2][1],
        ) ??
        triUV(
          px,
          py,
          pr[0][0],
          pr[0][1],
          UVS[0][0],
          UVS[0][1],
          pr[2][0],
          pr[2][1],
          UVS[2][0],
          UVS[2][1],
          pr[3][0],
          pr[3][1],
          UVS[3][0],
          UVS[3][1],
        );

      if (!uv) continue;

      let [u, v] = uv;
      if (!front) u = 1 - u;

      const tex = front ? cdFrontTexture(u, v) : cdBackTexture(u, v);
      if (tex < 0) continue; // outside disc or center hole

      const lit = tex * (0.2 + 0.8 * diffuse);
      bright[sy][sx] = lit;
    }
  }

  // Silver/iridescent color scheme
  const s = chalk.hex("#C0C0C0");
  const h = chalk.hex("#E8E8E8");
  const d = chalk.hex("#808080");

  return bright.map((row) =>
    row
      .map((val) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP.length - 1)),
          RAMP.length - 1,
        );
        const ch = RAMP[idx];
        if (ch === " ") return " ";
        return val > 0.6 ? h(ch) : val > 0.35 ? s(ch) : d(ch);
      })
      .join(""),
  );
}

function generateCdFrames(): string[][] {
  const frames: string[][] = [];
  const spinCount = 36;
  for (let i = 0; i < spinCount; i++) {
    frames.push(renderCdFrame((i / spinCount) * Math.PI * 2));
  }
  return frames;
}

const cdFrames = generateCdFrames();

// --- Headphones rendering (ray-traced) ---

/** Ray-sphere intersection: returns distance or -1 */
function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  sx: number,
  sy: number,
  sz: number,
  sr: number,
): [number, V3] | null {
  const ex = ox - sx,
    ey = oy - sy,
    ez = oz - sz;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ex * dx + ey * dy + ez * dz);
  const c = ex * ex + ey * ey + ez * ez - sr * sr;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) return null;
  const hx = ox + dx * t - sx,
    hy = oy + dy * t - sy,
    hz = oz + dz * t - sz;
  const il = 1 / sr;
  return [t, [hx * il, hy * il, hz * il]];
}

/** Ray-torus intersection for headband arc (thin tube swept along arc) */
function rayTorus(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  arcR: number,
  tubeR: number,
  centers: V3[],
): [number, V3] | null {
  // Approximate torus as chain of small spheres along the arc
  let best: [number, V3] | null = null;
  for (const c of centers) {
    const hit = raySphere(ox, oy, oz, dx, dy, dz, c[0], c[1], c[2], tubeR);
    if (hit && (best === null || hit[0] < best[0])) best = hit;
  }
  return best;
}

function renderHeadphonesFrame(yAngle: number): string[] {
  const bright: number[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(-1),
  );
  const zone: string[][] = Array.from({ length: SH }, () => Array(SW).fill(""));

  const cosA = Math.cos(yAngle),
    sinA = Math.sin(yAngle);

  // Build headband arc points in 3D (semicircle in XY plane, then rotated)
  const arcR = 1.7; // headband radius
  const tubeR = 0.14; // tube thickness
  const cupR = 0.72; // ear cup sphere radius
  const cupY = 0.45; // ear cup vertical position
  const padR = 0.35; // ear pad (inner disc) radius

  const bandPts: V3[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI; // 0..PI semicircle
    const lx = Math.cos(t) * arcR;
    const ly = -Math.sin(t) * arcR * 0.85 - 0.15;
    const lz = 0;
    bandPts.push([lx * cosA + lz * sinA, ly, -lx * sinA + lz * cosA]);
  }

  // Connector bars from band end to cup center
  const connPts: V3[] = [];
  for (const side of [-1, 1]) {
    const bx = side * arcR;
    const topY = -0.15; // bottom of arc at endpoints
    for (let j = 0; j <= 8; j++) {
      const frac = j / 8;
      const cx2 = bx;
      const cy2 = topY + frac * (cupY - topY);
      connPts.push([cx2 * cosA, cy2, -cx2 * sinA]);
    }
  }

  // Ear cup centers (at ends of headband, lowered)
  const leftCup: V3 = [-arcR * cosA, cupY, arcR * sinA];
  const rightCup: V3 = [arcR * cosA, cupY, -arcR * sinA];

  // Inner ear pad spheres (slightly recessed, darker)
  const leftPad: V3 = [
    -arcR * cosA - sinA * 0.15,
    cupY,
    arcR * sinA - cosA * 0.15,
  ];
  const rightPad: V3 = [
    arcR * cosA + sinA * 0.15,
    cupY,
    -arcR * sinA + cosA * 0.15,
  ];

  // Camera setup - perspective projection matching card/CD style
  const camZ = -CAM;
  const fov = 2.2;

  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < SW; sx++) {
      // Normalized screen coords
      const nx = (((sx + 0.5) / SW - 0.5) * fov * (SW / SH)) / CHAR_ASPECT;
      const ny = ((sy + 0.5) / SH - 0.5) * fov;

      // Ray direction
      const rd = norm([nx, ny, 1]);

      let bestT = Infinity;
      let bestN: V3 = [0, 0, 0];
      let bestZone = "";

      // Test ear cups
      for (const [cup, label] of [
        [leftCup, "cup"],
        [rightCup, "cup"],
      ] as [V3, string][]) {
        const hit = raySphere(
          0,
          0,
          camZ,
          rd[0],
          rd[1],
          rd[2],
          cup[0],
          cup[1],
          cup[2],
          cupR,
        );
        if (hit && hit[0] < bestT) {
          bestT = hit[0];
          bestN = hit[1];
          bestZone = label;
        }
      }

      // Test ear pads (inner circle on cups)
      for (const pad of [leftPad, rightPad]) {
        const hit = raySphere(
          0,
          0,
          camZ,
          rd[0],
          rd[1],
          rd[2],
          pad[0],
          pad[1],
          pad[2],
          padR,
        );
        if (hit && hit[0] < bestT) {
          bestT = hit[0];
          bestN = hit[1];
          bestZone = "pad";
        }
      }

      // Test headband (chain of spheres)
      const bandHit = rayTorus(
        0,
        0,
        camZ,
        rd[0],
        rd[1],
        rd[2],
        arcR,
        tubeR,
        bandPts,
      );
      if (bandHit && bandHit[0] < bestT) {
        bestT = bandHit[0];
        bestN = bandHit[1];
        bestZone = "band";
      }

      // Test connectors
      const connHit = rayTorus(
        0,
        0,
        camZ,
        rd[0],
        rd[1],
        rd[2],
        arcR,
        tubeR * 0.8,
        connPts,
      );
      if (connHit && connHit[0] < bestT) {
        bestT = connHit[0];
        bestN = connHit[1];
        bestZone = "band";
      }

      if (bestT < Infinity) {
        const diffuse = Math.max(0, -dot3(bestN, LIGHT));
        const ambient = 0.2;
        // Specular highlight
        const ref: V3 = [
          bestN[0] * 2 * dot3(bestN, LIGHT) - LIGHT[0],
          bestN[1] * 2 * dot3(bestN, LIGHT) - LIGHT[1],
          bestN[2] * 2 * dot3(bestN, LIGHT) - LIGHT[2],
        ];
        const spec = Math.max(0, -ref[2]) ** 16 * 0.3;
        const lit = Math.min(1, ambient + diffuse * 0.65 + spec);
        bright[sy][sx] = lit;
        zone[sy][sx] = bestZone;
      }
    }
  }

  const bandColor = chalk.hex("#888888");
  const bandHi = chalk.hex("#BBBBBB");
  const cupColor = chalk.hex("#c084fc");
  const cupHighlight = chalk.hex("#e0b0ff");
  const padColor = chalk.hex("#3a3a3a");

  return bright.map((row, y) =>
    row
      .map((val, x) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP.length - 1)),
          RAMP.length - 1,
        );
        const ch = RAMP[idx];
        if (ch === " ") return " ";
        if (zone[y][x] === "pad") return padColor(ch);
        if (zone[y][x] === "cup")
          return val > 0.6 ? cupHighlight(ch) : cupColor(ch);
        return val > 0.55 ? bandHi(ch) : bandColor(ch);
      })
      .join(""),
  );
}

function generateHeadphonesFrames(): string[][] {
  const frames: string[][] = [];
  for (let i = 0; i < 36; i++) {
    frames.push(renderHeadphonesFrame((i / 36) * Math.PI * 2));
  }
  return frames;
}

const headphonesFrames = generateHeadphonesFrames();

// --- Rainbow headband rendering ---

const RAINBOW_HEADBAND_COLORS = [
  "#FF6B6B",
  "#FFA94D",
  "#FFD43B",
  "#69DB7C",
  "#4DABF7",
  "#9775FA",
  "#F783AC",
];

function rayChainColored(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  centers: V3[],
  radius: number,
  colors: string[],
): [number, V3, string] | null {
  let best: [number, V3, string] | null = null;
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i];
    const hit = raySphere(ox, oy, oz, dx, dy, dz, c[0], c[1], c[2], radius);
    if (hit && (best === null || hit[0] < best[0])) {
      best = [hit[0], hit[1], colors[i % colors.length]];
    }
  }
  return best;
}

function pickCloserColoredHit(
  a: [number, V3, string] | null,
  b: [number, V3, string] | null,
): [number, V3, string] | null {
  if (!a) return b;
  if (!b) return a;
  return a[0] < b[0] ? a : b;
}

function rotateBandPoint(
  lx: number,
  ly: number,
  lz: number,
  cosA: number,
  sinA: number,
): V3 {
  return [lx * cosA + lz * sinA, ly, -lx * sinA + lz * cosA];
}

function rainbowAlongArc(t: number): string {
  const idx =
    Math.floor(t * RAINBOW_HEADBAND_COLORS.length) %
    RAINBOW_HEADBAND_COLORS.length;
  return RAINBOW_HEADBAND_COLORS[idx];
}

function traceThickBand(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  pts: V3[],
  colors: string[],
  tubeR: number,
): [number, V3, string] | null {
  const topPts = pts.map(([x, y, z]) => [x, y + tubeR * 0.42, z] as V3);
  const bottomPts = pts.map(([x, y, z]) => [x, y - tubeR * 0.28, z] as V3);
  return pickCloserColoredHit(
    rayChainColored(ox, oy, oz, dx, dy, dz, pts, colors, tubeR),
    pickCloserColoredHit(
      rayChainColored(ox, oy, oz, dx, dy, dz, topPts, colors, tubeR * 0.72),
      rayChainColored(ox, oy, oz, dx, dy, dz, bottomPts, colors, tubeR * 0.66),
    ),
  );
}

function renderRainbowHeadbandFrame(yAngle: number): string[] {
  const bright: number[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(-1),
  );
  const bandColor: string[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(""),
  );

  const cosA = Math.cos(yAngle),
    sinA = Math.sin(yAngle);
  const scale = 1.32;
  const ringR = 1.55 * scale;
  const tubeR = 0.28 * scale;
  const centerY = 0.02 * scale;
  const pitchTilt = 0.28;

  const ringPts: V3[] = [];
  const ringColors: string[] = [];
  const segments = 72;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = t * Math.PI * 2;
    const lx = Math.cos(angle) * ringR;
    const ly = centerY + Math.sin(angle) * ringR;
    const pz = -ly * Math.sin(pitchTilt);
    const py = ly * Math.cos(pitchTilt);
    ringPts.push(rotateBandPoint(lx, py, pz, cosA, sinA));
    ringColors.push(rainbowAlongArc(t));
  }

  const camZ = -CAM;
  const fov = 2.2;

  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < SW; sx++) {
      const nx = (((sx + 0.5) / SW - 0.5) * fov * (SW / SH)) / CHAR_ASPECT;
      const ny = ((sy + 0.5) / SH - 0.5) * fov;
      const rd = norm([nx, ny, 1]);

      const hit = traceThickBand(
        0,
        0,
        camZ,
        rd[0],
        rd[1],
        rd[2],
        ringPts,
        ringColors,
        tubeR,
      );
      if (!hit) continue;

      const diffuse = Math.max(0, -dot3(hit[1], LIGHT));
      const ambient = 0.22;
      const ref: V3 = [
        hit[1][0] * 2 * dot3(hit[1], LIGHT) - LIGHT[0],
        hit[1][1] * 2 * dot3(hit[1], LIGHT) - LIGHT[1],
        hit[1][2] * 2 * dot3(hit[1], LIGHT) - LIGHT[2],
      ];
      const spec = Math.max(0, -ref[2]) ** 14 * 0.38;
      bright[sy][sx] = Math.min(1, ambient + diffuse * 0.68 + spec);
      bandColor[sy][sx] = hit[2];
    }
  }

  return bright.map((row, y) =>
    row
      .map((val, x) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP.length - 1)),
          RAMP.length - 1,
        );
        const ch = RAMP[idx];
        if (ch === " ") return " ";
        const hex = bandColor[y][x];
        const c = chalk.hex(hex);
        const hi = chalk.hex(hex);
        return val > 0.6 ? hi(ch) : val > 0.3 ? c(ch) : chalk.hex(hex).dim(ch);
      })
      .join(""),
  );
}

function generateRainbowHeadbandFrames(): string[][] {
  const frames: string[][] = [];
  for (let i = 0; i < 36; i++) {
    frames.push(renderRainbowHeadbandFrame((i / 36) * Math.PI * 2));
  }
  return frames;
}

const rainbowHeadbandFrames = generateRainbowHeadbandFrames();

export const ITEMS: ItemDef[] = [
  {
    id: "first-edition",
    name: "First Edition Card",
    description: "A token of appreciation for early adopters.",
    rarity: "rare",
    art: firstEditionFrames[0],
    frames: firstEditionFrames,
    stackable: false,
    equipable: false,
  },
  {
    id: "cd",
    name: "CD",
    description: "A compact disc earned by listening.",
    rarity: "common",
    art: cdFrames[0],
    frames: cdFrames,
    stackable: true,
    equipable: false,
    sellPrice: 10,
  },
  {
    id: "headphones",
    name: "Headphones",
    description: "Wearable headphones for your herzie.",
    rarity: "uncommon",
    art: headphonesFrames[0],
    frames: headphonesFrames,
    stackable: false,
    equipable: true,
    equipSlot: "head",
  },
  {
    id: "rainbow-headband",
    name: "Rainbow Headband",
    description: "A colourful headband for your herzie.",
    rarity: "uncommon",
    art: rainbowHeadbandFrames[0],
    frames: rainbowHeadbandFrames,
    stackable: false,
    equipable: true,
    equipSlot: "head",
  },
];

export function getItem(id: string): ItemDef | undefined {
  return ITEMS.find((item) => item.id === id);
}
