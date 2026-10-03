/**
 * Background scenery renderer for Herzie3D.
 *
 * Sky (18 rows): clouds by day, stars by night, or the Blood Moon (Halloween):
 * stars plus a big moon with bats flitting across it. Anchored to window top.
 */

import { mulberry32, simpleHash } from "./creature-renderer.js";

const SKY_COLOR = "#8899aa";
const BRIGHT_STAR_COLOR = "#ccddee";

const SKY_ROWS = 18;
/** Clouds and stars were tuned for a 9-row sky; their counts scale with it
 * so a taller sky isn't sparser. */
const SKY_DENSITY = SKY_ROWS / 9;

const CLOUD_CHARS = [".", "-", "~", ".", "~"];

export const STAR_TWINKLE_VARIANTS = ["·", "+", "*", "·", "+"];

interface Cloud {
  row: number;
  fractionalCol: number;
  chars: string[];
}

interface Star {
  row: number;
  fractionalCol: number;
  phase: number;
  bright: boolean;
  musicOnly: boolean;
}

function generateClouds(rng: () => number): Cloud[] {
  const count = Math.round((3 + Math.floor(rng() * 2)) * SKY_DENSITY);
  const clouds: Cloud[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(rng() * SKY_ROWS);
    const fractionalCol = rng();
    const len = 4 + Math.floor(rng() * 8);
    const chars: string[] = [];
    for (let c = 0; c < len; c++) {
      if (rng() < 0.25) {
        chars.push(" ");
      } else {
        chars.push(CLOUD_CHARS[Math.floor(rng() * CLOUD_CHARS.length)]);
      }
    }
    clouds.push({ row, fractionalCol, chars });
  }
  return clouds;
}

function generateStars(rng: () => number): Star[] {
  const stars: Star[] = [];
  const count = Math.round((15 + Math.floor(rng() * 6)) * SKY_DENSITY);
  const extraCount = Math.round((4 + Math.floor(rng() * 3)) * SKY_DENSITY);
  const totalCount = count + extraCount;

  for (let i = 0; i < totalCount; i++) {
    const row = Math.floor(rng() * SKY_ROWS);
    const fractionalCol = rng();
    stars.push({
      row,
      fractionalCol,
      phase: Math.floor(rng() * 20),
      bright: rng() < 0.15,
      musicOnly: i >= count,
    });
  }
  return stars;
}

let cachedUserId = "";
let cachedClouds: Cloud[] = [];
let cachedStars: Star[] = [];
let cachedBats: Bat[] = [];
let cachedMoonFraction = 0.75;

function ensureCache(userId: string) {
  if (cachedUserId === userId) return;
  cachedUserId = userId;

  const seed = simpleHash(userId + ":scenery");
  const rng = mulberry32(seed);

  cachedClouds = generateClouds(rng);
  cachedStars = generateStars(rng);
  // Drawn after the clouds and stars so existing skies keep their layout.
  cachedBats = generateBats(rng);
  // Right of centre but clear of the top-right corner, where the Herzie view
  // shows the coin balance.
  cachedMoonFraction = 0.62 + rng() * 0.12;
}

export type SceneryVariant = "clouds" | "stars" | "blood-moon" | null;

const MOON_COLOR = "#E8552B";
/** One star's brightness cycle under the Blood Moon, with a warm peak. */
const BLOOD_MOON_STAR_PULSE = [
  "#4A5566",
  SKY_COLOR,
  BRIGHT_STAR_COLOR,
  "#FFE9D6",
  BRIGHT_STAR_COLOR,
  SKY_COLOR,
];
const MOON_SHADE_COLOR = "#9C2F14";
const BAT_COLOR = "#8E6FB0";
// Over the moon a bat is a silhouette, not a purple smudge.
const BAT_ON_MOON_COLOR = "#2A0E08";
/** A terminal cell is about this many times taller than it is wide. */
const CELL_ASPECT = 2.25;

interface Bat {
  row: number;
  fractionalCol: number;
  /** Columns moved per twinkle tick (they fly at slightly different speeds). */
  speed: number;
  phase: number;
}

function generateBats(rng: () => number): Bat[] {
  return Array.from({ length: 3 }, () => ({
    row: 1 + Math.floor(rng() * (SKY_ROWS - 3)),
    fractionalCol: rng(),
    speed: 0.5 + rng() * 0.5,
    phase: Math.floor(rng() * 4),
  }));
}

/** Moon cell at (row, col), or null outside it: lit on the left, shaded on the
 * right, with a couple of darker craters. */
function moonCell(
  row: number,
  col: number,
  centerCol: number,
): { ch: string; color: string } | null {
  const radius = 3.6; // in rows
  const centerRow = 6.5;
  const dx = (col - centerCol) / CELL_ASPECT;
  const dy = row - centerRow;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > radius) return null;
  const crater =
    Math.hypot(dx + 1.2, dy + 1) < 0.8 || Math.hypot(dx - 0.6, dy - 1.4) < 0.6;
  const shaded = dx > radius * 0.35;
  if (crater) return { ch: "o", color: MOON_SHADE_COLOR };
  if (d > radius - 0.7) return { ch: "*", color: MOON_SHADE_COLOR };
  return shaded
    ? { ch: "#", color: MOON_SHADE_COLOR }
    : { ch: "@", color: MOON_COLOR };
}

