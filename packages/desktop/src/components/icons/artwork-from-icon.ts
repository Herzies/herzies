// A card's pixel artwork, as derived from its 24x24 icon: the picture inside
// the icon's card frame, widened to the card's 4:3 art window. Plain TS with
// no imports and only erasable type syntax, so the item editor can load it
// too — its server via Node's type stripping, its page as stripped JS — and
// every side derives exactly the same thing.

/** Artwork grid size: 4:3, and 6x into the card's 192x144 art window. */
export const ARTWORK_W = 32;
export const ARTWORK_H = 24;

/** Where the inside of a card icon's frame sits: the frame is a 1px
 * chamfered outline at x=4/19 and y=1/22 (CARD_FRAME in type-icon-grids.ts),
 * so the face is the 14x20 block inside it. */
const FACE_X = 5;
const FACE_Y = 2;
const FACE_W = 14;
const FACE_H = 20;

/** Where the face lands in the artwork: centred, which is also exactly where
 * the 24px icon's face sits when the icon is drawn at the art window's full
 * height — so an icon morphing into the artwork lines up pixel for pixel. */
const OFFSET_X = (ARTWORK_W - FACE_W) / 2;
const OFFSET_Y = (ARTWORK_H - FACE_H) / 2;

const filled = (grid: string[], x: number, y: number) =>
  (grid[y]?.[x] ?? ".") !== ".";

/** Whether the icon is drawn as a card — the frame outline all round and
 * nothing outside it. Dice, the Safety Pick and the like aren't. */
export function hasCardFrame(grid: string[]): boolean {
  if (grid.length !== 24 || grid.some((row) => row.length !== 24)) return false;
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const outside = x < 4 || x > 19 || y < 1 || y > 22;
      if (outside && filled(grid, x, y)) return false;
    }
  }
  for (let x = FACE_X; x < FACE_X + FACE_W; x++) {
    if (!filled(grid, x, 1) || !filled(grid, x, 22)) return false;
  }
  for (let y = FACE_Y; y < FACE_Y + FACE_H; y++) {
    if (!filled(grid, 4, y) || !filled(grid, 19, y)) return false;
  }
  return true;
}

/** The artwork a card shows until it's given its own (same palette, so the
 * grid's characters carry over as they are).
 *
 * A card icon loses its frame: the face is cut out, its four chamfer
 * corners (frame pixels) filled from their inner neighbours, and its
 * background stretched outwards to fill the wider window — a sky stays a
 * sky to the edges. Only background stretches: where the drawing itself
 * touches the face's side (headphone cups, a hat brim), that row borrows
 * the nearest background row's colour instead, rather than smearing the
 * drawing into stripes. Background = the colours along the face's top and
 * bottom rows. Any other icon is centred as it is, on transparent. */
export function artworkFromIcon(grid: string[]): string[] {
  const blank = ".".repeat(ARTWORK_W);
  if (!hasCardFrame(grid)) {
    const h = grid.length;
    const w = grid[0]?.length ?? 0;
    const ox = Math.floor((ARTWORK_W - w) / 2);
    const oy = Math.floor((ARTWORK_H - h) / 2);
    return Array.from({ length: ARTWORK_H }, (_, y) => {
      const row = grid[y - oy];
      if (!row) return blank;
      return (blank.slice(0, ox) + row + blank).slice(0, ARTWORK_W);
    });
  }

  const face = grid
    .slice(FACE_Y, FACE_Y + FACE_H)
    .map((row) => [...row.slice(FACE_X, FACE_X + FACE_W)]);
  for (const y of [0, FACE_H - 1]) {
    face[y][0] = face[y][1];
    face[y][FACE_W - 1] = face[y][FACE_W - 2];
  }
  const background = new Set([...face[0], ...face[FACE_H - 1]]);
  /** The colour to stretch out of row `y`'s side at column `x`. */
  const sideColour = (y: number, x: number) => {
    for (let d = 0; d < FACE_H; d++) {
      for (const yy of [y - d, y + d]) {
        const ch = face[yy]?.[x];
        if (ch !== undefined && background.has(ch)) return ch;
      }
    }
    return face[y][x];
  };
  const rows = face.map((cells, y) => {
    const left = sideColour(y, 0).repeat(OFFSET_X);
    const right = sideColour(y, FACE_W - 1).repeat(
      ARTWORK_W - FACE_W - OFFSET_X,
    );
    return left + cells.join("") + right;
  });
  return [
    ...Array<string>(OFFSET_Y).fill(rows[0]),
    ...rows,
    ...Array<string>(ARTWORK_H - FACE_H - OFFSET_Y).fill(rows[FACE_H - 1]),
  ];
}
