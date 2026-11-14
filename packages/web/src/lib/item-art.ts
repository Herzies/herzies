import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  ARTWORK_H,
  ARTWORK_W,
  BANK_EXPANSION,
  getItemColor,
  getItemIconGradient,
  getItemType,
  ITEMS,
  TYPE_ICON_GRIDS,
} from "@herzies/shared";

/*
 * The control panel's item art workshop (local dev only): what used to be
 * the old packages/desktop/tools/item-editor server. Everything it saves goes
 * straight into the shared package's source, so the desktop app and the
 * website draw the same art:
 *
 * - Icons: per-item 24x24 pixel icons in shared/src/card/item-icon-grids.json.
 *   Each is `{ palette, grid }`, grid rows of '.' (empty) or a hex index into
 *   the palette (see shared's card/ItemTypeIcon.tsx).
 * - Card artwork: the 32x24 picture in a card's art window when it has no
 *   illustration, in item-artwork-grids.json. Without an entry it's derived
 *   from the icon (artwork-from-icon.ts).
 * - Names and descriptions: rewritten in shared/src/items.ts, then the
 *   shared build and the Supabase functions' copy are brought up to date.
 * - Card illustrations: the artist's original is kept in
 *   desktop/art-sources/card-art/ (never bundled); the finished 4:3 image the
 *   panel renders goes to shared/card-art/<id>.<ext>, with card-art.json
 *   recording both files, the credit and the framing.
 *
 * Grid and text saves rebuild @herzies/shared, which the apps run on.
 */

const run = promisify(execFile);

/** The monorepo root: the web dev server runs in packages/web. */
function repoRoot(): string {
  const root = resolve(process.cwd(), "../..");
  if (!existsSync(resolve(root, "packages/shared/src/items.ts"))) {
    throw new Error(`Can't find the repo from ${process.cwd()}`);
  }
  return root;
}

const paths = () => {
  const root = repoRoot();
  const card = resolve(root, "packages/shared/src/card");
  const cardArt = resolve(root, "packages/shared/card-art");
  return {
    root,
    items: resolve(root, "packages/shared/src/items.ts"),
    grids: resolve(card, "item-icon-grids.json"),
    artwork: resolve(card, "item-artwork-grids.json"),
    cardArtDir: cardArt,
    cardArtManifest: resolve(cardArt, "card-art.json"),
    cardArtSourceDir: resolve(root, "packages/desktop/art-sources/card-art"),
  };
};

export const MAX_NAME = 40;
export const MAX_DESCRIPTION = 200;
const ITEM_ICON_SIZE = 24;
const MAX_CARD_ART_BYTES = 10 * 1024 * 1024;

export type PixelArt = { grid: string[]; palette: string[] };

export type CardArtEntry = {
  file?: string;
  source?: string;
  crop?: { zoom: number; x: number; y: number };
  filter?: { type: "none" | "lofi"; detail?: number };
  artist?: string;
  pixelated?: boolean;
};

export type ArtItem = {
  id: string;
  name: string;
  description: string;
  /** Its name and description were found in items.ts and can be edited. */
  editableText: boolean;
  /** Sampled from its card art: a quick colour to start painting with. */
  autoColor: string;
  /** A set's shared gradient the app tints the icon with, if any. */
  gradient: string[] | null;
  /** Still on its generic type icon: no entry in the icons file yet. */
  unpainted: boolean;
  /** A catalog item (has a card), not a store listing or Town portrait. */
  isItem: boolean;
};

export type ItemArtData = {
  items: ArtItem[];
  grids: Record<string, PixelArt>;
  artwork: Record<string, PixelArt>;
  cardArt: Record<string, CardArtEntry>;
};

/** A failure with the HTTP status to answer it with. */
export class ArtError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// A double-quoted TS string literal: the only form names and descriptions
// take in items.ts, and one JSON can read and write.
const STRING_LITERAL = String.raw`"(?:[^"\\\n]|\\.)*"`;

type TextSpan = { start: number; end: number; value: string };

/** Where an item's name and description literals sit in items.ts. An `id:`
 * is a string or an exported constant (`id: SAFETY_PICK_ID`). Null if the
 * item isn't written in the expected shape: then it isn't edited, rather
 * than guessed at. */
