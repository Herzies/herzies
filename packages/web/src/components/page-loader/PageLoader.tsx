"use client";

import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import {
  bootDone,
  finishNavigation,
  getServerState,
  getState,
  reset,
  startNavigation,
  subscribe,
} from "./store";
import { afterPaint } from "./useLoaderHold";

/** The most the first page waits on its fonts before showing. */
const FONT_WAIT_MS = 1500;

/**
 * The loader's look, inline in the page so it applies the moment the
 * overlay is parsed, never waiting on a stylesheet. Opacity is all that
 * moves. Gone, it is display:none, so iOS Safari never reads it for its
 * bar colours.
 */
const CSS = `
[data-page-loader] {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  color: var(--color-bg, #0c0c14);
  font-family: var(--font-mono, "JetBrains Mono", ui-monospace, monospace);
  font-size: 14px;
  line-height: 1.6;
  opacity: 1;
  /* Out: slow and soft, the page eases in underneath. */
  transition: opacity 400ms cubic-bezier(0.4, 0, 0.2, 1);
}
/* The server's overlay, until the first page is ready. Should the script
   never run, it lets go on its own (and at once without JavaScript: the
   layout's noscript). */
[data-page-loader][data-state="boot"] {
  animation: page-loader-failsafe 400ms ease 10s forwards;
}
[data-page-loader][data-state="pending"],
[data-page-loader][data-state="leaving"] {
  opacity: 0;
  pointer-events: none;
}
/* In: fast, so the click answers at once. */
[data-page-loader][data-state="shown"] {
  transition: opacity 120ms cubic-bezier(0, 0, 0.2, 1);
}
/* Fading in from display:none needs a starting point. */
@starting-style {
  [data-page-loader][data-state="shown"] {
    opacity: 0;
  }
}
[data-page-loader][data-state="hidden"] {
  display: none;
}
.page-loader-text {
  letter-spacing: 0.02em;
  /* Nudged right by half the dots, so "loading" itself sits centred. */
  transform: translateX(0.9ch);
}
/* Each dot fades in after the one before, then they fade out together.
   Fixed width: the text never shifts as they come and go. */
.page-loader-dots {
  display: inline-block;
  width: 1.8ch;
  text-align: left;
}
.page-loader-dot {
  opacity: 0;
  animation: page-loader-dot 1.4s ease-in-out infinite;
}
.page-loader-dot:nth-child(2) {
  animation-delay: 0.2s;
}
.page-loader-dot:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes page-loader-dot {
  0%, 10% { opacity: 0; }
  30%, 70% { opacity: 1; }
  90%, 100% { opacity: 0; }
}
@keyframes page-loader-failsafe {
  to { opacity: 0; visibility: hidden; pointer-events: none; }
}
@media (prefers-reduced-motion: reduce) {
  .page-loader-dot {
    animation: none;
    opacity: 1;
  }
  [data-page-loader],
  [data-page-loader][data-state="shown"] {
    transition-duration: 150ms;
  }
}
`;

/**
 * The white "loading..." screen. The server renders it showing, so it is
 * the first thing painted on a fresh load, and it stays until the page has
 * hydrated, has its fonts, and anything holding it (useLoaderHold) is
 * ready. Navigations bring it back the moment a link is clicked (see
 * store.ts). The dots are CSS, so they move before any script runs.
 */
export function PageLoader() {
  const state = useSyncExternalStore(subscribe, getState, getServerState);
  const pathname = usePathname();

  // The first page: hydrated (this effect runs), then fonts, then a paint.
  useEffect(() => {
    let cancelPaint = () => {};
    let cancelled = false;
    const timeout = new Promise((r) => setTimeout(r, FONT_WAIT_MS));
    Promise.race([document.fonts?.ready, timeout]).then(() => {
      if (!cancelled) cancelPaint = afterPaint(bootDone);
    });
    return () => {
      cancelled = true;
      cancelPaint();
    };
  }, []);

  // A route has landed: let the overlay go once it's painted.
  useEffect(() => afterPaint(() => finishNavigation(pathname)), [pathname]);

  useEffect(() => {
    // Back/forward: the address has already changed by now.
    const onPopState = () => startNavigation(window.location.href);
    // Back to a page kept whole in the bfcache, overlay and all.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) reset();
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return (
    <>
      <style>{CSS}</style>
      <div
        data-page-loader=""
        data-state={state}
        role="status"
        aria-live="polite"
        aria-hidden={state === "hidden" || state === "pending"}
      >
        <p className="page-loader-text">
          loading
          <span aria-hidden="true" className="page-loader-dots">
            <span className="page-loader-dot">.</span>
            <span className="page-loader-dot">.</span>
            <span className="page-loader-dot">.</span>
          </span>
        </p>
      </div>
    </>
  );
}
