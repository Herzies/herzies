/**
 * Item definitions with 3D ASCII art renderer.
 * Ported from CLI — uses HTML color spans instead of chalk.
 */

// Imported from the leaf module rather than the package barrel: the barrel
// re-exports this file, and that cycle left RAINBOW_RAMP undefined while the
// item frames were being generated at module load.
import {
  CHAR_ASPECT,
  col,
  cross,
  dot3,
  LIGHT,
  normV,
  RAINBOW_RAMP,
  RAMP_ITEM,
  rotY,
  rotZ,
  type V2,
  type V3,
} from "./ascii3d.js";

export type Rarity = "common" | "uncommon" | "rare" | "legendary";

/** Catalog equip categories (item.equip_slot). Ground items choose a side at equip time. */
export const EQUIP_SLOTS = [
  "head",
  "face",
  "body",
  "scenery",
  "ground",
  "color",
] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

/** Keys stored on herzies.equipped — ground splits into left/right instance slots. */
export const EQUIPPED_SLOTS = [
  "head",
  "face",
  "body",
  "scenery",
  "ground_left",
  "ground_right",
  "color",
] as const;
export type EquippedSlot = (typeof EQUIPPED_SLOTS)[number];

export type GroundSide = "left" | "right";

/** Slot-keyed map of currently equipped item IDs. */
export type Equipped = Partial<Record<EquippedSlot, string>>;

export function groundSlot(side: GroundSide): EquippedSlot {
  return side === "left" ? "ground_left" : "ground_right";
}

export function equippedItemIds(
  equipped: Equipped | null | undefined,
): string[] {
  if (!equipped) return [];
  return Object.values(equipped).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

export function findEquippedSlot(
  equipped: Equipped | null | undefined,
  itemId: string,
): EquippedSlot | null {
  if (!equipped) return null;
  for (const slot of EQUIPPED_SLOTS) {
    if (equipped[slot] === itemId) return slot;
  }
  return null;
}

/** Normalize API/cache payloads that may still be a legacy string[]. */
export function normalizeEquipped(raw: unknown): Equipped {
  if (!raw || typeof raw !== "object") return {};
  if (Array.isArray(raw)) {
    // Legacy array — drop side info; callers should re-equip after migration.
    return {};
  }
  const out: Equipped = {};
  for (const slot of EQUIPPED_SLOTS) {
    const v = (raw as Record<string, unknown>)[slot];
    if (typeof v === "string" && v.length > 0) out[slot] = v;
  }
  return out;
}

export interface ItemDef {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  frames: string[][]; // Each frame is an array of lines (with HTML color spans)
  stackable?: boolean;
  equipable?: boolean;
  /** Catalog category; ground items occupy ground_left or ground_right when equipped. */
  equipSlot?: EquipSlot;
  sellPrice?: number;
  /** Set when the item can be bought with in-game currency from the store's Items tab. */
  buyPrice?: number;
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

// --- Shared card-frame renderer for icon-based item cards ---
// Every non-signature item is presented as a card using the same
// CORNERS/UVS/TILT/CAM rig as First Edition and Prism above (untouched) —
// each item just supplies an icon glyph and a couple of accent colours
// instead of reimplementing the projection/lighting loop.

/** Icon-space radius so a circle centred on the card face reads as round
 * despite the card being taller than it is wide. */
const ICON_ASPECT = CARD_HH / CARD_HW;

function iconUV(u: number, v: number): V2 {
  return [u - 0.5, (v - 0.5) * ICON_ASPECT];
}

interface TexSample {
  bright: number;
  /** Present for "content" pixels — tints them instead of the card's dim colour. */
  color?: string;
}

/** Border, inner rule, and four corner diamonds shared by every icon card —
 * mirrors First Edition's frame proportions. Returns null over the open
 * interior so the caller's icon can fill it in. */
function cardChrome(u: number, v: number, accent: string): TexSample | null {
  const bw = 0.055;
  if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) return { bright: 0.9 };
  const ib = 0.11,
    ibw = 0.012;
  if (
    (u > ib - ibw && u < ib + ibw && v > ib && v < 1 - ib) ||
    (u > 1 - ib - ibw && u < 1 - ib + ibw && v > ib && v < 1 - ib) ||
    (v > ib - ibw && v < ib + ibw && u > ib && u < 1 - ib) ||
    (v > 1 - ib - ibw && v < 1 - ib + ibw && u > ib && u < 1 - ib)
  )
    return { bright: 0.65 };
  const diamonds: V2[] = [
    [0.16, 0.1],
    [0.84, 0.1],
    [0.16, 0.9],
    [0.84, 0.9],
  ];
  for (const [dx, dy] of diamonds) {
    const du = Math.abs(u - dx) / 0.035;
    const dv = Math.abs(v - dy) / 0.045;
    if (du + dv < 1) return { bright: 1.0, color: accent };
  }
  return null;
}

function renderIconCard(
  yAngle: number,
  accent: string,
  dimColor: string,
  backColor: string,
  icon: (u: number, v: number) => TexSample | null,
): string[] {
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
  const pixelColor: (string | undefined)[][] = Array.from(
    { length: SH },
    () => Array(SW).fill(undefined),
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
      let sample: TexSample;
      if (front) {
        sample = cardChrome(u, v, accent) ?? icon(u, v) ?? { bright: 0.3 };
      } else {
        const bw = 0.055;
        if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) {
          sample = { bright: 0.7 };
        } else {
          const g = 0.065,
            w = 0.018;
          sample = { bright: u % g < w || v % g < w ? 0.5 : 0.28 };
        }
      }
      bright[sy][sx] = sample.bright * (0.2 + 0.8 * diffuse);
      pixelColor[sy][sx] = sample.color;
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
        const c = pixelColor[y][x];
        return col(c ?? (front ? dimColor : backColor), ch);
      })
      .join(""),
  );
}

