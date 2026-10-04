#!/usr/bin/env node
// Tiny local editor for the per-item pixel icons in
// ../../src/components/icons/item-icon-grids.json — no build step, just a
// plain Node http server + a static page. Saving writes straight back to
// that JSON file, which the running desktop app (via Vite) picks up like
// any other source change. Each entry is `{ palette, grid }`: `grid` is
// N rows of N '.' (empty) / '0'-'9'/'a'-'f' (an index into `palette`) — a
// per-pixel paint job, not one solid tint (see ItemTypeIcon.tsx). N is 24,
// for items and Town's visitor portraits (see VisitorIcon.tsx) alike.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BANK_EXPANSION,
  getItemColor,
  getItemIconGradient,
  getItemType,
  ITEMS,
} from "@herzies/shared";
import { TYPE_ICON_GRIDS } from "../../src/components/icons/type-icon-grids.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRIDS_PATH = resolve(
  __dirname,
  "../../src/components/icons/item-icon-grids.json",
);
const HTML_PATH = resolve(__dirname, "index.html");
const PORT = process.env.ICON_EDITOR_PORT ?? 4560;

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

// `size` is the stored icon's side length: an edit can repaint an icon but
// never resize it.
function isValidGrid(grid, paletteLength, size) {
  return (
    Array.isArray(grid) &&
    grid.length === size &&
    grid.every(
      (row) =>
        typeof row === "string" &&
        row.length === size &&
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

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(HTML_PATH, "utf8"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/icons") {
      const stored = readGrids();
      // Every catalog item, painted or not (see seedFor), plus the
      // EXTRA_ICONS above.
      const items = ITEMS.map((item) => {
        return {
          id: item.id,
          name: item.name,
          // Sampled from this item's card art — offered in the UI as a
          // quick "start painting with this colour" pick, nothing more; it
          // is not what's currently on the icon (that's in `grids` below).
          autoColor: getItemColor(item),
          gradient: getItemIconGradient(item.id) ?? null,
          unpainted: !stored[item.id],
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
      sendJson(res, 200, { items, grids });
      return;
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
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: String(err?.stack ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`Icon editor: http://localhost:${PORT}`);
});
