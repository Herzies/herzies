#!/usr/bin/env node
// Tiny local item editor — no build step, just a plain Node http server + a
// static page. Everything it saves goes straight into the shared package's
// source (the collector card lives there, so the desktop app and the website
// draw the same art); data the app reads from the shared build is rebuilt
// after each save, and the running app (via Vite) picks it up from there.
//
// - Icons: the per-item pixel icons in
//   ../../../shared/src/card/item-icon-grids.json (rebuilt into the shared
//   package on save). Each entry is
//   `{ palette, grid }`: `grid` is N rows of N '.' (empty) / '0'-'9'/'a'-'f'
//   (an index into `palette`) — a per-pixel paint job, not one solid tint
//   (see shared's card/ItemTypeIcon.tsx). N is 24, for items and Town's visitor portraits
//   (see VisitorIcon.tsx) alike.
// - Names and descriptions: written straight into the catalog's source,
//   ../../../shared/src/items.ts, then the shared package is rebuilt (the
//   app runs on its build) and the Supabase functions' copy of it
//   regenerated (scripts/vendor-shared.mjs), so all three stay in step.
// - Card artwork: the pixel picture in a card's art window when it has no
//   uploaded illustration — 32x24 (4:3), same dialect as the icons, in
//   ../../../shared/src/card/item-artwork-grids.json (rebuilt on save, like
//   the icons). An item without an
//   entry derives it from its icon (artwork-from-icon.ts, which the page
//   loads too), so it only gets an entry once it's edited on its own.
// - Card illustrations: the art on an item's collector card (see
//   shared's card/ItemCardArt.tsx). The artist's original is kept untouched in
//   ../../art-sources/card-art/ (outside src/, so it is never bundled); the
//   page crops, zooms and filters it on a canvas and saves the finished
//   4:3 image to ../../../shared/card-art/ as `<itemId>.<ext>` — the
//   only file the apps ship (read from source, so no rebuild). card-art.json beside it records both files,
//   the artist credit and the settings, so the art can be re-framed from
//   the original at any time. An item without one shows its icon instead.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BANK_EXPANSION,
  getItemColor,
  getItemIconGradient,
  getItemType,
  ITEMS,
} from "@herzies/shared";
import {
  ARTWORK_H,
  ARTWORK_W,
} from "../../../shared/src/card/artwork-from-icon.ts";
import { TYPE_ICON_GRIDS } from "../../../shared/src/card/type-icon-grids.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const ITEMS_SOURCE_PATH = resolve(REPO_ROOT, "packages/shared/src/items.ts");
const run = promisify(execFile);

const MAX_NAME = 40;
const MAX_DESCRIPTION = 200;

// A double-quoted TS string literal — the only form names and descriptions
// take in items.ts, and one JSON can read and write.
const STRING_LITERAL = String.raw`"(?:[^"\\\n]|\\.)*"`;

/** Where an item's name and description literals sit in items.ts. An item's
 * `id:` is a string or an exported constant (`id: SAFETY_PICK_ID`), so a
 * constant is resolved through its `export const`. Null if the item isn't
 * written in the expected shape — then it isn't edited, rather than guessed
 * at. */
function locateItemText(source, id) {
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
  const field = (key) => {
    const m = new RegExp(`\\n    ${key}:\\s*(${STRING_LITERAL}),`).exec(block);
    if (!m) return null;
    const start = at + m.index + m[0].indexOf(m[1]);
    return { start, end: start + m[1].length, value: JSON.parse(m[1]) };
  };
  const name = field("name");
  const description = field("description");
  return name && description ? { name, description } : null;
}

/** Every catalog item's current name and description, from source (the
 * build may be behind it). */
