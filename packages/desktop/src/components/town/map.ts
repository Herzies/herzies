import { mulberry32 } from "@herzies/shared";

/**
 * An island as a map: two layers of characters on a square grid of 1-unit
 * cells centred on the island's middle — what the ground is, and what
 * stands on it — plus where the visitors stand and where you start.
 * Written by the map editor (`pnpm map-editor`) to maps/<id>.json, one row
 * per line, so a map reads (and diffs) as a picture.
 *
 * Every island is round and fills its grid: its radius is half the grid's
 * size. Cell (col, row) covers x in [col - size/2, col - size/2 + 1], z
 * likewise with the row: row 0 is the north edge (-z), col 0 the west (-x).
 */

/** How far short of an island's edge you can walk: you can look over the
 * edge but not fall off it. */
export const EDGE_MARGIN = 3;
/** The home island's grid: cells per side. */
export const MAP_SIZE = 86;
/** Smallest and largest islands the editor makes. */
export const MIN_MAP_SIZE = 24;
export const MAX_MAP_SIZE = 120;

/** Anything with a grid: a map, or just its size. */
export type Grid = { size: number };

/** How far an island reaches from its middle. */
export function islandRadius(g: Grid): number {
  return g.size / 2;
}
/** How far you can walk from an island's middle. */
export function worldRadius(g: Grid): number {
  return g.size / 2 - EDGE_MARGIN;
}
/** The home island's walkable radius (the town server checks moves
 * against it). */
export const WORLD_RADIUS = worldRadius({ size: MAP_SIZE });
export const ISLAND_RADIUS = islandRadius({ size: MAP_SIZE });

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
  L: { name: "Lamp post", color: "#ffd98a" },
  _: { name: "Bench", color: "#a8743f" },
  M: { name: "Stand", color: "#e8667f" },
  N: { name: "Bulletin board", color: "#f2e3b8" },
  H: { name: "Home", color: "#c9a27a" },
  $: { name: "Shop", color: "#6a9ae0" },
  C: { name: "Cave", color: "#8a8070" },
  "@": { name: "Statue", color: "#d8d4cc" },
  D: { name: "Training dummy", color: "#d9b26a" },
  O: { name: "Portal", color: "#b07aff" },
} as const;
export type ObjectChar = keyof typeof OBJECTS;

export type Point = [x: number, z: number];

/** A map's name in files, URLs and the town server's rooms. */
export type MapId = string;
export const MAP_ID = /^[a-z][a-z0-9-]{1,23}$/;

/** Where a portal leads. */
export type PortalLink = { to: MapId };

export type TownMap = {
  version: 2;
  id: MapId;
  /** What the game calls it ("Enter the Training Grounds"). */
  name: string;
  size: number;
  /** Where the island floats in the one sky every island shares: the
   * island you're on is drawn at the origin, the others where they float
   * relative to it. Home is at [0, 0, 0]. */
  origin: [x: number, y: number, z: number];
  /** Whether you can fight here (the training grounds' dummies). */
  combat?: boolean;
  /** An enclosed room instead of an island in the sky: no sky, clouds or
   * other islands, a floor and walls, and a lamp-lit dark. The boss's
   * cave. Room maps aren't drawn as islands in anyone else's sky. */
  room?: "dark";
  /** Where each portal ("O") leads: "col,row" → link. */
  portals?: Record<string, PortalLink>;
  /** size rows of size terrain chars (OFF where off the island). */
  terrain: string[];
  /** Same shape: what stands on each cell ('.' nothing, OFF off-island). */
  objects: string[];
  /** Where each kind of visitor stands. */
  spots: Record<string, Point>;
  /** Where any other visitor stands, in turn. */
  spare: Point[];
  /** Where you start, and which way you face (forward is (sin, cos)). */
  spawn: { at: Point; heading: number };
  /** Objects turned by hand in the editor: "col,row" → eighths of a turn
   * (0–7, 0 facing +z). Anything not listed faces its own way (a bench
   * the nearest path, a rock wherever it fell). */
  facing?: Record<string, number>;
};

/** An eighth of a turn: the steps objects are turned in. */
export const EIGHTH = Math.PI / 4;

