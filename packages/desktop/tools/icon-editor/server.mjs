#!/usr/bin/env node
// Tiny local editor for the per-item pixel icons in
// ../../src/components/icons/item-icon-grids.json — no build step, just a
// plain Node http server + a static page. Saving writes straight back to
// that JSON file, which the running desktop app (via Vite) picks up like
// any other source change.
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

function isValidGrid(grid) {
  return (
    Array.isArray(grid) &&
    grid.length === 16 &&
    grid.every(
      (row) => typeof row === "string" && /^[.#]{16}$/.test(row),
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
      const grids = readGrids();
      // Only items that already have a bespoke icon are editable here — the
      // generic per-type fallbacks live inline in ItemTypeIcon.tsx, not in
      // this JSON file.
      const items = ITEMS.filter((item) => grids[item.id]).map((item) => {
        const set = getItemSet(item.id);
        return {
          id: item.id,
          name: item.name,
          color: getItemColor(item),
          gradient: set?.visual?.gradient ?? null,
        };
      });
      sendJson(res, 200, { items, grids });
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/icons/")) {
      const id = decodeURIComponent(
        url.pathname.slice("/api/icons/".length),
      );
      const grids = readGrids();
      if (!(id in grids)) {
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
      if (!isValidGrid(payload.grid)) {
        sendJson(res, 400, {
          error: "grid must be 16 rows of exactly 16 '.'/'#' characters",
        });
        return;
      }
      grids[id] = payload.grid;
      writeFileSync(GRIDS_PATH, `${JSON.stringify(grids, null, 2)}\n`);
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
