// Dev only (not in the build's inputs): the 3D Town with made-up visitors
// and a player, without logging in. `pnpm vite:dev`, then open
// /town-sandbox.html. `?shadows=0` turns the sun's shadows off, `?ao=0`
// the ambient occlusion, and `?bench=1` times the renderer (`?bench=frame`
// whole frames, composer included; see bench).
// `?time=` sets the hour, and `&speed=` runs the clock on from there,
// that many hours a second (to watch the light and shadows move).
// `?net=local` joins the multiplayer Town on `wrangler dev` (in
// packages/town-server, with TOWN_TICKET_SECRET=dev-town-secret in .dev.vars);
// `&name=` and `&server=ws://…` to taste. Open it twice to see each other.
import "./globals.css";
import { signTownTicket } from "@herzies/shared";
import type { RootState } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EventCard } from "./components/TownScene";
import {
  bubbleDuration,
  type ChatBubbles,
} from "./components/town/chatBubbles";
import { setTownTicketSource, townNet } from "./components/town/net/townNet";
import {
  SPARE_SPOTS,
  SPOTS,
  type TownSpot,
  townSave,
} from "./components/town/runtime";
import TownCanvas from "./components/town/TownCanvas";

const params = new URLSearchParams(location.search);

const startHour = params.has("time") ? Number(params.get("time")) : null;
const speed = Number(params.get("speed") ?? 0);
const startedAt = performance.now();
const sandboxHour =
  startHour !== null && speed > 0
    ? () => (startHour + ((performance.now() - startedAt) / 1000) * speed) % 24
    : startHour;

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
  // `?bench=frame`: whole frames (every useFrame, and the ambient
  // occlusion composer, which draws instead of gl.render).
  const whole = params.get("bench") === "frame";
  const render = whole
    ? () => state.advance(performance.now())
    : () => gl.render(scene, camera);
  for (let i = 0; i < 20; i++) render();
  finish();
  const frames = Number(params.get("frames") ?? 300);
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    for (let i = 0; i < frames / 5; i++) render();
    finish();
    runs.push((performance.now() - t0) / (frames / 5));
    await wait(50);
  }
  runs.sort((a, b) => a - b);
  const result = {
    shadows: gl.shadowMap.enabled,
    whole,
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

function localNet() {
  const uid = `sandbox-${Math.random().toString(36).slice(2, 8)}`;
  const name = params.get("name") ?? uid;
  setTownTicketSource(async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const look = {
      seed: player.seed,
      stage: player.stage,
      equipped: player.equipped,
    };
    return {
      ticket: await signTownTicket({ uid, name, look, exp }, "dev-town-secret"),
      url: params.get("server") ?? "ws://localhost:8787",
      exp,
    };
  });
  const net = townNet();
  net.start();
  net.subscribe(() =>
    console.log("[town-sandbox] net", net.status, net.remotes.size),
  );
  return net;
}
const net = params.get("net") === "local" ? localNet() : null;
// For poking at from the console and browser tests.
Object.assign(window, { townNet: net });

/**
 * The sandbox's Town, with chat bubbles driven from the console:
 * `say("bot-seed-3", "hello")` (a friend code, or a bot's seed; the player's
 * own seed for yours).
 */
function Sandbox() {
  const [bubbles, setBubbles] = useState<ChatBubbles>(new Map());
  useEffect(() => {
    let n = 0;
    Object.assign(window, {
      say: (code: string, text: string) => {
        const key = `say-${n++}`;
        setBubbles((b) => new Map(b).set(code, { key, text }));
        setTimeout(
          () =>
            setBubbles((b) => {
              if (b.get(code)?.key !== key) return b;
              const next = new Map(b);
              next.delete(code);
              return next;
            }),
          bubbleDuration(text),
        );
      },
    });
  }, []);
  return (
    <TownCanvas
      spots={spots}
      player={player}
      net={net}
      bubbles={bubbles}
      paused={false}
      hour={sandboxHour}
      shadows={params.get("shadows") !== "0"}
      ao={params.get("ao") !== "0"}
      onCreated={params.has("bench") ? bench : undefined}
      onOpen={(key) => console.log("[town-sandbox] open", key)}
      onNearChange={(s) => console.log("[town-sandbox] near", s?.key ?? null)}
    />
  );
}

const root = document.getElementById("root");
if (root) {
  root.style.height = "100vh";
  createRoot(root).render(<Sandbox />);
}
