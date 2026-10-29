"use client";

import { useEffect, useRef, useState } from "react";
import type { ShowcaseChampion } from "@/lib/town-champion";

/** Built by `pnpm showcase` (the desktop app's Town, see
 * packages/desktop/src/showcase). */
const SHOWCASE_URL = "/town/showcase.js";
/** The loading screen gives up waiting for the Town after this long. */
const LOADING_MAX_MS = 12_000;

type ShowcaseModule = {
  mountTownShowcase: (
    el: HTMLElement,
    opts: {
      server?: string;
      champion?: ShowcaseChampion;
      onReady?: () => void;
    },
  ) => Promise<() => void>;
};

/**
 * The live Town behind the front page: the home island, the camera
 * circling its statue, and whoever is in Town right now walking about. A
 * still of it shows first (and stays, without WebGL or the build); the
 * Town fades in over it once it has drawn.
 */
export function TownBackdrop({
  server,
  champion,
}: {
  /** The Town server to watch (wss://…). */
  server: string;
  champion: ShowcaseChampion | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  /** The loading screen is done: the Town has drawn, or won't (no WebGL,
   * failed to load, or too slow). */
  const [settled, setSettled] = useState(false);
  /** It has faded out: gone from the page. */
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (ready) setSettled(true);
  }, [ready]);
  useEffect(() => {
    // However the Town fares, the page shows within this long.
    const t = window.setTimeout(() => setSettled(true), LOADING_MAX_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el || !hasWebGL2()) {
      setSettled(true);
      return;
    }
    let unmount: (() => void) | null = null;
    let cancelled = false;
    // After the page has settled: the Town is the biggest thing on it.
    const start = () => {
      import(/* webpackIgnore: true */ SHOWCASE_URL)
        .then((m: ShowcaseModule) =>
          m.mountTownShowcase(el, {
            server,
            champion: champion ?? undefined,
            onReady: () => !cancelled && setReady(true),
          }),
        )
        .then((u) => {
          if (cancelled) u();
          else unmount = u;
        })
        .catch(() => {
          // Not built (local dev) or failed to load: the still stays.
          setSettled(true);
        });
    };
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(start, { timeout: 300 })
      : window.setTimeout(start, 200);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      unmount?.();
    };
  }, [server, champion]);

  // iOS Safari tints its bars from fixed elements at the screen's edges
  // (it ignores theme-color): the backdrop itself has no colour of its own
  // for it to read (its sky is a child's), and a black strip at the bottom
  // edge is what it reads there. The top takes the page's sky background.
  return (
    <>
      <div
        aria-hidden="true"
        className="town-backdrop fixed inset-x-0 top-0 -z-10"
      >
        <div className="absolute inset-0 bg-sky" />
        <div
          className="absolute inset-0 bg-cover bg-center [image-rendering:pixelated]"
          style={{ backgroundImage: "url(/town-poster.webp)" }}
        />
        <div
          ref={host}
          className={`absolute inset-0 transition-opacity duration-1000 ${ready ? "opacity-100" : "opacity-0"}`}
        />
        {/* The world fades into sky blue at the top and black at the
            bottom, the colours Safari paints behind its bars here. */}
        <div className="town-fade-top absolute inset-x-0 top-0" />
        <div className="town-fade-bottom absolute inset-x-0 bottom-0" />
      </div>
      <div aria-hidden="true" className="town-ground-edge" />
      {!gone && (
        <div
          role="status"
          aria-label="Loading the Town"
          className={`town-loading ${settled ? "town-loading-done" : ""}`}
          onTransitionEnd={() => settled && setGone(true)}
        >
          <div className="town-loading-sky" />
          <div className="relative flex flex-col items-center gap-4">
            <span className="text-2xl font-bold text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.45)]">
              herzies
            </span>
            <span className="town-loading-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      )}
      {/* Without scripts nothing would ever lift it. */}
      <noscript>
        <style>{".town-loading{display:none}"}</style>
      </noscript>
    </>
  );
}

function hasWebGL2(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}
