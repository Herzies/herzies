"use client";

import { useEffect, useRef, useState } from "react";
import { hold, isCovering } from "@/components/page-loader/store";
import { afterPaint } from "@/components/page-loader/useLoaderHold";
import type { ShowcaseChampion } from "@/lib/town-champion";

/** Built by `pnpm showcase` (the desktop app's Town, see
 * packages/desktop/src/showcase). */
const SHOWCASE_URL = "/town/showcase.js";

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
  // Drawn while the page loader still covered the page: no fade of its
  // own, it's simply there when the loader lifts.
  const [instant, setInstant] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el || !hasWebGL2()) return;
    let unmount: (() => void) | null = null;
    let cancelled = false;
    // The page loader stays up until the Town has drawn (or gives up
    // waiting, and the still shows meanwhile).
    const release = hold();
    let cancelPaint = () => {};
    import(/* webpackIgnore: true */ SHOWCASE_URL)
      .then((m: ShowcaseModule) =>
        m.mountTownShowcase(el, {
          server,
          champion: champion ?? undefined,
          onReady: () => {
            if (cancelled) return;
            setInstant(isCovering());
            setReady(true);
            cancelPaint = afterPaint(release);
          },
        }),
      )
      .then((u) => {
        if (cancelled) u();
        else unmount = u;
      })
      .catch(() => {
        // Not built (local dev) or failed to load: the still stays.
        release();
      });
    return () => {
      cancelled = true;
      cancelPaint();
      release();
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
          className={`absolute inset-0 ${instant ? "" : "transition-opacity duration-1000"} ${ready ? "opacity-100" : "opacity-0"}`}
        />
        {/* The world fades into sky blue at the top and black at the
            bottom, the colours Safari paints behind its bars here. */}
        <div className="town-fade-top absolute inset-x-0 top-0" />
        <div className="town-fade-bottom absolute inset-x-0 bottom-0" />
      </div>
      <div aria-hidden="true" className="town-ground-edge" />
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