export function renderSky(opts: {
  userId: string;
  variant: SceneryVariant;
  isPlaying: boolean;
  cloudOffset: number;
  twinkleFrame: number;
  cols: number;
}): string {
  const { userId, variant, isPlaying, cloudOffset, twinkleFrame, cols } = opts;
  ensureCache(userId);

  const lines: string[] = [];

  if (variant === null) {
    for (let r = 0; r < SKY_ROWS; r++) lines.push("");
    return lines.join("\n");
  }

  if (variant === "stars" || variant === "blood-moon") {
    const skyGrid: (string | null)[][] = [];
    const colorGrid: (string | null)[][] = [];
    for (let r = 0; r < SKY_ROWS; r++) {
      skyGrid.push(new Array(cols).fill(null));
      colorGrid.push(new Array(cols).fill(null));
    }

    for (const star of cachedStars) {
      if (star.musicOnly && !isPlaying) continue;
      const col = Math.floor(star.fractionalCol * cols);
      if (col >= cols) continue;
      if (variant === "blood-moon") {
        // Livelier than the Starfield: quicker steps, and each star pulses
        // dim → bright → dim as well as changing shape.
        const step = Math.floor(
          (twinkleFrame + star.phase) / (isPlaying ? 3 : 4),
        );
        skyGrid[star.row][col] =
          STAR_TWINKLE_VARIANTS[step % STAR_TWINKLE_VARIANTS.length];
        colorGrid[star.row][col] =
          BLOOD_MOON_STAR_PULSE[
            (step + (star.bright ? 2 : 0)) % BLOOD_MOON_STAR_PULSE.length
          ];
        continue;
      }
      const tickRate = isPlaying ? 8 : 12;
      const variantIdx =
        Math.floor((twinkleFrame + star.phase) / tickRate) %
        STAR_TWINKLE_VARIANTS.length;
      skyGrid[star.row][col] = STAR_TWINKLE_VARIANTS[variantIdx];
      colorGrid[star.row][col] = star.bright ? BRIGHT_STAR_COLOR : SKY_COLOR;
    }

    if (variant === "blood-moon") {
      const moonCol = Math.floor(cachedMoonFraction * cols);
      for (let r = 0; r < SKY_ROWS; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = moonCell(r, c, moonCol);
          if (!cell) continue;
          skyGrid[r][c] = cell.ch;
          colorGrid[r][c] = cell.color;
        }
      }
      // Bats drift right on the twinkle tick, wrapping, wings flapping.
      for (const bat of cachedBats) {
        const span = cols + 3;
        const start =
          Math.floor(bat.fractionalCol * span + twinkleFrame * bat.speed) %
          span;
        const wings =
          Math.floor((twinkleFrame + bat.phase) / 2) % 2 === 0 ? "^v^" : "-v-";
        for (let i = 0; i < wings.length; i++) {
          const col = start - 3 + i;
          if (col < 0 || col >= cols) continue;
          const onMoon = moonCell(bat.row, col, moonCol) !== null;
          skyGrid[bat.row][col] = wings[i];
          colorGrid[bat.row][col] = onMoon ? BAT_ON_MOON_COLOR : BAT_COLOR;
        }
      }
    }

    for (let r = 0; r < SKY_ROWS; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) {
        const ch = skyGrid[r][c];
        if (ch) {
          line += `<span style="color:${colorGrid[r][c]}">${ch}</span>`;
        } else {
          line += " ";
        }
      }
      lines.push(line);
    }
  } else {
    const skyGrid: (string | null)[][] = [];
    for (let r = 0; r < SKY_ROWS; r++) {
      skyGrid.push(new Array(cols).fill(null));
    }

    for (const cloud of cachedClouds) {
      const baseCol = Math.floor(cloud.fractionalCol * cols);
      const shifted = (((baseCol + cloudOffset) % cols) + cols) % cols;
      for (let i = 0; i < cloud.chars.length; i++) {
        if (cloud.chars[i] === " ") continue;
        const col = (shifted + i) % cols;
        if (shifted + cloud.chars.length > cols && col >= shifted) continue;
        if (shifted + cloud.chars.length <= cols || col < shifted) {
          skyGrid[cloud.row][col] = cloud.chars[i];
        }
      }
    }

    for (let r = 0; r < SKY_ROWS; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) {
        const ch = skyGrid[r][c];
        if (ch) {
          line += `<span style="color:${SKY_COLOR}">${ch}</span>`;
        } else {
          line += " ";
        }
      }
      lines.push(line);
    }
  }

  return lines.join("\n");
}
