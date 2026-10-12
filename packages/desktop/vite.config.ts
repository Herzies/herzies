import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { MAP_ID, parseMap, serializeMap } from "./src/components/town/map";

const TOWN_MAPS = resolve(__dirname, "src/components/town/maps");

/**
 * Dev only: lets the map editor (/map-editor.html) save an island.
 * `PUT /__town-map/<id>` with the map's JSON checks it and writes it to
 * maps/<id>.json, one row per line.
 */
function townMapEditor(): Plugin {
  return {
    name: "town-map-editor",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__town-map", (req, res) => {
        // Mounted at /__town-map, so the url is what's after it: /<id>.
        const id = (req.url ?? "").replace(/^\//, "").split("?")[0];
        if (req.method !== "PUT" || !MAP_ID.test(id)) {
          res.statusCode = req.method !== "PUT" ? 405 : 400;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const map = parseMap(JSON.parse(body));
            if (map.id !== id) throw new Error(`id "${map.id}" is not "${id}"`);
            writeFileSync(resolve(TOWN_MAPS, `${id}.json`), serializeMap(map));
            res.statusCode = 204;
            res.end();
          } catch (e) {
            res.statusCode = 400;
            res.end(e instanceof Error ? e.message : String(e));
          }
        });
      });
    },
    // The editor holds the map it's painting (and its undo history): don't
    // reload it under the editor when it saves. An open town sandbox needs a
    // refresh to pick the new map up.
    handleHotUpdate({ file }) {
      if (file.startsWith(TOWN_MAPS) && file.endsWith(".json")) return [];
    },
  };
}

export default defineConfig({
  plugins: [react(), townMapEditor()],
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
        sandbox: resolve(__dirname, "src/sandbox.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
