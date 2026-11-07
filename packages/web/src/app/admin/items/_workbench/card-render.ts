/*
 * The finished card illustration: the artist's original framed (zoom +
 * position) and optionally filtered into a 4:3 image, 4x the card's
 * 192x144 art window.
 */

export const CARD_ART_W = 768;
export const CARD_ART_H = 576;
const CARD_ART_ASPECT = CARD_ART_W / CARD_ART_H;
export const MAX_ZOOM = 8;

export type ArtSettings = {
  crop: { zoom: number; x: number; y: number };
  filter: { type: "none" | "lofi"; detail: number };
  artist: string;
  pixelated: boolean;
};

export function settingsFromEntry(
  entry:
    | {
        crop?: ArtSettings["crop"];
        filter?: { type: "none" | "lofi"; detail?: number };
        artist?: string;
        pixelated?: boolean;
      }
    | undefined,
): ArtSettings {
  return {
    crop: { zoom: 1, x: 50, y: 50, ...entry?.crop },
    filter:
      entry?.filter?.type === "lofi"
        ? { type: "lofi", detail: entry.filter.detail ?? 25 }
        : { type: "none", detail: 25 },
    artist: entry?.artist ?? "",
    pixelated: !!entry?.pixelated,
  };
}

/** The 4:3 source rectangle (original pixels) the crop shows. At zoom 1
 * it's the largest 4:3 rectangle that fits, placed by (x, y) as a % of the
 * slack; zooming in shrinks it around the same relative position. */
export function cropRect(img: HTMLImageElement, crop: ArtSettings["crop"]) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const sw = Math.min(w, h * CARD_ART_ASPECT) / crop.zoom;
  const sh = sw / CARD_ART_ASPECT;
  return {
    sx: (w - sw) * (crop.x / 100),
    sy: (h - sh) * (crop.y / 100),
    sw,
    sh,
  };
}

function drawCrop(
  img: HTMLImageElement,
  settings: ArtSettings,
  w: number,
  h: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = !settings.pixelated;
  ctx.imageSmoothingQuality = "high";
  const { sx, sy, sw, sh } = cropRect(img, settings.crop);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return canvas;
}

/** Lo-fi: drops the picture to a handful of pixels and colours (with an
 * ordered dither so gradients survive as texture), then scales it back up
 * hard-edged. Detail 0: 24px wide, 4 levels per channel; 100: 192px, 16. */
function lofi(crop: HTMLCanvasElement, detail: number): HTMLCanvasElement {
  const res = Math.round(24 + (detail / 100) * 168);
  const resH = Math.round(res / CARD_ART_ASPECT);
  const levels = Math.round(4 + (detail / 100) * 12);
  const small = document.createElement("canvas");
  small.width = res;
  small.height = resH;
  const sctx = small.getContext("2d");
  if (!sctx) return crop;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(crop, 0, 0, res, resH);
  const data = sctx.getImageData(0, 0, res, resH);
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const step = 255 / (levels - 1);
  for (let y = 0; y < resH; y++) {
    for (let x = 0; x < res; x++) {
      const i = (y * res + x) * 4;
      // Dither at half a level: enough to break up banding, not so much
      // that flat areas turn into a speckled checkerboard.
      const threshold = ((bayer[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * 0.5;
      for (let c = 0; c < 3; c++) {
        const v = data.data[i + c] / step + threshold;
        data.data[i + c] = Math.max(0, Math.min(255, Math.round(v) * step));
      }
    }
  }
  sctx.putImageData(data, 0, 0);
  const out = document.createElement("canvas");
  out.width = crop.width;
  out.height = crop.height;
  const octx = out.getContext("2d");
  if (!octx) return crop;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(small, 0, 0, out.width, out.height);
  return out;
}

export function renderCardArt(
  img: HTMLImageElement,
  settings: ArtSettings,
): HTMLCanvasElement {
  const crop = drawCrop(img, settings, CARD_ART_W, CARD_ART_H);
  return settings.filter.type === "lofi"
    ? lofi(crop, settings.filter.detail)
    : crop;
}