function locateItemText(
  source: string,
  id: string,
): { name: TextSpan; description: TextSpan } | null {
  const constants = new Map(
    [...source.matchAll(/^export const (\w+) = "([^"]+)";$/gm)].map((m) => [
      m[2],
      m[1],
    ]),
  );
  const idForms = [`id: ${JSON.stringify(id)},`];
  if (constants.has(id)) idForms.push(`id: ${constants.get(id)},`);
  const catalog = source.indexOf("export const ITEMS: ItemDef[] = [");
  const at = idForms
    .map((form) => source.indexOf(`\n    ${form}`, catalog))
    .find((i) => i >= 0);
  if (catalog < 0 || at === undefined) return null;
  const end = source.indexOf("\n  },", at);
  const block = source.slice(at, end);
  const field = (key: string): TextSpan | null => {
    const m = new RegExp(`\\n    ${key}:\\s*(${STRING_LITERAL}),`).exec(block);
    if (!m) return null;
    const start = at + m.index + m[0].indexOf(m[1]);
    return { start, end: start + m[1].length, value: JSON.parse(m[1]) };
  };
  const name = field("name");
  const description = field("description");
  return name && description ? { name, description } : null;
}

/** Every catalog item's name and description, from source (the build may
 * be behind it). */
function readItemTexts(): Record<
  string,
  { name: string; description: string } | null
> {
  const source = readFileSync(paths().items, "utf8");
  return Object.fromEntries(
    ITEMS.map((item) => {
      const text = locateItemText(source, item.id);
      return [
        item.id,
        text
          ? { name: text.name.value, description: text.description.value }
          : null,
      ];
    }),
  );
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readCardArt(): Record<string, CardArtEntry> {
  return readJson(paths().cardArtManifest);
}

function writeCardArt(manifest: Record<string, CardArtEntry>): void {
  // Sorted by id so the file diffs cleanly as art is added.
  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    paths().cardArtManifest,
    `${JSON.stringify(sorted, null, 2)}\n`,
  );
}

