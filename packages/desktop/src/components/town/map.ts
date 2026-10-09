import { mulberry32 } from "@herzies/shared";

/**
 * The home island as a map: two layers of characters on a square grid of
 * 1-unit cells centred on the origin — what the ground is, and what stands
 * on it — plus where the visitors stand and where you start. Written by the
 * map editor (`pnpm map-editor`) to maps/home.json, one row per line, so a
 * map reads (and diffs) as a picture.
 *
 * Cell (col, row) covers x in [col - HALF, col - HALF + 1], z likewise with
 * the row: row 0 is the north edge (-z), col 0 the west (-x).
 */

/** How far you can walk from the middle of town. */
export const WORLD_RADIUS = 40;
/** How far the island the town stands on reaches: a little past where you
 * can walk, so you can look over the edge but not fall off it. */
export const ISLAND_RADIUS = WORLD_RADIUS + 3;
/** Cells per side: the whole island, edge to edge. */
export const MAP_SIZE = ISLAND_RADIUS * 2;
const HALF = MAP_SIZE / 2;

export const TERRAIN = {
  ".": { name: "Grass", color: "#2f5233" },
  g: { name: "Gravel", color: "#6b6155" },
  "~": { name: "Water", color: "#2e6a9a" },
  "=": { name: "Bridge", color: "#8a6a48" },
} as const;
export type TerrainChar = keyof typeof TERRAIN;
/** Off the island (fixed by its shape, not painted). */
export const OFF = " ";

export const OBJECTS = {
  ".": { name: "Nothing", color: "transparent" },
  T: { name: "Tree", color: "#4f9a5e" },
  R: { name: "Rock", color: "#a8a2a8" },
  S: { name: "Stump", color: "#b07a4a" },
  v: { name: "Tall grass", color: "#7fb069" },
  "*": { name: "Flowers", color: "#f2d03b" },
  m: { name: "Mushrooms", color: "#d0473a" },
  B: { name: "Bush", color: "#3f7f3a" },
  H: { name: "Home", color: "#c9a27a" },
  $: { name: "Shop", color: "#6a9ae0" },
  C: { name: "Cave", color: "#8a8070" },
  "@": { name: "Statue", color: "#d8d4cc" },
} as const;
export type ObjectChar = keyof typeof OBJECTS;

export type Point = [x: number, z: number];

export type TownMap = {
  version: 1;
  size: number;
  /** MAP_SIZE rows of MAP_SIZE terrain chars (OFF where off the island). */
  terrain: string[];
  /** Same shape: what stands on each cell ('.' nothing, OFF off-island). */
  objects: string[];
  /** Where each kind of visitor stands. */
  spots: Record<string, Point>;
  /** Where any other visitor stands, in turn. */
  spare: Point[];
  /** Where you start, and which way you face (forward is (sin, cos)). */
  spawn: { at: Point; heading: number };
};

/** Visitor kinds with a spot of their own, as the editor names them. */
export const SPOT_NAMES: Record<string, string> = {
  boss_fight: "Boss",
  merchant: "George",
  song_hunt: "Orphiez",
  treat_trader: "Nandor",
};

/** The centre of a cell, in world (x, z). */
export function cellCenter(col: number, row: number): Point {
  return [col - HALF + 0.5, row - HALF + 0.5];
}

/** The cell a world point falls in (may be off the grid). */
export function cellAt(x: number, z: number): [col: number, row: number] {
  return [Math.floor(x + HALF), Math.floor(z + HALF)];
}

function cellCorners(col: number, row: number): Point[] {
  const x = col - HALF;
  const z = row - HALF;
  return [
    [x, z],
    [x + 1, z],
    [x + 1, z + 1],
    [x, z + 1],
  ];
}

/** Whether any of the cell is on the island. */
export function onIsland(col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= MAP_SIZE || row >= MAP_SIZE) return false;
  const x0 = col - HALF;
  const z0 = row - HALF;
  // The cell's nearest point to the island's middle.
  const nx = Math.max(x0, Math.min(0, x0 + 1));
  const nz = Math.max(z0, Math.min(0, z0 + 1));
  return Math.hypot(nx, nz) < ISLAND_RADIUS;
}

/** Whether the whole cell is on the island — only those can hold water
 * (a pond cut into the rim would open a hole in the island's side). */
