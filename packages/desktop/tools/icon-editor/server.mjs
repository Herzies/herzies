#!/usr/bin/env node
// Tiny local editor for the per-item pixel icons in
// ../../src/components/icons/item-icon-grids.json — no build step, just a
// plain Node http server + a static page. Saving writes straight back to
// that JSON file, which the running desktop app (via Vite) picks up like
// any other source change. Each entry is `{ palette, grid }`: `grid` is
// 16 rows of '.' (empty) / '0'-'9'/'a'-'f' (an index into `palette`) — a
// per-pixel paint job, not one solid tint (see ItemTypeIcon.tsx).
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getItemColor, getItemSet, ITEMS } from "@herzies/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRIDS_PATH = resolve(
  __dirname,
  "../../src/components/icons/item-icon-grids.json",
);
const HTML_PATH = resolve(__dirname, "index.html");
const PORT = process.env.ICON_EDITOR_PORT ?? 4560;

function readGrids() {
  return JSON.parse(readFileSync(GRIDS_PATH, "utf8"));
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

function isValidGrid(grid, paletteLength) {
  return (
    Array.isArray(grid) &&
    grid.length === 16 &&
    grid.every(
      (row) =>
        typeof row === "string" &&
        /^[.0-9a-f]{16}$/i.test(row) &&
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
      // Only items that already have a bespoke icon are editable here — the
      // generic per-type fallbacks live inline in ItemTypeIcon.tsx, not in
      // this JSON file.
      const items = ITEMS.filter((item) => stored[item.id]).map((item) => {
        const set = getItemSet(item.id);
        return {
          id: item.id,
          name: item.name,
          // Sampled from this item's card art — offered in the UI as a
          // quick "start painting with this colour" pick, nothing more; it
          // is not what's currently on the icon (that's in `grids` below).
          autoColor: getItemColor(item),
          gradient: set?.visual?.gradient ?? null,
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
      sendJson(res, 200, { items, grids });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/icons/")) {
      const id = decodeURIComponent(
        url.pathname.slice("/api/icons/".length),
      );
      const stored = readGrids();
      if (!(id in stored)) {
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
      if (!isValidGrid(payload.grid, payload.palette.length)) {
        sendJson(res, 400, {
          error:
            "grid must be 16 rows of exactly 16 '.'/'0'-'9'/'a'-'f' characters, each index within the palette",
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