/** Which way an object was turned to by hand (forward is (sin, cos)), or
 * undefined if it faces its own way. */
export function facingAt(
  map: TownMap,
  col: number,
  row: number,
): number | undefined {
  const n = map.facing?.[`${col},${row}`];
  return n === undefined ? undefined : n * EIGHTH;
}

/** The map with one object turned to `n` eighths (undefined: back to its
 * own way). */
export function withFacing(
  map: TownMap,
  col: number,
  row: number,
  n: number | undefined,
): TownMap {
  const facing = { ...map.facing };
  if (n === undefined) delete facing[`${col},${row}`];
  else facing[`${col},${row}`] = ((Math.round(n) % 8) + 8) % 8;
  return { ...map, facing };
}

/** Turns only on cells that still have something on them: painting an
 * object away forgets its turn. */
export function pruneFacing(map: TownMap): TownMap {
  if (!map.facing) return map;
  const facing = Object.fromEntries(
    Object.entries(map.facing).filter(([k]) => {
      const [c, r] = k.split(",").map(Number);
      return objectAt(map, c, r) !== ".";
    }),
  );
  return Object.keys(facing).length === Object.keys(map.facing).length
    ? map
    : { ...map, facing };
}

/** Visitor kinds with a spot of their own, as the editor names them. (The
 * boss has none: it is in its cave, not in town.) */
export const SPOT_NAMES: Record<string, string> = {
  merchant: "George",
  song_hunt: "Orphiez",
  treat_trader: "Nandor",
  boboku: "Boboku",
  medea: "Medea",
};

/** The centre of a cell, in world (x, z). */
export function cellCenter(g: Grid, col: number, row: number): Point {
  const half = g.size / 2;
  return [col - half + 0.5, row - half + 0.5];
}

/** The cell a world point falls in (may be off the grid). */
export function cellAt(
  g: Grid,
  x: number,
  z: number,
): [col: number, row: number] {
  const half = g.size / 2;
  return [Math.floor(x + half), Math.floor(z + half)];
}

function cellCorners(g: Grid, col: number, row: number): Point[] {
  const x = col - g.size / 2;
  const z = row - g.size / 2;
  return [
    [x, z],
    [x + 1, z],
    [x + 1, z + 1],
    [x, z + 1],
  ];
}

/** Whether any of the cell is on the island. */
export function onIsland(g: Grid, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= g.size || row >= g.size) return false;
  const x0 = col - g.size / 2;
  const z0 = row - g.size / 2;
  // The cell's nearest point to the island's middle.
  const nx = Math.max(x0, Math.min(0, x0 + 1));
  const nz = Math.max(z0, Math.min(0, z0 + 1));
  return Math.hypot(nx, nz) < islandRadius(g);
}

/** Whether the whole cell is on the island — only those can hold water
 * (a pond cut into the rim would open a hole in the island's side). */
export function inland(g: Grid, col: number, row: number): boolean {
  return cellCorners(g, col, row).every(
    ([x, z]) => Math.hypot(x, z) <= islandRadius(g),
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
export function emptyMap(
  size = MAP_SIZE,
  id: MapId = "home",
  name = "Town",
): TownMap {
  const g = { size };
  const rows = (fill: string) =>
    Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) =>
        onIsland(g, c, r) ? fill : OFF,
      ).join(""),
    );
  return {
    version: 2,
    id,
    name,
    size,
    origin: [0, 0, 0],
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

const isOrigin = (p: unknown): p is TownMap["origin"] =>
  Array.isArray(p) &&
  p.length === 3 &&
  p.every((n) => typeof n === "number" && Number.isFinite(n));

/** The cells holding a portal, as "col,row" keys. */
export function portalCells(map: TownMap): string[] {
  const out: string[] = [];
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) === "O") out.push(`${col},${row}`);
    }
  }
  return out;
}

/**
 * Check a map read from JSON. Throws with every problem found (up to a
 * few), rather than drawing a world from a broken file. A version 1 file
 * (before there was more than one island) is the home island.
 *
 * Where portals lead is only checked against the other maps by the map
 * registry (maps/index.ts), which knows them all.
 */