export function inland(col: number, row: number): boolean {
  return cellCorners(col, row).every(
    ([x, z]) => Math.hypot(x, z) <= ISLAND_RADIUS,
  );
}

/** Water or a bridge over it: the ground there is sunk. */
export function isSunk(t: string): boolean {
  return t === "~" || t === "=";
}

export function terrainAt(map: TownMap, col: number, row: number): string {
  return map.terrain[row]?.[col] ?? OFF;
}

export function objectAt(map: TownMap, col: number, row: number): string {
  return map.objects[row]?.[col] ?? OFF;
}

/** A blank island: all grass, nothing on it, everyone in the middle. */
export function emptyMap(): TownMap {
  const rows = (fill: string) =>
    Array.from({ length: MAP_SIZE }, (_, r) =>
      Array.from({ length: MAP_SIZE }, (_, c) =>
        onIsland(c, r) ? fill : OFF,
      ).join(""),
    );
  return {
    version: 1,
    size: MAP_SIZE,
    terrain: rows("."),
    objects: rows("."),
    spots: {},
    spare: [[0, 5]],
    spawn: { at: [0, 0], heading: Math.PI },
  };
}

const isPoint = (p: unknown): p is Point =>
  Array.isArray(p) &&
  p.length === 2 &&
  p.every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * Check a map read from JSON. Throws with every problem found (up to a
 * few), rather than drawing a world from a broken file.
 */
export function parseMap(json: unknown): TownMap {
  const errors: string[] = [];
  const m = json as Partial<TownMap> | null;
  if (!m || typeof m !== "object") throw new Error("map: not an object");
  if (m.version !== 1) errors.push(`version ${m.version}, expected 1`);
  if (m.size !== MAP_SIZE) errors.push(`size ${m.size}, expected ${MAP_SIZE}`);

  const grid = (name: "terrain" | "objects", chars: string) => {
    const rows = m[name];
    if (!Array.isArray(rows) || rows.length !== MAP_SIZE) {
      errors.push(`${name}: expected ${MAP_SIZE} rows`);
      return;
    }
    rows.forEach((row, r) => {
      if (typeof row !== "string" || row.length !== MAP_SIZE) {
        errors.push(`${name} row ${r}: expected ${MAP_SIZE} chars`);
        return;
      }
      for (let c = 0; c < MAP_SIZE; c++) {
        const ch = row[c];
        if (!onIsland(c, r)) {
          if (ch !== OFF) errors.push(`${name} (${c}, ${r}): off the island`);
        } else if (!chars.includes(ch)) {
          errors.push(`${name} (${c}, ${r}): unknown "${ch}"`);
        }
      }
    });
  };
  grid("terrain", Object.keys(TERRAIN).join(""));
  grid("objects", Object.keys(OBJECTS).join(""));

  if (errors.length === 0) {
    const map = m as TownMap;
    for (let r = 0; r < MAP_SIZE; r++) {
      for (let c = 0; c < MAP_SIZE; c++) {
        const t = terrainAt(map, c, r);
        if (isSunk(t) && !inland(c, r)) {
          errors.push(`terrain (${c}, ${r}): water on the rim`);
        }
        if (isSunk(t) && objectAt(map, c, r) !== ".") {
          errors.push(`objects (${c}, ${r}): standing in water`);
        }
      }
    }
  }

  const where = (label: string, p: unknown) => {
    if (!isPoint(p)) errors.push(`${label}: expected [x, z]`);
    else if (Math.hypot(p[0], p[1]) > WORLD_RADIUS) {
      errors.push(`${label}: past the edge`);
    }
  };
  if (!m.spots || typeof m.spots !== "object") errors.push("spots: missing");
  else for (const [k, p] of Object.entries(m.spots)) where(`spots.${k}`, p);
  if (!Array.isArray(m.spare) || m.spare.length === 0) {
    errors.push("spare: expected at least one spot");
  } else {
    for (const [i, p] of m.spare.entries()) where(`spare[${i}]`, p);
  }
  if (!m.spawn || typeof m.spawn.heading !== "number") {
    errors.push("spawn: expected { at, heading }");
  } else where("spawn.at", m.spawn.at);

  if (errors.length > 0) {
    const shown = errors.slice(0, 8).join("; ");
    const more = errors.length > 8 ? ` (+${errors.length - 8} more)` : "";
    throw new Error(`map: ${shown}${more}`);
  }
  return m as TownMap;
}

