import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The website's live Town (src/showcase), built into the web package's
 * public folder: /town/showcase.js, a small entry with a fixed name, loads
 * the Town from a hashed chunk (cached for good; see the web's
 * next.config). No physics: see rapier-stub.tsx.
 */
export default defineConfig({
  plugins: [react()],
  root: "src",
  base: "/town/",
  publicDir: false,
  resolve: {
    alias: {
      "@react-three/rapier": resolve(__dirname, "src/showcase/rapier-stub.tsx"),
    },
  },
  build: {
    outDir: resolve(__dirname, "../web/public/town"),
    emptyOutDir: true,
    rollupOptions: {
      input: { showcase: resolve(__dirname, "src/showcase/index.ts") },
      preserveEntrySignatures: "exports-only",
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "[name]-[hash][extname]",
      },
    },
  },
});