export function parseMap(json: unknown): TownMap {
  const errors: string[] = [];
  const raw = json as Partial<TownMap> | null;
  if (!raw || typeof raw !== "object") throw new Error("map: not an object");
  const m: Partial<TownMap> =
    (raw.version as number) === 1
      ? { ...raw, version: 2, id: "home", name: "Town", origin: [0, 0, 0] }
      : { ...raw };
  if (m.version !== 2) errors.push(`version ${m.version}, expected 2`);
  if (typeof m.id !== "string" || !MAP_ID.test(m.id)) {
    errors.push(`id ${JSON.stringify(m.id)}: expected a-z, 0-9 and -`);
  }
  if (typeof m.name !== "string" || m.name.trim() === "") {
    errors.push("name: missing");
  }
  if (!isOrigin(m.origin)) errors.push("origin: expected [x, y, z]");
  if (m.combat !== undefined && typeof m.combat !== "boolean") {
    errors.push("combat: expected true or false");
  }
  if (m.room !== undefined && m.room !== "dark") {
    errors.push('room: expected "dark"');
  }
  const size = m.size as number;
  if (
    !Number.isInteger(size) ||
    size % 2 !== 0 ||
    size < MIN_MAP_SIZE ||
    size > MAX_MAP_SIZE
  ) {
    errors.push(
      `size ${m.size}, expected an even number from ${MIN_MAP_SIZE} to ${MAX_MAP_SIZE}`,
    );
    throw new Error(`map: ${errors.join("; ")}`);
  }
  const g = { size };

  const grid = (name: "terrain" | "objects", chars: string) => {
    const rows = m[name];
    if (!Array.isArray(rows) || rows.length !== size) {
      errors.push(`${name}: expected ${size} rows`);
      return;
    }
    rows.forEach((row, r) => {
      if (typeof row !== "string" || row.length !== size) {
        errors.push(`${name} row ${r}: expected ${size} chars`);
        return;
      }
      for (let c = 0; c < size; c++) {
        const ch = row[c];
        if (!onIsland(g, c, r)) {
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
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const t = terrainAt(map, c, r);
        if (isSunk(t) && !inland(g, c, r)) {
          errors.push(`terrain (${c}, ${r}): water on the rim`);
        }
        if (isSunk(t) && objectAt(map, c, r) !== ".") {
          errors.push(`objects (${c}, ${r}): standing in water`);
        }
      }
    }
    // Every portal leads somewhere, and only portals have links.
    const cells = new Set(portalCells(map));
    const links = m.portals ?? {};
    if (!links || typeof links !== "object") {
      errors.push('portals: expected { "col,row": { to } }');
    } else {
      for (const k of cells) {
        if (!links[k]) errors.push(`portals.${k}: leads nowhere`);
      }
      for (const [k, link] of Object.entries(links)) {
        if (!cells.has(k)) errors.push(`portals.${k}: no portal there`);
        else if (
          !link ||
          typeof link.to !== "string" ||
          !MAP_ID.test(link.to)
        ) {
          errors.push(`portals.${k}: expected { to: map id }`);
        } else if (link.to === m.id) {
          errors.push(`portals.${k}: leads back to this island`);
        }
      }
    }
  }

  const reach = worldRadius(g);
  const where = (label: string, p: unknown) => {
    if (!isPoint(p)) errors.push(`${label}: expected [x, z]`);
    else if (Math.hypot(p[0], p[1]) > reach) {
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
  if (m.facing !== undefined) {
    if (!m.facing || typeof m.facing !== "object") {
      errors.push('facing: expected { "col,row": eighths }');
    } else {
      for (const [k, n] of Object.entries(m.facing)) {
        const [c, r] = k.split(",").map(Number);
        if (
          !Number.isInteger(c) ||
          !Number.isInteger(r) ||
          !onIsland(g, c, r)
        ) {
          errors.push(`facing.${k}: not a cell on the island`);
        } else if (!Number.isInteger(n) || n < 0 || n > 7) {
          errors.push(`facing.${k}: expected 0–7`);
        }
      }
    }
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
  // A top-level field on one line when it fits in 80 columns, else one item
  // per line: how Biome formats it, so saved maps pass `biome ci`.
  const field = (key: string, [open, close]: string, items: string[]) => {
    const line = `  ${JSON.stringify(key)}: ${open}${
      open === "{" && items.length ? ` ${items.join(", ")} ` : items.join(", ")
    }${close},`;
    if (line.length <= 80 || !items.length) return `\n${line}`;
    return `\n  ${JSON.stringify(key)}: ${open}\n${items
      .map((i) => `    ${i}`)
      .join(",\n")}\n  ${close},`;
  };
  // Turned objects, top row first.
  const turned = Object.entries(map.facing ?? {}).sort(([a], [b]) => {
    const [ac, ar] = a.split(",").map(Number);
    const [bc, br] = b.split(",").map(Number);
    return ar - br || ac - bc;
  });
  const facing = turned.length
    ? field(
        "facing",
        "{}",
        turned.map(([k, n]) => `${JSON.stringify(k)}: ${n}`),
      )
    : "";
  const spots = Object.entries(map.spots)
    .map(([k, p]) => `    ${JSON.stringify(k)}: ${pt(p)}`)
    .join(",\n");
  const links = Object.entries(map.portals ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const portals = links.length
    ? field(
        "portals",
        "{}",
        links.map(
          ([k, l]) => `${JSON.stringify(k)}: { "to": ${JSON.stringify(l.to)} }`,
        ),
      )
    : "";
  const combat = map.combat ? `\n  "combat": true,` : "";
  const room = map.room ? `\n  "room": ${JSON.stringify(map.room)},` : "";
  return `{
  "version": ${map.version},
  "id": ${JSON.stringify(map.id)},
  "name": ${JSON.stringify(map.name)},
  "size": ${map.size},
  "origin": [${map.origin.join(", ")}],${combat}${room}${portals}
  "spawn": { "at": ${pt(map.spawn.at)}, "heading": ${map.spawn.heading} },
  "spots": {${spots ? `\n${spots}\n  ` : ""}},${field("spare", "[]", map.spare.map(pt))}${facing}
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
  for (let row = 0; row < map.size; row++) {
    let start = -1;
    let edges = "";
    const close = (end: number) => {
      const [x0, z0] = cellCenter(map, start, row).map((v) => v - 0.5);
      const pull = (b: boolean) => (b ? BRIDGE_CLEARANCE : 0);
      runs.push({
        x0: x0 + pull(bridge(start - 1, row)),
        x1: x0 + (end - start) - pull(bridge(end, row)),
        z0: z0 + pull(bridge(start, row - 1)),
        z1: z0 + 1 - pull(bridge(start, row + 1)),
      });
      start = -1;
    };
    for (let col = 0; col <= map.size; col++) {
      const wet = col < map.size && isOpenWater(map, col, row);
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
  g: Grid,
  col: number,
  row: number,
): { x: number; z: number; scale: number; yaw: number } {
  const rand = mulberry32(col * 7919 + row * 104729 + 20261008);
  const [cx, cz] = cellCenter(g, col, row);
  return {
    x: cx + (rand() - 0.5) * 0.5,
    z: cz + (rand() - 0.5) * 0.5,
    scale: 0.85 + rand() * 0.4,
    yaw: rand() * Math.PI * 2,
  };
}

/** A thing's place within its cell (see objectJitter), turned the way it
 * was turned in the editor, if it was. */
export function objectPlace(map: TownMap, col: number, row: number) {
  const place = objectJitter(map, col, row);
  return { ...place, yaw: facingAt(map, col, row) ?? place.yaw };
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

/** A building's rectangle, with where its north-west corner is in the
 * world. */
export type BuildingRect = CellRect & { x0: number; z0: number };

export type Building = {
  kind: BuildingKind;
  rects: BuildingRect[];
  /** The door: which rect, and which way it faces. */
  door: { rect: number; side: "n" | "s" | "e" | "w" } | null;
  /** Steady per building, for its colours. */
  seed: number;
  /** Half its island's size: a cell's offset from the world's origin. */
  half: number;
};

/**
 * Every building on the map — homes, shops and caves. Painted cells of
 * the same kind that touch are one building; an L or T shape is split into rectangles, largest first.
 * The door goes in the middle of the biggest rectangle's side that faces
 * the middle of town (or the next best side that's an outside wall).
 */
export function buildingsOf(map: TownMap): Building[] {
  const seen = new Set<number>();
  const size = map.size;
  const key = (c: number, r: number) => r * size + c;
  const out: Building[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
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
          const c0 = k % size;
          const r0 = Math.floor(k / size);
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
      const half = size / 2;
      out.push({
        kind: BUILDING_KINDS[ch],
        rects: rects.map((r) => ({ ...r, x0: r.col - half, z0: r.row - half })),
        door: doorOf(map, rects[0], isH),
        seed: key(col, row),
        half,
      });
    }
  }
  return out;
}

function doorOf(
  g: Grid,
  rect: CellRect,
  isH: (c: number, r: number) => boolean,
): Building["door"] {
  const midC = rect.col + Math.floor(rect.w / 2);
  const midR = rect.row + Math.floor(rect.h / 2);
  // Toward the middle of town, from the rect's centre.
  const [cx, cz] = cellCenter(g, rect.col, rect.row).map(
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

/** How far round a point the ground blends what's there: the half-width
 * of the square the terrain is averaged over. Under a cell, so a 1-wide
 * stream still reads as water down its middle. */
export const BLEND_RADIUS = 0.6;

/** What the ground at a point is, blended: how much of the square round it
 * is grass, gravel and water (bridges count as water — they're over it).
 * Edges between them blur into slopes and soft borders, and a corner's
 * blend curves round it rather than squaring off. Sums to 1. */
export type GroundBlend = { grass: number; gravel: number; wet: number };

export function groundBlend(map: TownMap, x: number, z: number): GroundBlend {
  const R = BLEND_RADIUS;
  const out = { grass: 0, gravel: 0, wet: 0 };
  const half = map.size / 2;
  const [c0, r0] = cellAt(map, x - R, z - R);
  const [c1, r1] = cellAt(map, x + R, z + R);
  for (let row = r0; row <= r1; row++) {
    const cz = row - half;
    const oz = Math.min(z + R, cz + 1) - Math.max(z - R, cz);
    if (oz <= 0) continue;
    for (let col = c0; col <= c1; col++) {
      const cx = col - half;
      const ox = Math.min(x + R, cx + 1) - Math.max(x - R, cx);
      if (ox <= 0) continue;
      const t = terrainAt(map, col, row);
      const key = isSunk(t) ? "wet" : t === "g" ? "gravel" : "grass";
      out[key] += ox * oz;
    }
  }
  const area = 4 * R * R;
  out.grass /= area;
  out.gravel /= area;
  out.wet /= area;
  return out;
}

/** Whether a cell's ground is the same all over: it and every cell round
 * it (within the blend) are one kind, so it needs no finer mesh. */
export function blendsFlat(map: TownMap, col: number, row: number): boolean {
  const kind = (t: string) => (isSunk(t) ? "~" : t === "g" ? "g" : ".");
  const k = kind(terrainAt(map, col, row));
  for (let r = row - 1; r <= row + 1; r++) {
    for (let c = col - 1; c <= col + 1; c++) {
      if (kind(terrainAt(map, c, r)) !== k) return false;
    }
  }
  return true;
}

/** How deep a pond's bed sits under the ground (at 0). */
export const BED = -0.6;
/** Where between dry (0) and all water (1) the bank starts down, and where
 * it reaches the bed. Starting past half keeps the ground at a pond's edge
 * cell all but level, so what you walk on doesn't dip. */
const BANK_TOP = 0.45;
const BANK_FOOT = 0.9;

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The ground's height for how wet it is there (`groundBlend`'s `wet`). */
export function groundHeight(wet: number): number {
  return BED * smooth(BANK_TOP, BANK_FOOT, wet);
}

/** How wet the ground is where it goes under a surface at `level` — the
 * shoreline. */
export function wetAtHeight(level: number): number {
  let lo = BANK_TOP;
  let hi = BANK_FOOT;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (groundHeight(mid) > level) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