/** The map as its file: JSON, with each grid row on a line of its own. */
export function serializeMap(map: TownMap): string {
  const rows = (rs: string[]) =>
    `[\n${rs.map((r) => `    ${JSON.stringify(r)}`).join(",\n")}\n  ]`;
  const pt = ([x, z]: Point) => `[${x}, ${z}]`;
  const spots = Object.entries(map.spots)
    .map(([k, p]) => `    ${JSON.stringify(k)}: ${pt(p)}`)
    .join(",\n");
  return `{
  "version": ${map.version},
  "size": ${map.size},
  "spawn": { "at": ${pt(map.spawn.at)}, "heading": ${map.spawn.heading} },
  "spots": {${spots ? `\n${spots}\n  ` : ""}},
  "spare": [${map.spare.map(pt).join(", ")}],
  "terrain": ${rows(map.terrain)},
  "objects": ${rows(map.objects)}
}
`;
}

/** Whether a cell blocks walking: open water (a bridge doesn't). */
export function isOpenWater(map: TownMap, col: number, row: number): boolean {
  return terrainAt(map, col, row) === "~";
}

/** How far water's colliders stand back from a bridge beside them: a
 * herzie (1.1 across) has to fit across a 1-cell bridge. */
export const BRIDGE_CLEARANCE = 0.3;

/** A box of open water, for one collider: world extents on the ground. */
export type WaterBox = { x0: number; x1: number; z0: number; z1: number };

/** Open water, merged along each row into runs — a handful of box
 * colliders instead of one per cell — and stood back from bridges. */
export function waterRuns(map: TownMap): WaterBox[] {
  const bridge = (c: number, r: number) => terrainAt(map, c, r) === "=";
  const runs: WaterBox[] = [];
  for (let row = 0; row < MAP_SIZE; row++) {
    let start = -1;
    let edges = "";
    const close = (end: number) => {
      const [x0, z0] = cellCenter(start, row).map((v) => v - 0.5);
      const pull = (b: boolean) => (b ? BRIDGE_CLEARANCE : 0);
      runs.push({
        x0: x0 + pull(bridge(start - 1, row)),
        x1: x0 + (end - start) - pull(bridge(end, row)),
        z0: z0 + pull(bridge(start, row - 1)),
        z1: z0 + 1 - pull(bridge(start, row + 1)),
      });
      start = -1;
    };
    for (let col = 0; col <= MAP_SIZE; col++) {
      const wet = col < MAP_SIZE && isOpenWater(map, col, row);
      // A run is cut where a bridge starts or stops along its side.
      const e = `${bridge(col, row - 1)}${bridge(col, row + 1)}`;
      if (start >= 0 && (!wet || e !== edges)) close(col);
      if (wet && start < 0) {
        start = col;
        edges = e;
      }
    }
  }
  return runs;
}

/**
 * Which way a bridge cell is crossed: "x" (east–west) or "z"
 * (north–south). A bridge runs across the water — toward walkable ground or
 * more bridge, with water to either side of it.
 */
export function bridgeAxis(map: TownMap, col: number, row: number): "x" | "z" {
  const walk = (c: number, r: number) => {
    const t = terrainAt(map, c, r);
    return t !== OFF && t !== "~" ? 1 : 0;
  };
  const wet = (c: number, r: number) => (isOpenWater(map, c, r) ? 1 : 0);
  const alongX =
    walk(col - 1, row) +
    walk(col + 1, row) +
    wet(col, row - 1) +
    wet(col, row + 1);
  const alongZ =
    walk(col, row - 1) +
    walk(col, row + 1) +
    wet(col - 1, row) +
    wet(col + 1, row);
  return alongX > alongZ ? "x" : "z";
}

/** A thing's place within its cell: nudged off-centre, sized and turned a
 * little, the same every time — so a forest doesn't look planted in rows. */
export function objectJitter(
  col: number,
  row: number,
): { x: number; z: number; scale: number; yaw: number } {
  const rand = mulberry32(col * 7919 + row * 104729 + 20261008);
  const [cx, cz] = cellCenter(col, row);
  return {
    x: cx + (rand() - 0.5) * 0.5,
    z: cz + (rand() - 0.5) * 0.5,
    scale: 0.85 + rand() * 0.4,
    yaw: rand() * Math.PI * 2,
  };
}

