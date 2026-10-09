// Dev only (not in the build's inputs): the 3D Town with made-up visitors
// and a player, without logging in. `pnpm vite:dev`, then open
// /town-sandbox.html. `?shadows=0` turns the sun's shadows off, and
// `?bench=1` times the renderer (see bench).
import "./globals.css";
import type { RootState } from "@react-three/fiber";
import { createRoot } from "react-dom/client";
import type { EventCard } from "./components/TownScene";
import {
  SPARE_SPOTS,
  SPOTS,
  type TownSpot,
  townSave,
} from "./components/town/runtime";
import TownCanvas from "./components/town/TownCanvas";

const params = new URLSearchParams(location.search);

const card = (type: string, title: string): EventCard => ({
  type,
  title,
  description: null,
  status: "live",
  at: null,
  openKey: null,
  eventId: `sandbox-${type}`,
});

const spots: TownSpot[] = [
  ["merchant", "Good ol' George"],
  ["treat_trader", "Nandor"],
  ["boss_fight", "The boss"],
  ["song_hunt", "Orphiez"],
].map(([type, title]) => ({
  key: type,
  card: card(type, title),
  at: SPOTS[type],
  standing: true,
  status: "in town",
}));
// `?visitors=6` fills the spare spots too: the most the Town shows.
const extra = Math.max(0, Number(params.get("visitors") ?? 4) - spots.length);
SPARE_SPOTS.slice(0, extra).forEach((at, i) => {
  spots.push({
    key: `spare${i}`,
    card: card(`spare${i}`, `Visitor ${i + 1}`),
    at,
    standing: true,
    status: "in town",
  });
});

// Start somewhere else, looking some way: ?x=&z=&heading=&polar= .
for (const k of ["x", "z", "heading", "polar"] as const) {
  if (params.has(k)) townSave[k] = Number(params.get(k));
}
if (params.has("heading")) townSave.azimuth = townSave.heading - Math.PI;
const player = {
  seed: params.get("seed") ?? "sandbox-player",
  stage: Number(params.get("stage") ?? 3),
  equipped: {
    color: params.get("color") ?? "prism",
    head: "headphones",
    spirit: params.get("spirit") ?? "spirit-orb",
  },
};

/**
 * Times the renderer alone, with the frame loop stopped: a frame's worth of
 * gl.render calls, then a 1x1 readPixels so the GPU has to finish them.
 * Under vsync the frame rate only says "fast enough", so this is what
 * shows the headroom. Waits for the world to settle first (herzies, shader
 * compiles), and prints the result on the page and as `[town-bench]`.
 */
async function bench(state: RootState) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(Number(params.get("warmup") ?? 4000));
  const { gl, scene, camera } = state;
  state.setFrameloop("never");
  const ctx = gl.getContext();
  const info = ctx.getExtension("WEBGL_debug_renderer_info");
  const gpu = info
    ? ctx.getParameter(info.UNMASKED_RENDERER_WEBGL)
    : ctx.getParameter(ctx.RENDERER);
  const pixel = new Uint8Array(4);
  const finish = () =>
    ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, pixel);
  for (let i = 0; i < 20; i++) gl.render(scene, camera);
  finish();
  const frames = Number(params.get("frames") ?? 300);
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    for (let i = 0; i < frames / 5; i++) gl.render(scene, camera);
    finish();
    runs.push((performance.now() - t0) / (frames / 5));
    await wait(50);
  }
  runs.sort((a, b) => a - b);
  const result = {
    shadows: gl.shadowMap.enabled,
    gpu,
    size: [ctx.drawingBufferWidth, ctx.drawingBufferHeight],
    msPerFrame: Number(runs[2].toFixed(3)),
    runs: runs.map((r) => Number(r.toFixed(3))),
    calls: gl.info.render.calls,
    triangles: gl.info.render.triangles,
  };
  console.log("[town-bench]", JSON.stringify(result));
  const out = document.createElement("pre");
  out.id = "town-bench";
  out.textContent = JSON.stringify(result, null, 1);
  Object.assign(out.style, {
    position: "fixed",
    top: "8px",
    left: "8px",
    background: "rgba(0,0,0,.7)",
    color: "#fff",
    font: "12px monospace",
    padding: "6px",
    zIndex: "100",
  });
  document.body.append(out);
  state.setFrameloop("always");
}

const root = document.getElementById("root");
if (root) {
  root.style.height = "100vh";
  createRoot(root).render(
    <TownCanvas
      spots={spots}
      player={player}
      paused={false}
      hour={params.has("time") ? Number(params.get("time")) : null}
      shadows={params.get("shadows") !== "0"}
      onCreated={params.has("bench") ? bench : undefined}
      onOpen={(key) => console.log("[town-sandbox] open", key)}
      onNearChange={(s) => console.log("[town-sandbox] near", s?.key ?? null)}
    />,
  );
}
