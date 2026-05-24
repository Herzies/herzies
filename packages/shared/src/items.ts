/**
 * Item definitions with 3D ASCII art renderer.
 * Ported from CLI — uses HTML color spans instead of chalk.
 */

import {
  CHAR_ASPECT,
  col,
  cross,
  dot3,
  LIGHT,
  normV,
  RAMP_ITEM,
  rotY,
  rotZ,
  type V2,
  type V3,
} from "@herzies/shared";

export type Rarity = "common" | "uncommon" | "rare" | "legendary";

/** Equip slot categories — only one item per slot may be equipped at a time. */
export const EQUIP_SLOTS = ["head"] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

export interface ItemDef {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  frames: string[][]; // Each frame is an array of lines (with HTML color spans)
  stackable?: boolean;
  equipable?: boolean;
  /** When set, equipping replaces any other item in the same slot. */
  equipSlot?: EquipSlot;
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

// --- Constants ---
const SW = 30;
const SH = 18;
const CARD_HW = 0.85;
const CARD_HH = 1.3;
const TILT = 12 * (Math.PI / 180);
const CAM = 4.5;

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
  if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) return 0.9;
  const ib = 0.11,
    ibw = 0.012;
  if (
    (u > ib - ibw && u < ib + ibw && v > ib && v < 1 - ib) ||
    (u > 1 - ib - ibw && u < 1 - ib + ibw && v > ib && v < 1 - ib) ||
    (v > ib - ibw && v < ib + ibw && u > ib && u < 1 - ib) ||
    (v > 1 - ib - ibw && v < 1 - ib + ibw && u > ib && u < 1 - ib)
  )
    return 0.65;
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
  const cx = 0.5,
    cy = 0.5;
  const blocks: [number, number, number, number][] = [
    [cx - 0.03, cy - 0.16, cx + 0.03, cy + 0.13],
    [cx - 0.08, cy - 0.13, cx - 0.02, cy - 0.09],
    [cx - 0.055, cy - 0.16, cx - 0.02, cy - 0.13],
    [cx - 0.09, cy + 0.13, cx + 0.09, cy + 0.17],
  ];
  for (const [x1, y1, x2, y2] of blocks) {
    if (u >= x1 && u <= x2 && v >= y1 && v <= y2) return 0.95;
  }
  return 0.3;
}

function backTexture(u: number, v: number): number {
  const bw = 0.055;
  if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) return 0.7;
  const g = 0.065,
    w = 0.018;
  if (u % g < w || v % g < w) return 0.5;
  return 0.28;
}

function project(p: V3): V2 {
  const z = p[2] + CAM;
  const s = CAM / z;
  return [
    SW / 2 + p[0] * s * SW * 0.22 * CHAR_ASPECT,
    SH / 2 + p[1] * s * SH * 0.28,
  ];
}

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
    v0y = cy - ay,
    v1x = bx - ax,
    v1y = by - ay,
    v2x = px - ax,
    v2y = py - ay;
  const d00 = v0x * v0x + v0y * v0y,
    d01 = v0x * v1x + v0y * v1y,
    d02 = v0x * v2x + v0y * v2y,
    d11 = v1x * v1x + v1y * v1y,
    d12 = v1x * v2x + v1y * v2y;
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-10) return null;
  const inv = 1 / den;
  const s = (d11 * d02 - d01 * d12) * inv,
    t = (d00 * d12 - d01 * d02) * inv;
  if (s < -0.001 || t < -0.001 || s + t > 1.001) return null;
  const w = 1 - s - t;
  return [w * au + t * bu + s * cu, w * av + t * bv + s * cv];
}

function renderCardFrame(yAngle: number): string[] {
  const xf = CORNERS.map((v) => rotY(rotZ(v, TILT), yAngle));
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
  const faceN = normV(cross(e1, e2));
  const front = faceN[2] < 0;
  const diffuse = Math.abs(dot3(faceN, LIGHT));
  const pr = xf.map((v) => project(v));

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
      const tex = front ? frontTexture(u, v) : backTexture(u, v);
      const lit = tex * (0.2 + 0.8 * diffuse);
      bright[sy][sx] = lit;
      isContent[sy][sx] = front && tex > 0.5;
    }
  }

  return bright.map((row, y) =>
    row
      .map((val, x) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP_ITEM.length - 1)),
          RAMP_ITEM.length - 1,
        );
        const ch = RAMP_ITEM[idx];
        if (ch === " ") return " ";
        return isContent[y][x]
          ? col("#FFD700", ch)
          : front
            ? col("#8B6914", ch)
            : col("#654A0E", ch);
      })
      .join(""),
  );
}

// --- CD rendering ---
const CD_RADIUS = 1.1;
const CD_CORNERS: V3[] = [
  [-CD_RADIUS, -CD_RADIUS, 0],
  [CD_RADIUS, -CD_RADIUS, 0],
  [CD_RADIUS, CD_RADIUS, 0],
  [-CD_RADIUS, CD_RADIUS, 0],
];