// --- CD card ---
function cdCardIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const r = Math.sqrt(ix * ix + iy * iy);
  const R = 0.27;
  if (r > R || r < R * 0.16) return null;
  const band = ((r / R) * 7) % 1;
  const bright = band < 0.5 ? 0.85 : 0.5;
  const color = r < R * 0.4 ? "#E8E8E8" : r < R * 0.7 ? "#C0C0C0" : "#808080";
  return { bright, color };
}

function renderCdFrame(yAngle: number): string[] {
  return renderIconCard(yAngle, "#C0C0C0", "#7a7a7a", "#4a4a4a", cdCardIcon);
}

// --- Headphones card ---
function headbandArcIcon(
  u: number,
  v: number,
  cupColor: string | null,
): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const dist = Math.sqrt(ix * ix + iy * iy);
  const R = 0.26,
    bandT = 0.045;
  const angle = Math.atan2(iy, ix);
  const start = -2.7,
    end = -0.44; // upper arc, opening downward like a headband over ears
  if (Math.abs(dist - R) < bandT && angle > start && angle < end) {
    return { bright: 0.75, color: "#BBBBBB" };
  }
  if (cupColor) {
    for (const a of [start, end]) {
      const cx = R * Math.cos(a),
        cy = R * Math.sin(a);
      const d = Math.sqrt((ix - cx) ** 2 + (iy - cy) ** 2);
      if (d < 0.1) return { bright: d < 0.05 ? 0.9 : 0.6, color: cupColor };
    }
  }
  return null;
}

function renderHeadphonesFrame(yAngle: number): string[] {
  return renderIconCard(yAngle, "#c084fc", "#7a5aa0", "#4a3163", (u, v) =>
    headbandArcIcon(u, v, "#c084fc"),
  );
}

// --- Rainbow headband card ---
function rainbowHeadbandCardIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const dist = Math.sqrt(ix * ix + iy * iy);
  const R = 0.26,
    bandT = 0.05;
  const angle = Math.atan2(iy, ix);
  const start = -2.7,
    end = -0.44;
  if (Math.abs(dist - R) < bandT && angle > start && angle < end) {
    const t = (angle - start) / (end - start);
    const idx = Math.min(
      RAINBOW_RAMP.length - 1,
      Math.floor(t * RAINBOW_RAMP.length),
    );
    return { bright: 0.85, color: RAINBOW_RAMP[idx] };
  }
  return null;
}