function removeFile(dir: string, file: string): void {
  try {
    unlinkSync(resolve(dir, file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** An entry saved before originals were kept separately has only its card
 * image. Adopt that image as its original, so it can be re-framed. */
function adoptLegacyCardArt(): void {
  const { cardArtDir, cardArtSourceDir } = paths();
  const manifest = readCardArt();
  let changed = false;
  for (const [id, entry] of Object.entries(manifest)) {
    if (!entry.file || entry.source) continue;
    const source = `${id}${entry.file.slice(entry.file.lastIndexOf("."))}`;
    mkdirSync(cardArtSourceDir, { recursive: true });
    copyFileSync(
      resolve(cardArtDir, entry.file),
      resolve(cardArtSourceDir, source),
    );
    entry.source = source;
    changed = true;
  }
  if (changed) writeCardArt(manifest);
}

// Icons in the same file that belong to no catalog item (a store listing,
// emote and Town portraits): no ItemDef to take a name or colour from.
const EXTRA_ICONS: ArtItem[] = [
  { id: BANK_EXPANSION.id, name: BANK_EXPANSION.name, autoColor: "#facc15" },
  { id: "emote-wave", name: "Wave (emote)", autoColor: "#f6c99c" },
  { id: "emote-cheer", name: "Cheer (emote)", autoColor: "#f6c99c" },
  { id: "emote-sit", name: "Sit (emote)", autoColor: "#f6c99c" },
  { id: "emote-micdrop", name: "Mic Drop (emote)", autoColor: "#f6c99c" },
  {
    id: "visitor-orphiez",
    name: "Orphiez (Town portrait)",
    autoColor: "#54cbc3",
  },
  {
    id: "visitor-george",
    name: "Good ol' George (Town portrait)",
    autoColor: "#f5c518",
  },
].map((extra) => ({
  ...extra,
  description: "",
  editableText: false,
  gradient: null,
  unpainted: false,
  isItem: false,
}));

/** An item with no bespoke icon yet starts from its generic type icon, in
 * its card art's colour. Saving it creates its entry. */
function seedFor(item: (typeof ITEMS)[number]): PixelArt {
  const grid = TYPE_ICON_GRIDS[getItemType(item)] ?? [];
  return {
    grid: grid.map((row) => row.replaceAll("#", "0")),
    palette: [getItemColor(item)],
  };
}

function isValidPalette(palette: unknown): palette is string[] {
  return (
    Array.isArray(palette) &&
    palette.length >= 1 &&
    palette.length <= 16 &&
    palette.every((c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c))
  );
}

/** `width` x `height` is the stored grid's size: an edit can repaint an
 * icon but never resize it. */
function isValidGrid(
  grid: unknown,
  paletteLength: number,
  width: number,
  height = width,
): grid is string[] {
  return (
    Array.isArray(grid) &&
    grid.length === height &&
    grid.every(
      (row) =>
        typeof row === "string" &&
        row.length === width &&
        /^[.0-9a-f]+$/i.test(row) &&
        [...row].every((ch) => ch === "." || parseInt(ch, 16) < paletteLength),
    )
  );
}

/** An entry to store: keys in the order the existing entry has them
 * (palette first for a new one, as most are), so a save diffs cleanly. */
function inOrder(art: PixelArt, existing: PixelArt | undefined): PixelArt {
  return existing && Object.keys(existing)[0] === "grid"
    ? { grid: art.grid, palette: art.palette }
    : { palette: art.palette, grid: art.grid };
}

function parsePixelArt(
  payload: unknown,
  width: number,
  height: number,
): PixelArt {
  const p = payload as Partial<PixelArt> | null;
  if (!isValidPalette(p?.palette)) {
    throw new ArtError(400, "palette must be 1-16 '#rrggbb' hex colours");
  }
  if (!isValidGrid(p.grid, p.palette.length, width, height)) {
    throw new ArtError(
      400,
      `grid must be ${height} rows of exactly ${width} '.'/'0'-'9'/'a'-'f' characters, each index within the palette`,
    );
  }
  return { grid: p.grid, palette: p.palette };
}

/** Rebuilds the shared package (the apps run on its build); with `vendor`,
 * also the Supabase functions' copy of it. */
async function rebuildShared(savedTo: string, vendor = false): Promise<void> {
  const { root } = paths();
  try {
    await run("pnpm", ["--filter", "@herzies/shared", "build"], { cwd: root });
    if (vendor) await run("node", ["scripts/vendor-shared.mjs"], { cwd: root });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new ArtError(
      500,
      `Saved to ${savedTo}, but rebuilding failed: ${String(e.stderr || e.stdout || e.message).slice(0, 600)}`,
    );
  }
}

function requireItem(id: string): void {
  if (!ITEMS.some((item) => item.id === id)) {
    throw new ArtError(404, `Unknown item id: ${id}`);
  }
}

// --- Reads ---

export function readItemArt(): ItemArtData {
  const { grids: gridsPath, artwork: artworkPath } = paths();
  const stored = readJson<Record<string, PixelArt>>(gridsPath);
  const texts = readItemTexts();
  const items: ArtItem[] = ITEMS.map((item) => ({
    id: item.id,
    name: texts[item.id]?.name ?? item.name,
    description: texts[item.id]?.description ?? item.description,
    editableText: !!texts[item.id],
    autoColor: getItemColor(item),
    gradient: getItemIconGradient(item.id)?.slice() ?? null,
    unpainted: !stored[item.id],
    isItem: true,
  }));
  const grids: Record<string, PixelArt> = Object.fromEntries(
    Object.entries(stored).map(([id, e]) => [
      id,
      { grid: e.grid, palette: e.palette },
    ]),
  );
  for (const item of ITEMS) grids[item.id] ??= seedFor(item);
  items.push(...EXTRA_ICONS.filter((extra) => stored[extra.id]));
  adoptLegacyCardArt();
  return {
    items,
    grids,
    artwork: readJson(artworkPath),
    cardArt: readCardArt(),
  };
}

/** Image formats the card accepts, told apart by their leading bytes. */
const IMAGE_SIGNATURES: {
  ext: string;
  mime: string;
  test: (b: Buffer) => boolean;
}[] = [
  {
    ext: "png",
    mime: "image/png",
    test: (b) =>
      b
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: "jpg",
    mime: "image/jpeg",
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "gif",
    mime: "image/gif",
    test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  },
  {
    ext: "webp",
    mime: "image/webp",
    test: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  {
    ext: "avif",
    mime: "image/avif",
    test: (b) => b.subarray(4, 12).toString("latin1") === "ftypavif",
  },
];

/** A finished card image ("file") or an uploaded original ("source"), only
 * if the manifest names it: never an arbitrary path. */
export function readCardArtFile(
  kind: "file" | "source",
  name: string,
): { body: Buffer; mime: string } {
  const { cardArtDir, cardArtSourceDir } = paths();
  const entry = Object.values(readCardArt()).find((e) => e[kind] === name);
  if (!entry) throw new ArtError(404, `No such card art file: ${name}`);
  const ext = name.slice(name.lastIndexOf(".") + 1);
  return {
    body: readFileSync(
      resolve(kind === "file" ? cardArtDir : cardArtSourceDir, name),
    ),
    mime:
      IMAGE_SIGNATURES.find((s) => s.ext === ext)?.mime ??
      "application/octet-stream",
  };
}

// --- Writes ---

/** An item's name and description, rewritten in items.ts. */
export async function saveItemText(
  id: string,
  payload: unknown,
): Promise<{ name: string; description: string }> {
  requireItem(id);
  const p = payload as { name?: unknown; description?: unknown } | null;
  // One line each: the card prints them as single paragraphs.
  const clean = (v: unknown) =>
    typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  const name = clean(p?.name);
  const description = clean(p?.description);
  if (!name || name.length > MAX_NAME) {
    throw new ArtError(400, `Name must be 1-${MAX_NAME} characters`);
  }
  if (!description || description.length > MAX_DESCRIPTION) {
    throw new ArtError(
      400,
      `Description must be 1-${MAX_DESCRIPTION} characters`,
    );
  }
  const texts = readItemTexts();
  const clash = ITEMS.find(
    (item) =>
      item.id !== id &&
      texts[item.id]?.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new ArtError(400, `"${name}" is already ${clash.id}'s name`);

  const file = paths().items;
  const source = readFileSync(file, "utf8");
  const text = locateItemText(source, id);
  if (!text) {
    throw new ArtError(
      500,
      `Couldn't find ${id}'s name and description in items.ts`,
    );
  }
  // Description first: it comes after the name, so the name's offsets
  // still hold once it's replaced.
  let next = source;
  next =
    next.slice(0, text.description.start) +
    JSON.stringify(description) +
    next.slice(text.description.end);
  next =
    next.slice(0, text.name.start) +
    JSON.stringify(name) +
    next.slice(text.name.end);
  writeFileSync(file, next);
  await rebuildShared("items.ts", true);
  return { name, description };
}

export async function saveIcon(id: string, payload: unknown): Promise<void> {
  const file = paths().grids;
  const stored = readJson<Record<string, PixelArt>>(file);
  // A catalog item without an entry yet gets one on its first save.
  if (!(id in stored) && !ITEMS.some((item) => item.id === id)) {
    throw new ArtError(404, `Unknown icon id: ${id}`);
  }
  const size = stored[id]?.grid.length ?? ITEM_ICON_SIZE;
  stored[id] = inOrder(parsePixelArt(payload, size, size), stored[id]);
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
  await rebuildShared("item-icon-grids.json");
}

export async function saveArtwork(id: string, payload: unknown): Promise<void> {
  requireItem(id);
  const file = paths().artwork;
  const artwork = readJson<Record<string, PixelArt>>(file);
  artwork[id] = inOrder(
    parsePixelArt(payload, ARTWORK_W, ARTWORK_H),
    artwork[id],
  );
  writeFileSync(file, `${JSON.stringify(artwork, null, 2)}\n`);
  await rebuildShared("item-artwork-grids.json");
}

/** Back to deriving the card's artwork from its icon. */
export async function deleteArtwork(id: string): Promise<void> {
  requireItem(id);
  const file = paths().artwork;
  const artwork = readJson<Record<string, PixelArt>>(file);
  delete artwork[id];
  writeFileSync(file, `${JSON.stringify(artwork, null, 2)}\n`);
  await rebuildShared("item-artwork-grids.json");
}

function checkImage(body: Buffer): { body: Buffer; ext: string } {
  if (body.length > MAX_CARD_ART_BYTES) {
    throw new ArtError(
      413,
      `Image is over ${MAX_CARD_ART_BYTES / 1024 / 1024} MB`,
    );
  }
  const format = IMAGE_SIGNATURES.find((sig) => sig.test(body));
  if (!format) {
    throw new ArtError(400, "Not a PNG, JPEG, WebP, GIF or AVIF image");
  }
  return { body, ext: format.ext };
}

/** A new original from the artist. Its crop and filter start over; the
 * credit and flag carry over. The card keeps its previous finished image
 * until the panel renders this one. */
export function saveCardArtSource(id: string, body: Buffer): CardArtEntry {
  requireItem(id);
  const { cardArtSourceDir } = paths();
  const image = checkImage(body);
  const manifest = readCardArt();
  const source = `${id}.${image.ext}`;
  const previous = manifest[id];
  mkdirSync(cardArtSourceDir, { recursive: true });
  writeFileSync(resolve(cardArtSourceDir, source), image.body);
  if (previous?.source && previous.source !== source) {
    removeFile(cardArtSourceDir, previous.source);
  }
  const { crop: _crop, filter: _filter, ...rest } = previous ?? {};
  manifest[id] = { ...rest, source };
  writeCardArt(manifest);
  return manifest[id];
}

/** Checks the crop / filter / credit settings for a finished image and
 * returns them in the shape card-art.json stores. */
function parseRenderSettings(
  raw: unknown,
): Omit<CardArtEntry, "file" | "source"> {
  const r = raw as {
    crop?: { zoom?: unknown; x?: unknown; y?: unknown };
    filter?: { type?: unknown; detail?: unknown };
    artist?: unknown;
    pixelated?: unknown;
  } | null;
  const num = (v: unknown, min: number, max: number, name: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      throw new ArtError(
        400,
        `Bad settings: ${name} must be a number from ${min} to ${max}`,
      );
    }
    return Math.round(v * 1000) / 1000;
  };
  const crop = {
    zoom: num(r?.crop?.zoom, 1, 8, "crop.zoom"),
    x: num(r?.crop?.x, 0, 100, "crop.x"),
    y: num(r?.crop?.y, 0, 100, "crop.y"),
  };
  const type = r?.filter?.type;
  if (type !== "none" && type !== "lofi") {
    throw new ArtError(400, "Bad settings: filter.type must be none or lofi");
  }
  const filter: CardArtEntry["filter"] =
    type === "lofi"
      ? { type, detail: num(r?.filter?.detail, 0, 100, "filter.detail") }
      : { type };
  const settings: Omit<CardArtEntry, "file" | "source"> = { crop, filter };
  const artist = typeof r?.artist === "string" ? r.artist.trim() : "";
  if (artist) settings.artist = artist.slice(0, 60);
  if (r?.pixelated === true) settings.pixelated = true;
  return settings;
}

/** The finished card image, framed and filtered by the panel, plus the
 * settings that made it, so it can be re-framed from the original later. */
export function saveCardArtRender(
  id: string,
  rawSettings: unknown,
  body: Buffer,
): CardArtEntry {
  requireItem(id);
  const { cardArtDir } = paths();
  const manifest = readCardArt();
  const previous = manifest[id];
  if (!previous?.source)
    throw new ArtError(404, "Upload an illustration first");
  const settings = parseRenderSettings(rawSettings);
  const image = checkImage(body);
  const file = `${id}.${image.ext}`;
  writeFileSync(resolve(cardArtDir, file), image.body);
  if (previous.file && previous.file !== file)
    removeFile(cardArtDir, previous.file);
  manifest[id] = { file, source: previous.source, ...settings };
  writeCardArt(manifest);
  return manifest[id];
}

export function deleteCardArt(id: string): void {
  requireItem(id);
  const { cardArtDir, cardArtSourceDir } = paths();
  const manifest = readCardArt();
  const entry = manifest[id];
  if (!entry) return;
  if (entry.file) removeFile(cardArtDir, entry.file);
  if (entry.source) removeFile(cardArtSourceDir, entry.source);
  delete manifest[id];
  writeCardArt(manifest);
}