function cdFrontTexture(u: number, v: number): number {
  const dx = u - 0.5,
    dy = v - 0.5;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r > 0.5) return -1;
  if (r < 0.08) return -1;
  if (r < 0.1) return 0.9;
  const ring = (r * 40) % 1;
  const base = 0.3 + 0.4 * (1 - r / 0.5);
  if (ring < 0.15) return base + 0.2;
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
  return 0.35 + 0.15 * Math.sin(r * 30);
}

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
  const faceN = normV(cross(e1, e2));
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
      if (tex < 0) continue;
      const lit = tex * (0.2 + 0.8 * diffuse);
      bright[sy][sx] = lit;
    }
  }

  return bright.map((row) =>
    row
      .map((val) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP_ITEM.length - 1)),
          RAMP_ITEM.length - 1,
        );
        const ch = RAMP_ITEM[idx];
        if (ch === " ") return " ";
        return val > 0.6
          ? col("#E8E8E8", ch)
          : val > 0.35
            ? col("#C0C0C0", ch)
            : col("#808080", ch);
      })
      .join(""),
  );
}

// --- Headphones rendering (ray-traced) ---

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

function rayChain(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  centers: V3[],
  radius: number,
): [number, V3] | null {
  let best: [number, V3] | null = null;
  for (const c of centers) {
    const hit = raySphere(ox, oy, oz, dx, dy, dz, c[0], c[1], c[2], radius);
    if (hit && (best === null || hit[0] < best[0])) best = hit;
  }
  return best;
}

const RAINBOW_HEADBAND_COLORS = [
  "#FF6B6B",
  "#FFA94D",
  "#FFD43B",
  "#69DB7C",
  "#4DABF7",
  "#9775FA",
  "#F783AC",
];

function shadeItemColor(hex: string, brightness: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const scale = brightness > 0.6 ? 1.25 : brightness > 0.3 ? 1 : 0.65;
  const clamp = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v * scale)));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

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

function renderHeadphonesFrame(yAngle: number): string[] {
  const bright: number[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(-1),
  );
  const zone: string[][] = Array.from({ length: SH }, () => Array(SW).fill(""));

  const cosA = Math.cos(yAngle),
    sinA = Math.sin(yAngle);

  const arcR = 1.7;
  const tubeR = 0.14;
  const cupR = 0.72;
  const cupY = 0.45;
  const padR = 0.35;

  // Headband arc points
  const bandPts: V3[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI;
    const lx = Math.cos(t) * arcR;
    const ly = -Math.sin(t) * arcR * 0.85 - 0.15;
    bandPts.push([lx * cosA, ly, -lx * sinA]);
  }

  // Connector bars
  const connPts: V3[] = [];
  for (const side of [-1, 1]) {
    const bx = side * arcR;
    const topY = -0.15;
    for (let j = 0; j <= 8; j++) {
      const frac = j / 8;
      connPts.push([bx * cosA, topY + frac * (cupY - topY), -bx * sinA]);
    }
  }

  const leftCup: V3 = [-arcR * cosA, cupY, arcR * sinA];
  const rightCup: V3 = [arcR * cosA, cupY, -arcR * sinA];
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

  const camZ = -CAM;
  const fov = 2.2;

  for (let sy2 = 0; sy2 < SH; sy2++) {
    for (let sx = 0; sx < SW; sx++) {
      const nx = (((sx + 0.5) / SW - 0.5) * fov * (SW / SH)) / CHAR_ASPECT;
      const ny = ((sy2 + 0.5) / SH - 0.5) * fov;
      const rd = normV([nx, ny, 1]);

      let bestT = Infinity;
      let bestN: V3 = [0, 0, 0];
      let bestZone = "";

      // Ear cups
      for (const cup of [leftCup, rightCup]) {
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
          bestZone = "cup";
        }
      }

      // Ear pads
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

      // Headband
      const bandHit = rayChain(0, 0, camZ, rd[0], rd[1], rd[2], bandPts, tubeR);
      if (bandHit && bandHit[0] < bestT) {
        bestT = bandHit[0];
        bestN = bandHit[1];
        bestZone = "band";
      }

      // Connectors
      const connHit = rayChain(
        0,
        0,
        camZ,
        rd[0],
        rd[1],
        rd[2],
        connPts,
        tubeR * 0.8,
      );
      if (connHit && connHit[0] < bestT) {
        bestT = connHit[0];
        bestN = connHit[1];
        bestZone = "band";
      }

      if (bestT < Infinity) {
        const diffuse = Math.max(0, -dot3(bestN, LIGHT));
        const ambient = 0.2;
        const ref: V3 = [
          bestN[0] * 2 * dot3(bestN, LIGHT) - LIGHT[0],
          bestN[1] * 2 * dot3(bestN, LIGHT) - LIGHT[1],
          bestN[2] * 2 * dot3(bestN, LIGHT) - LIGHT[2],
        ];
        const spec = Math.max(0, -ref[2]) ** 16 * 0.3;
        const lit = Math.min(1, ambient + diffuse * 0.65 + spec);
        bright[sy2][sx] = lit;
        zone[sy2][sx] = bestZone;
      }
    }
  }

  return bright.map((row, y) =>
    row
      .map((val, x) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP_ITEM.length - 1)),
          RAMP_ITEM.length - 1,
        );
        const ch = RAMP_ITEM[idx];
        if (ch === " ") return " ";
        if (zone[y][x] === "pad") return col("#3a3a3a", ch);
        if (zone[y][x] === "cup")
          return val > 0.6 ? col("#e0b0ff", ch) : col("#c084fc", ch);
        return val > 0.55 ? col("#BBBBBB", ch) : col("#888888", ch);
      })
      .join(""),
  );
}