function renderRainbowHeadbandFrame(yAngle: number): string[] {
  return renderIconCard(
    yAngle,
    "#e8e2d0",
    "#8f8672",
    "#5c5648",
    rainbowHeadbandCardIcon,
  );
}

// --- Boombox card ---
function boomboxNoteIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const headCx = -0.02,
    headCy = 0.22;
  const dHead = Math.sqrt((ix - headCx) ** 2 + (iy - headCy) ** 2);
  if (dHead < 0.16) return { bright: 0.85, color: "#f2f2f2" };
  const stemL = headCx + 0.12,
    stemR = headCx + 0.2;
  if (ix > stemL && ix < stemR && iy > -0.34 && iy < headCy)
    return { bright: 0.8, color: "#f2f2f2" };
  if (
    ix > stemR &&
    ix < stemR + 0.16 &&
    iy > -0.34 &&
    iy < -0.16 &&
    ix - stemR > (iy + 0.34) * 0.9
  )
    return { bright: 0.8, color: "#f2f2f2" };
  return null;
}

function renderBoomboxFrame(yAngle: number): string[] {
  return renderIconCard(
    yAngle,
    "#aeb4ba",
    "#75757a",
    "#45454a",
    boomboxNoteIcon,
  );
}

// --- Generate all frames ---
// --- Prism (colour scheme) rendering ---

/** Scale a hex colour toward black — used for the card's reverse face. */
function shadeHex(hex: string, factor: number): string {
  const channel = (start: number) =>
    Math.min(
      255,
      Math.round(parseInt(hex.slice(start, start + 2), 16) * factor),
    )
      .toString(16)
      .padStart(2, "0");
  return `#${channel(1)}${channel(3)}${channel(5)}`.toUpperCase();
}

function prismTexture(u: number, v: number): number {
  const bw = 0.055;
  if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) return 0.9;
  // Gentle sheen across the face so the gradient still reads as a lit card.
  return 0.55 + 0.35 * Math.sin((u + v) * Math.PI);
}

/** Band index for the diagonal rainbow sweep across the card face. */
function prismBand(u: number, v: number): number {
  const t = (u * 0.65 + v * 0.35) % 1;
  return Math.min(RAINBOW_RAMP.length - 1, Math.floor(t * RAINBOW_RAMP.length));
}

function renderPrismFrame(yAngle: number): string[] {
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
  const bands: number[][] = Array.from({ length: SH }, () => Array(SW).fill(0));

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
      bright[sy][sx] = prismTexture(u, v) * (0.2 + 0.8 * diffuse);
      bands[sy][sx] = prismBand(u, v);
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
        const hue = RAINBOW_RAMP[bands[y][x]];
        return col(front ? hue : shadeHex(hue, 0.45), ch);
      })
      .join(""),
  );
}

function generateFrames(
  renderFn: (angle: number) => string[],
  count = 36,
): string[][] {
  // The card faces us for the yAngle arc (PI/2, 3*PI/2) — a symmetric 180°
  // window regardless of the cosmetic Z tilt. Start at PI/2, the moment it
  // turns to face us, so the full front-facing arc plays before it turns away.
  return Array.from({ length: count }, (_, i) =>
    renderFn((i / count) * Math.PI * 2 + Math.PI / 2),
  );
}

const firstEditionFrames = generateFrames(renderCardFrame);
const cdFrames = generateFrames(renderCdFrame);
const headphonesFrames = generateFrames(renderHeadphonesFrame);
const rainbowHeadbandFrames = generateFrames(renderRainbowHeadbandFrame);
const boomboxFrames = generateFrames(renderBoomboxFrame);
const prismFrames = generateFrames(renderPrismFrame);

// --- Clouds card ---
function cloudCardIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const puffs: [number, number, number][] = [
    [-0.14, 0.02, 0.13],
    [0.05, -0.06, 0.17],
    [0.22, 0.04, 0.12],
  ];
  for (const [cx, cy, r] of puffs) {
    const d = Math.sqrt((ix - cx) ** 2 + (iy - cy) ** 2);
    if (d < r) return { bright: d < r * 0.6 ? 0.85 : 0.6, color: "#c7d3de" };
  }
  if (ix > -0.22 && ix < 0.3 && iy > 0.08 && iy < 0.16)
    return { bright: 0.6, color: "#c7d3de" };
  return null;
}