/** A rectangle of cells. */
export type CellRect = { col: number; row: number; w: number; h: number };

/** One building: a connected patch of building cells, as the rectangles
 * it's built from (each gets its own walls and gabled roof), and the side
 * its door is on. */
/** What each building char builds. */
export const BUILDING_KINDS = { H: "home", $: "shop", C: "cave" } as const;
export type BuildingKind = (typeof BUILDING_KINDS)[keyof typeof BUILDING_KINDS];
export const isBuildingChar = (ch: string): ch is keyof typeof BUILDING_KINDS =>
  ch in BUILDING_KINDS;

export type Building = {
  kind: BuildingKind;
  rects: CellRect[];
  /** The door: which rect, and which way it faces. */
  door: { rect: number; side: "n" | "s" | "e" | "w" } | null;
  /** Steady per building, for its colours. */
  seed: number;
};

/**
 * Every building on the map — homes, shops and caves. Painted cells of
 * the same kind that touch are one building; an L or T shape is split into rectangles, largest first.
 * The door goes in the middle of the biggest rectangle's side that faces
 * the middle of town (or the next best side that's an outside wall).
 */
export function buildingsOf(map: TownMap): Building[] {
  const seen = new Set<number>();
  const key = (c: number, r: number) => r * MAP_SIZE + c;
  const out: Building[] = [];
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let col = 0; col < MAP_SIZE; col++) {
      const ch = objectAt(map, col, row);
      if (!isBuildingChar(ch) || seen.has(key(col, row))) continue;
      // Cells of the same kind that touch are one building.
      const isH = (c: number, r: number) => objectAt(map, c, r) === ch;
      // The patch, by flood fill.
      const cells = new Set<number>();
      const stack: [number, number][] = [[col, row]];
      while (stack.length > 0) {
        const [c, r] = stack.pop() as [number, number];
        const k = key(c, r);
        if (cells.has(k) || !isH(c, r)) continue;
        cells.add(k);
        seen.add(k);
        stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
      }
      // Cut into rectangles: take the biggest one left, until none are.
      const left = new Set(cells);
      const has = (c: number, r: number) => left.has(key(c, r));
      const rects: CellRect[] = [];
      while (left.size > 0) {
        let best: CellRect | null = null;
        for (const k of left) {
          const c0 = k % MAP_SIZE;
          const r0 = Math.floor(k / MAP_SIZE);
          let maxW = Infinity;
          for (let r = r0; has(c0, r); r++) {
            let w = 0;
            while (w < maxW && has(c0 + w, r)) w++;
            maxW = w;
            const h = r - r0 + 1;
            if (!best || w * h > best.w * best.h) {
              best = { col: c0, row: r0, w, h };
            }
          }
        }
        const b = best as CellRect;
        for (let r = b.row; r < b.row + b.h; r++) {
          for (let c = b.col; c < b.col + b.w; c++) left.delete(key(c, r));
        }
        rects.push(b);
      }
      out.push({
        kind: BUILDING_KINDS[ch],
        rects,
        door: doorOf(rects[0], isH),
        seed: key(col, row),
      });
    }
  }
  return out;
}

function doorOf(
  rect: CellRect,
  isH: (c: number, r: number) => boolean,
): Building["door"] {
  const midC = rect.col + Math.floor(rect.w / 2);
  const midR = rect.row + Math.floor(rect.h / 2);
  // Toward the middle of town, from the rect's centre.
  const [cx, cz] = cellCenter(rect.col, rect.row).map(
    (v, i) => v - 0.5 + (i === 0 ? rect.w : rect.h) / 2,
  );
  const sides = (
    [
      ["n", 0, -1, midC, rect.row - 1],
      ["s", 0, 1, midC, rect.row + rect.h],
      ["w", -1, 0, rect.col - 1, midR],
      ["e", 1, 0, rect.col + rect.w, midR],
    ] as const
  )
    .filter(([, , , c, r]) => !isH(c, r))
    .map(([side, dx, dz]) => ({ side, facing: -(dx * cx + dz * cz) }))
    .sort((a, b) => b.facing - a.facing);
  return sides.length > 0 ? { rect: 0, side: sides[0].side } : null;
}

/** A small, steady shade wobble per cell (±1), so a field isn't one flat
 * colour. */
export function cellShade(col: number, row: number): number {
  return mulberry32(col * 31 + row * 1009 + 7)() * 2 - 1;
}
