/** Mounts the website's live Town (see index.ts). */
import { createRoot } from "react-dom/client";
import type { Champion } from "../components/town/champion";
import { townSave } from "../components/town/runtime";
import { Showcase } from "./Showcase";
import { WatchConnection } from "./WatchConnection";

export type ShowcaseOptions = {
  /** The Town server, e.g. wss://herzies-town.novasism.workers.dev (unset:
   * the island without anyone on it). */
  server?: string;
  /** Who the statue shows (unset: a made-up herzie, not the app's
   * stand-in champion, whose body is a real friend code's). */
  champion?: Champion;
  /** Called once the first frame is on screen. */
  onReady?: () => void;
};

const NOBODY: Champion = { look: { seed: "W-showcase", stage: 3 }, name: "" };

export function mountTownShowcase(
  el: HTMLElement,
  opts: ShowcaseOptions = {},
): () => void {
  const net = opts.server
    ? new WatchConnection(
        `${opts.server.replace(/\/$/, "")}/v1/town/home?shard=0&watch=1`,
      )
    : null;
  // Nobody is standing anywhere: name plaques (which fade in as you come
  // near, and aren't styled here) stay out of sight.
  townSave.x = townSave.z = 1e4;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lite = matchMedia("(pointer: coarse)").matches || innerWidth < 768;
  const root = createRoot(el);
  root.render(
    <Showcase
      net={net}
      champion={opts.champion ?? NOBODY}
      still={still}
      lite={lite}
      onReady={opts.onReady}
    />,
  );
  return () => {
    root.unmount();
    net?.close();
  };
}
