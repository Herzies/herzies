/**
 * Background scenery renderer for Herzie3D.
 *
 * Sky (9 rows): clouds by day, stars by night, anchored to window top.
 */

import { mulberry32, simpleHash } from "./creature-renderer.js";

const SKY_COLOR = "#8899aa";
const BRIGHT_STAR_COLOR = "#ccddee";

const SKY_ROWS = 9;

const CLOUD_CHARS = [".", "-", "~", ".", "~"];

const STAR_TWINKLE_VARIANTS = ["·", "+", "*", "·", "+"];

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
  const count = 3 + Math.floor(rng() * 2);
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
  const count = 15 + Math.floor(rng() * 6);
  const extraCount = 4 + Math.floor(rng() * 3);
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

function ensureCache(userId: string) {
  if (cachedUserId === userId) return;
  cachedUserId = userId;

  const seed = simpleHash(userId + ":scenery");
  const rng = mulberry32(seed);

  cachedClouds = generateClouds(rng);
  cachedStars = generateStars(rng);
}

export function renderSky(opts: {
  userId: string;
  isNight: boolean;
  isPlaying: boolean;
  cloudOffset: number;
  twinkleFrame: number;
  cols: number;
}): string {
  const { userId, isNight, isPlaying, cloudOffset, twinkleFrame, cols } = opts;
  ensureCache(userId);

  const lines: string[] = [];

  if (isNight) {
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
      const tickRate = isPlaying ? 8 : 12;
      const variantIdx =
        Math.floor((twinkleFrame + star.phase) / tickRate) %
        STAR_TWINKLE_VARIANTS.length;
      skyGrid[star.row][col] = STAR_TWINKLE_VARIANTS[variantIdx];
      colorGrid[star.row][col] = star.bright ? BRIGHT_STAR_COLOR : SKY_COLOR;
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