// --- Rainbow headband rendering (circular tilted hoop) ---

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

function offsetBandChain(
  pts: V3[],
  colors: string[],
  dy: number,
): { pts: V3[]; colors: string[] } {
  return {
    pts: pts.map(([x, y, z]) => [x, y + dy, z]),
    colors,
  };
}

function traceHeadbandHit(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  pts: V3[],
  colors: string[],
  radius: number,
): [number, V3, string] | null {
  return rayChainColored(ox, oy, oz, dx, dy, dz, pts, radius, colors);
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
  const top = offsetBandChain(pts, colors, tubeR * 0.42);
  const bottom = offsetBandChain(pts, colors, -tubeR * 0.28);
  return pickCloserColoredHit(
    traceHeadbandHit(ox, oy, oz, dx, dy, dz, pts, colors, tubeR),
    pickCloserColoredHit(
      traceHeadbandHit(
        ox,
        oy,
        oz,
        dx,
        dy,
        dz,
        top.pts,
        top.colors,
        tubeR * 0.72,
      ),
      traceHeadbandHit(
        ox,
        oy,
        oz,
        dx,
        dy,
        dz,
        bottom.pts,
        bottom.colors,
        tubeR * 0.66,
      ),
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

  const cosA = Math.cos(yAngle);
  const sinA = Math.sin(yAngle);

  const scale = 1.32;
  const ringR = 1.55 * scale;
  const tubeR = 0.28 * scale;
  const centerY = 0.02 * scale;
  const pitchTilt = 0.28;

  // Full circular hoop (tilted so the opening faces the viewer — round, not crescent)
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

  for (let sy2 = 0; sy2 < SH; sy2++) {
    for (let sx = 0; sx < SW; sx++) {
      const nx = (((sx + 0.5) / SW - 0.5) * fov * (SW / SH)) / CHAR_ASPECT;
      const ny = ((sy2 + 0.5) / SH - 0.5) * fov;
      const rd = normV([nx, ny, 1]);

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
      bright[sy2][sx] = Math.min(1, ambient + diffuse * 0.68 + spec);
      bandColor[sy2][sx] = hit[2];
    }
  }

  return bright.map((row, y) =>
    row
      .map((val, x) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP_ITEM.length - 1)),
          RAMP_ITEM.length - 1,
        );
        const ch = RAMP_ITEM[idx];
        if (ch === " ") return " ";
        const hex = bandColor[y][x];
        return col(shadeItemColor(hex, val), ch);
      })
      .join(""),
  );
}

// --- Generate all frames ---
function generateFrames(
  renderFn: (angle: number) => string[],
  count = 36,
): string[][] {
  return Array.from({ length: count }, (_, i) =>
    renderFn((i / count) * Math.PI * 2),
  );
}

const firstEditionFrames = generateFrames(renderCardFrame);
const cdFrames = generateFrames(renderCdFrame);
const headphonesFrames = generateFrames(renderHeadphonesFrame);
const rainbowHeadbandFrames = generateFrames(renderRainbowHeadbandFrame);

export const ITEMS: ItemDef[] = [
  {
    id: "first-edition",
    name: "First Edition Card",
    description: "A token of appreciation for early adopters.",
    rarity: "rare",
    frames: firstEditionFrames,
    stackable: false,
  },
  {
    id: "cd",
    name: "CD",
    description: "A compact disc earned by listening.",
    rarity: "common",
    frames: cdFrames,
    stackable: true,
    sellPrice: 10,
  },
  {
    id: "headphones",
    name: "Headphones",
    description: "Wearable headphones for your herzie.",
    rarity: "uncommon",
    frames: headphonesFrames,
    equipable: true,
    equipSlot: "head",
  },
  {
    id: "rainbow-headband",
    name: "Rainbow Headband",
    description: "A colourful headband for your herzie.",
    rarity: "uncommon",
    frames: rainbowHeadbandFrames,
    equipable: true,
    equipSlot: "head",
  },
];

export function getItem(id: string): ItemDef | undefined {
  return ITEMS.find((item) => item.id === id);
}