function renderCloudsFrame(yAngle: number): string[] {
  return renderIconCard(yAngle, "#8899aa", "#5f707d", "#3d4a56", cloudCardIcon);
}

const cloudsFrames = generateFrames(renderCloudsFrame);

// --- Stars card ---
function starCardIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const dist = Math.sqrt(ix * ix + iy * iy);
  const outerR = 0.26,
    innerR = 0.1;
  const angle = Math.atan2(iy, ix) + Math.PI / 2;
  const seg = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const spike = seg / ((Math.PI * 2) / 5);
  const frac = spike - Math.floor(spike);
  const edgeR = innerR + (outerR - innerR) * (1 - Math.abs(frac - 0.5) * 2);
  if (dist < edgeR * 0.55) return { bright: 0.95, color: "#eaf2fb" };
  if (dist < edgeR) return { bright: 0.7, color: "#ccddee" };
  const sparkles: V2[] = [
    [-0.32, -0.3],
    [0.3, -0.28],
    [-0.28, 0.32],
  ];
  for (const [sx, sy] of sparkles) {
    const d = Math.sqrt((ix - sx) ** 2 + (iy - sy) ** 2);
    if (d < 0.03) return { bright: 0.8, color: "#8899aa" };
  }
  return null;
}

function renderStarsFrame(yAngle: number): string[] {
  return renderIconCard(yAngle, "#ccddee", "#5a6ea0", "#3a4868", starCardIcon);
}

const starsFrames = generateFrames(renderStarsFrame);

export const ITEMS: ItemDef[] = [
  {
    id: "first-edition",
    name: "First Edition Card",
    description: "A token of appreciation for early adopters.",
    rarity: "rare",
    frames: firstEditionFrames,
    stackable: false,
    sellPrice: 250,
  },
  {
    id: "cd",
    name: "Nostalgic Token",
    description: "An image of a CD on a dull card. Weird. Probably not worth much.",
    rarity: "common",
    frames: cdFrames,
    stackable: true,
    sellPrice: 10,
  },
  {
    id: "headphones",
    name: "Intimite Music Device",
    description: "Summons a pair of headphones on your herzie's head.",
    rarity: "uncommon",
    frames: headphonesFrames,
    equipable: true,
    equipSlot: "head",
    buyPrice: 10000,
    sellPrice: 100,
  },
  {
    id: "rainbow-headband",
    name: "Permanent Rainbow Dreams",
    description: "Rainbows forever on your mind. And head.",
    rarity: "uncommon",
    frames: rainbowHeadbandFrames,
    equipable: true,
    equipSlot: "head",
    buyPrice: 1000,
    sellPrice: 100,
  },
  {
    id: "boombox",
    name: "Box of Boom",
    description: "Grants your herzie real street cred.",
    rarity: "rare",
    frames: boomboxFrames,
    equipable: true,
    equipSlot: "ground",
    sellPrice: 250,
  },
  {
    id: "clouds",
    name: "Overcast",
    description: "Paints calming clouds on your herzie's sky.",
    rarity: "rare",
    frames: cloudsFrames,
    equipable: true,
    equipSlot: "scenery",
    sellPrice: 250,
  },
  {
    id: "stars",
    name: "Starfield",
    description: "Sprinkles a twinkling starfield on your herzie's sky.",
    rarity: "rare",
    frames: starsFrames,
    equipable: true,
    equipSlot: "scenery",
    sellPrice: 250,
  },
  {
    id: "prism",
    name: "Prismatic Surrenderer",
    description: "Turns your herzie into a walking rainbow.",
    rarity: "uncommon",
    frames: prismFrames,
    equipable: true,
    equipSlot: "color",
    sellPrice: 100,
  },
];

export function getItem(id: string): ItemDef | undefined {
  return ITEMS.find((item) => item.id === id);
}
