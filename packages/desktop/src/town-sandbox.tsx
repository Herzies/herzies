// Dev only (not in the build's inputs): the 3D Town with made-up visitors
// and a player, without logging in. `pnpm vite:dev`, then open
// /town-sandbox.html.
import "./globals.css";
import { createRoot } from "react-dom/client";
import type { EventCard } from "./components/TownScene";
import { SPOTS, type TownSpot } from "./components/town/runtime";
import TownCanvas from "./components/town/TownCanvas";

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

const params = new URLSearchParams(location.search);
const player = {
  seed: params.get("seed") ?? "sandbox-player",
  stage: Number(params.get("stage") ?? 3),
  equipped: {
    color: params.get("color") ?? "prism",
    head: "headphones",
    spirit: params.get("spirit") ?? "spirit-orb",
  },
};

const root = document.getElementById("root");
if (root) {
  root.style.height = "100vh";
  createRoot(root).render(
    <TownCanvas
      spots={spots}
      player={player}
      paused={false}
      hour={params.has("time") ? Number(params.get("time")) : null}
      onOpen={(key) => console.log("[town-sandbox] open", key)}
      onNearChange={(s) => console.log("[town-sandbox] near", s?.key ?? null)}
    />,
  );
}
