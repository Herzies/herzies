import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { parseMap, serializeMap } from "./src/components/town/map";

const TOWN_MAP = resolve(__dirname, "src/components/town/maps/home.json");

/**
 * Dev only: lets the map editor (/map-editor.html) save the home island.
 * `PUT /__town-map` with the map's JSON checks it and writes it to
 * maps/home.json, one row per line.
 */
function townMapEditor(): Plugin {
  return {
    name: "town-map-editor",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__town-map", (req, res) => {
        if (req.method !== "PUT") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            writeFileSync(TOWN_MAP, serializeMap(parseMap(JSON.parse(body))));
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
      if (file === TOWN_MAP) return [];
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