function readItemTexts() {
  const source = readFileSync(ITEMS_SOURCE_PATH, "utf8");
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
const CARD_SOURCE_DIR = resolve(REPO_ROOT, "packages/shared/src/card");
const GRIDS_PATH = resolve(CARD_SOURCE_DIR, "item-icon-grids.json");
const ARTWORK_PATH = resolve(CARD_SOURCE_DIR, "item-artwork-grids.json");
const ARTWORK_LIB_PATH = resolve(CARD_SOURCE_DIR, "artwork-from-icon.ts");
const CARD_ART_DIR = resolve(REPO_ROOT, "packages/shared/card-art");
const CARD_ART_MANIFEST = resolve(CARD_ART_DIR, "card-art.json");
const CARD_ART_SOURCE_DIR = resolve(__dirname, "../../art-sources/card-art");
const HTML_PATH = resolve(__dirname, "index.html");
const PORT = process.env.ITEM_EDITOR_PORT ?? 4560;

/** Largest image accepted, original or finished. */
const MAX_CARD_ART_BYTES = 10 * 1024 * 1024;

/** Image formats the card accepts, told apart by their leading bytes rather
 * than the browser's say-so — the extension the file is saved under. */
const IMAGE_SIGNATURES = [
  { ext: "png", mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", mime: "image/gif", test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { ext: "webp", mime: "image/webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: "avif", mime: "image/avif", test: (b) => b.subarray(4, 12).toString("latin1") === "ftypavif" },
];

function readCardArt() {
  return JSON.parse(readFileSync(CARD_ART_MANIFEST, "utf8"));
}

function writeCardArt(manifest) {
  // Sorted by id so the file diffs cleanly as art is added.
  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(CARD_ART_MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`);
}

const CARD_ART_FILTERS = ["none", "lofi"];

/** Checks the editor's crop / filter / credit settings for a finished card
 * image and returns them in the shape card-art.json stores. Throws on
 * anything out of range. */
function parseRenderSettings(raw) {
  const num = (v, min, max, name) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      throw new Error(`${name} must be a number from ${min} to ${max}`);
    return Math.round(v * 1000) / 1000;
  };
  const crop = {
    zoom: num(raw?.crop?.zoom, 1, 8, "crop.zoom"),
    x: num(raw?.crop?.x, 0, 100, "crop.x"),
    y: num(raw?.crop?.y, 0, 100, "crop.y"),
  };
  const type = raw?.filter?.type;
  if (!CARD_ART_FILTERS.includes(type))
    throw new Error(`filter.type must be one of ${CARD_ART_FILTERS.join(", ")}`);
  const filter = { type };
  if (type !== "none") {
    filter.detail = num(raw.filter.detail, 0, 100, "filter.detail");
  }
  const settings = { crop, filter };
  const artist = typeof raw.artist === "string" ? raw.artist.trim() : "";
  if (artist) settings.artist = artist.slice(0, 60);
  if (raw.pixelated === true) settings.pixelated = true;
  return settings;
}

/** An entry saved before originals were kept separately has only its card
 * image (`file`). Adopt that image as its original, so it can be framed and
 * filtered like any other; its card image stays as it is until re-saved. */
function adoptLegacyCardArt() {
  const manifest = readCardArt();
  let changed = false;
  for (const [id, entry] of Object.entries(manifest)) {
    if (!entry.file || entry.source) continue;
    const source = `${id}${entry.file.slice(entry.file.lastIndexOf("."))}`;
    mkdirSync(CARD_ART_SOURCE_DIR, { recursive: true });
    copyFileSync(
      resolve(CARD_ART_DIR, entry.file),
      resolve(CARD_ART_SOURCE_DIR, source),
    );
    entry.source = source;
    changed = true;
  }
  if (changed) writeCardArt(manifest);
}

function removeFile(dir, file) {
  try {
    unlinkSync(resolve(dir, file));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Icons that live in the same JSON file but belong to no catalog item — a store
// listing rather than a card, so there is no ItemDef to take a name or colour
// from. Add one here and give it an entry in the JSON, and it shows up in the
// editor like any item.
const EXTRA_ICONS = [
  {
    id: BANK_EXPANSION.id,
    name: BANK_EXPANSION.name,
    autoColor: "#facc15",
    gradient: null,
  },
  // Hand-tweaked Town portraits (VisitorIcon). Without an entry the portrait
  // is drawn from the visitor's 3D look instead; the seeded entries started
  // as a snapshot of exactly that.
  {
    id: "visitor-orphiez",
    name: "Orphiez (Town portrait)",
    autoColor: "#54cbc3",
    gradient: null,
  },
  {
    id: "visitor-george",
    name: "Good ol' George (Town portrait)",
    autoColor: "#f5c518",
    gradient: null,
  },
];

function readArtwork() {
  return JSON.parse(readFileSync(ARTWORK_PATH, "utf8"));
}

function writeArtwork(artwork) {
  writeFileSync(ARTWORK_PATH, `${JSON.stringify(artwork, null, 2)}\n`);
}

/** Rebuilds the shared package, which the apps run on — after a grid save,
 * since the grids are bundled into its build. */
function rebuildShared() {
  return run("pnpm", ["--filter", "@herzies/shared", "build"], {
    cwd: REPO_ROOT,
  });
}

/** Rebuilds the shared package after a save to `file`, and answers with
 * `ok`, or with what went wrong. */
async function sendAfterRebuild(res, file) {
  try {
    await rebuildShared();
  } catch (err) {
    sendJson(res, 500, {
      error: `Saved to ${file}, but rebuilding shared failed: ${String(err.stderr || err.stdout || err.message).slice(0, 600)}`,
    });
    return;
  }
  sendJson(res, 200, { ok: true });
}

function readGrids() {
  return JSON.parse(readFileSync(GRIDS_PATH, "utf8"));
}

const ITEM_ICON_SIZE = 24;

/** An item with no bespoke icon yet starts from the generic type icon the app
 * shows for it, in its card art's colour. Saving it creates its entry. */
function seedFor(item) {
  const grid = TYPE_ICON_GRIDS[getItemType(item)] ?? [];
  return {
    grid: grid.map((row) => row.replaceAll("#", "0")),
    palette: [getItemColor(item)],
  };
}

function isValidColor(color) {
  return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color);
}

function isValidPalette(palette) {
  return (
    Array.isArray(palette) &&
    palette.length >= 1 &&
    palette.length <= 16 &&
    palette.every(isValidColor)
  );
}

// `width` x `height` is the stored grid's size: an edit can repaint an icon
// but never resize it.
function isValidGrid(grid, paletteLength, width, height = width) {
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

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // The artwork derivation, for the page: the same module the app and this
    // server use, with its types stripped.
    // An item's name and description: rewritten in items.ts, then the
    // shared build and the Supabase copy are brought up to date.
    if (req.method === "POST" && url.pathname.startsWith("/api/items/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/items/".length));
      if (!ITEMS.some((item) => item.id === id)) {
        sendJson(res, 404, { error: `Unknown item id: ${id}` });
        return;
      }
      let payload;
      try {
        payload = JSON.parse((await readBody(req, 16 * 1024))?.toString("utf8") ?? "");
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      // One line each: the card prints them as single paragraphs.
      const clean = (v) =>
        typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
      const name = clean(payload.name);
      const description = clean(payload.description);
      if (!name || name.length > MAX_NAME) {
        sendJson(res, 400, { error: `Name must be 1-${MAX_NAME} characters` });
        return;
      }
      if (!description || description.length > MAX_DESCRIPTION) {
        sendJson(res, 400, {
          error: `Description must be 1-${MAX_DESCRIPTION} characters`,
        });
        return;
      }
      const clash = ITEMS.find(
        (item) =>
          item.id !== id &&
          readItemTexts()[item.id]?.name.toLowerCase() === name.toLowerCase(),
      );
      if (clash) {
        sendJson(res, 400, { error: `"${name}" is already ${clash.id}'s name` });
        return;
      }
      const source = readFileSync(ITEMS_SOURCE_PATH, "utf8");
      const text = locateItemText(source, id);
      if (!text) {
        sendJson(res, 500, {
          error: `Couldn't find ${id}'s name and description in items.ts`,
        });
        return;
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
      writeFileSync(ITEMS_SOURCE_PATH, next);
      // The app runs on the shared build; the edge functions on their copy.
      try {
        await rebuildShared();
        await run("node", ["scripts/vendor-shared.mjs"], { cwd: REPO_ROOT });
      } catch (err) {
        sendJson(res, 500, {
          error: `Saved to items.ts, but rebuilding failed: ${String(err.stderr || err.stdout || err.message).slice(0, 600)}`,
        });
        return;
      }
      sendJson(res, 200, { ok: true, name, description });
      return;
    }

    if (req.method === "GET" && url.pathname === "/lib/artwork-from-icon.js") {
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(stripTypeScriptTypes(readFileSync(ARTWORK_LIB_PATH, "utf8")));
      return;
    }

    if (url.pathname.startsWith("/api/artwork/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/artwork/".length));
      if (!ITEMS.some((item) => item.id === id)) {
        sendJson(res, 404, { error: `Unknown item id: ${id}` });
        return;
      }
      const artwork = readArtwork();
      if (req.method === "POST") {
        let payload;
        try {
          payload = JSON.parse((await readBody(req, 256 * 1024))?.toString("utf8") ?? "");
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }
        if (!isValidPalette(payload.palette)) {
          sendJson(res, 400, {
            error: "palette must be 1-16 '#rrggbb' hex colours",
          });
          return;
        }
        if (!isValidGrid(payload.grid, payload.palette.length, ARTWORK_W, ARTWORK_H)) {
          sendJson(res, 400, {
            error: `grid must be ${ARTWORK_H} rows of exactly ${ARTWORK_W} '.'/'0'-'9'/'a'-'f' characters, each index within the palette`,
          });
          return;
        }
        artwork[id] = { palette: payload.palette, grid: payload.grid };
        writeArtwork(artwork);
        await sendAfterRebuild(res, "item-artwork-grids.json");
        return;
      }
      // Back to deriving it from the icon.
      if (req.method === "DELETE") {
        delete artwork[id];
        writeArtwork(artwork);
        await sendAfterRebuild(res, "item-artwork-grids.json");
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(HTML_PATH, "utf8"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/icons") {
      const stored = readGrids();
      // Every catalog item, painted or not (see seedFor), plus the
      // EXTRA_ICONS above.
      const texts = readItemTexts();
      const items = ITEMS.map((item) => {
        return {
          id: item.id,
          name: texts[item.id]?.name ?? item.name,
          description: texts[item.id]?.description ?? item.description,
          // Whether its name and description can be edited (found in
          // items.ts in the expected shape).
          editableText: !!texts[item.id],
          // Sampled from this item's card art — offered in the UI as a
          // quick "start painting with this colour" pick, nothing more; it
          // is not what's currently on the icon (that's in `grids` below).
          autoColor: getItemColor(item),
          gradient: getItemIconGradient(item.id) ?? null,
          unpainted: !stored[item.id],
          // Has a collector card, so it can take a card illustration.
          isItem: true,
        };
      });
      // The editable pixel data itself — kept out of `items` since it's
      // mutated locally as the user paints, while `items` is read-only
      // per-item metadata.
      const grids = Object.fromEntries(
        Object.entries(stored).map(([id, entry]) => [
          id,
          { grid: entry.grid, palette: entry.palette },
        ]),
      );
      for (const item of ITEMS) grids[item.id] ??= seedFor(item);
      items.push(...EXTRA_ICONS.filter((extra) => stored[extra.id]));
      // Only catalog items have a card, so only they take an illustration.
      adoptLegacyCardArt();
      sendJson(res, 200, {
        items,
        grids,
        // Only hand-edited artwork; the page derives the rest from the icon
        // as it's painted.
        artwork: readArtwork(),
        cardArt: readCardArt(),
      });
      return;
    }

    // The finished card images and the uploaded originals, for the editor.
    for (const [prefix, dir, key] of [
      ["/card-art/", CARD_ART_DIR, "file"],
      ["/card-art-source/", CARD_ART_SOURCE_DIR, "source"],
    ]) {
      if (req.method !== "GET" || !url.pathname.startsWith(prefix)) continue;
      const file = decodeURIComponent(url.pathname.slice(prefix.length));
      // Only files the manifest names — never an arbitrary path.
      const entry = Object.values(readCardArt()).find((e) => e[key] === file);
      if (!entry) {
        sendJson(res, 404, { error: `No such card art file: ${file}` });
        return;
      }
      const ext = file.slice(file.lastIndexOf(".") + 1);
      const mime = IMAGE_SIGNATURES.find((sig) => sig.ext === ext)?.mime;
      res.writeHead(200, {
        "Content-Type": mime ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(readFileSync(resolve(dir, entry[key])));
      return;
    }

    if (url.pathname.startsWith("/api/card-art/")) {
      const [rawId, sub] = url.pathname
        .slice("/api/card-art/".length)
        .split("/");
      const id = decodeURIComponent(rawId);
      if (!ITEMS.some((item) => item.id === id)) {
        sendJson(res, 404, { error: `Unknown item id: ${id}` });
        return;
      }
      const manifest = readCardArt();

      // Both uploads take the raw image as the body.
      const readImage = async () => {
        const body = await readBody(req, MAX_CARD_ART_BYTES);
        if (!body) {
          sendJson(res, 413, {
            error: `Image is over ${MAX_CARD_ART_BYTES / 1024 / 1024} MB`,
          });
          return null;
        }
        const format = IMAGE_SIGNATURES.find((sig) => sig.test(body));
        if (!format) {
          sendJson(res, 400, {
            error: "Not a PNG, JPEG, WebP, GIF or AVIF image",
          });
          return null;
        }
        return { body, ext: format.ext };
      };

      // A new original from the artist. Its crop and filter start over (they
      // were framed for the old picture); the credit and flag carry over.
      // The card keeps showing the previous finished image until the editor
      // renders this one (which it does straight after uploading).
      if (req.method === "PUT" && sub === "source") {
        const image = await readImage();
        if (!image) return;
        const source = `${id}.${image.ext}`;
        const previous = manifest[id];
        mkdirSync(CARD_ART_SOURCE_DIR, { recursive: true });
        writeFileSync(resolve(CARD_ART_SOURCE_DIR, source), image.body);
        if (previous?.source && previous.source !== source)
          removeFile(CARD_ART_SOURCE_DIR, previous.source);
        const { crop, filter, ...rest } = previous ?? {};
        manifest[id] = { ...rest, source };
        writeCardArt(manifest);
        sendJson(res, 200, { ok: true, entry: manifest[id] });
        return;
      }

      // The finished card image, cropped and filtered by the editor, plus
      // the settings that made it (`?settings=<json>`), so it can be
      // re-edited from the original later.
      if (req.method === "PUT" && sub === "render") {
        const previous = manifest[id];
        if (!previous?.source) {
          sendJson(res, 404, { error: "Upload an illustration first" });
          return;
        }
        let settings;
        try {
          settings = parseRenderSettings(
            JSON.parse(url.searchParams.get("settings") ?? ""),
          );
        } catch (err) {
          sendJson(res, 400, { error: `Bad settings: ${err.message}` });
          return;
        }
        const image = await readImage();
        if (!image) return;
        const file = `${id}.${image.ext}`;
        writeFileSync(resolve(CARD_ART_DIR, file), image.body);
        if (previous.file && previous.file !== file)
          removeFile(CARD_ART_DIR, previous.file);
        manifest[id] = { file, source: previous.source, ...settings };
        writeCardArt(manifest);
        sendJson(res, 200, { ok: true, entry: manifest[id] });
        return;
      }

      if (req.method === "DELETE" && !sub) {
        const entry = manifest[id];
        if (entry) {
          if (entry.file) removeFile(CARD_ART_DIR, entry.file);
          if (entry.source) removeFile(CARD_ART_SOURCE_DIR, entry.source);
          delete manifest[id];
          writeCardArt(manifest);
        }
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/icons/")) {
      const id = decodeURIComponent(
        url.pathname.slice("/api/icons/".length),
      );
      const stored = readGrids();
      // A catalog item without an entry yet gets one on its first save.
      const isItem = ITEMS.some((item) => item.id === id);
      if (!(id in stored) && !isItem) {
        sendJson(res, 404, { error: `Unknown icon id: ${id}` });
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      if (!isValidPalette(payload.palette)) {
        sendJson(res, 400, {
          error: "palette must be 1-16 '#rrggbb' hex colours",
        });
        return;
      }
      const size = stored[id]?.grid.length ?? ITEM_ICON_SIZE;
      if (!isValidGrid(payload.grid, payload.palette.length, size)) {
        sendJson(res, 400, {
          error: `grid must be ${size} rows of exactly ${size} '.'/'0'-'9'/'a'-'f' characters, each index within the palette`,
        });
        return;
      }
      stored[id] = { grid: payload.grid, palette: payload.palette };
      writeFileSync(GRIDS_PATH, `${JSON.stringify(stored, null, 2)}\n`);
      await sendAfterRebuild(res, "item-icon-grids.json");
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: String(err?.stack ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`Item editor: http://localhost:${PORT}`);
});
