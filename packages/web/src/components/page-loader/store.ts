/**
 * The page loader's state, shared by the overlay (PageLoader), the links
 * that start a navigation (Link), and pages that keep it up until their
 * content is ready (useLoaderHold).
 *
 *   boot     the server HTML's overlay, up until the first page is ready
 *   pending  a navigation to a quick page started; nothing drawn yet
 *   shown    overlay visible
 *   leaving  fading out
 *   hidden   gone (display: none)
 *
 * Most pages bring the overlay up the instant they're clicked and keep it
 * up until they've landed, painted, and let go of any holds (the front
 * page's Town, the leaderboard's rows). Quick pages are the exception.
 */

export type LoaderState = "boot" | "hidden" | "pending" | "shown" | "leaving";

/**
 * Static pages with nothing to load: prefetched, they land within a frame,
 * so they open with no overlay at all (it shows only if one runs slow,
 * past GRACE_MS). In development nothing is prefetched and every page
 * compiles on first visit, so there every page gets the overlay at once.
 */
const QUICK_ROUTES = new Set(["/terms", "/download", "/login"]);

/** How long a quick page may take before the overlay shows. */
const GRACE_MS = 100;
/** Once shown, the least time it stays up: it reads, never blinks. */
const MIN_SHOWN_MS = 500;
/** The fade-out (PageLoader's leave transition, plus a margin). */
const LEAVE_MS = 450;
/** A navigation that never lands (aborted, failed) lets go after this. */
const WATCHDOG_MS = 10_000;
/** The longest a page may hold the overlay up. */
const MAX_HOLD_MS = 8_000;

let state: LoaderState = "boot";
/** The pathname on screen now (null until the first page reports in). */
let current: string | null = null;
let shownAt = 0;
/** A navigation has started and its page hasn't landed yet. */
let landing = false;
/** The first page has hydrated and has its fonts. */
let booted = false;
/** Pages still getting ready (useLoaderHold). */
let holds = 0;

let graceTimer: ReturnType<typeof setTimeout> | undefined;
let minTimer: ReturnType<typeof setTimeout> | undefined;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;

const listeners = new Set<() => void>();

function set(next: LoaderState) {
  if (state === next) return;
  state = next;
  for (const l of listeners) l();
}

function clearTimers() {
  clearTimeout(graceTimer);
  clearTimeout(minTimer);
  clearTimeout(leaveTimer);
  clearTimeout(watchdog);
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getState = () => state;
export const getServerState = (): LoaderState => "boot";

/** Whether the overlay is covering the page right now. */
export const isCovering = () => state === "boot" || state === "shown";

function show() {
  shownAt = performance.now();
  set("shown");
}

function leave() {
  clearTimers();
  landing = false;
  set("leaving");
  leaveTimer = setTimeout(() => set("hidden"), LEAVE_MS);
}

/** Take the overlay down once nothing is keeping it up any more. */
function settle() {
  if (landing || holds > 0) return;
  if (state === "boot") {
    if (booted) leave();
  } else if (state === "shown") {
    clearTimeout(minTimer);
    const left = MIN_SHOWN_MS - (performance.now() - shownAt);
    if (left > 0) minTimer = setTimeout(settle, left);
    else leave();
  }
}

/** Drop the overlay at once (a page restored from the back/forward cache). */
export function reset() {
  clearTimers();
  landing = false;
  set("hidden");
}

/**
 * A navigation to `href` has begun. Same-page targets (the current path, a
 * hash on it) and other origins are ignored: no route change follows them,
 * so nothing would ever take the overlay down.
 */
export function startNavigation(href: string) {
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return;
  }
  if (url.origin !== window.location.origin) return;
  if (url.pathname === (current ?? window.location.pathname)) return;

  clearTimers();
  landing = true;
  const quick =
    process.env.NODE_ENV === "production" && QUICK_ROUTES.has(url.pathname);
  if (state === "boot") {
    // Still covering the first page: stays up.
  } else if (!quick) {
    // Up straight away, on the click itself. Already up: the minimum
    // starts over, so it never cuts away the moment the next page lands.
    show();
  } else if (state !== "shown") {
    // Hidden, or fading out: "pending" looks just like "leaving", so a
    // fade under way carries on while the grace period runs.
    set("pending");
    graceTimer = setTimeout(show, GRACE_MS);
  }
  watchdog = setTimeout(leave, WATCHDOG_MS);
}

/** The route on screen is now `pathname`, painted. */
export function finishNavigation(pathname: string) {
  const first = current === null;
  current = pathname;
  if (first) return; // the first page: bootDone() takes the overlay down
  landing = false;
  if (state === "pending") {
    // Never drawn, or still finishing a fade-out: let that run its course.
    leave();
  } else {
    settle();
  }
}

/** The first page has hydrated and has its fonts. */
export function bootDone() {
  booted = true;
  settle();
}

/**
 * Keep the overlay up while something on the page gets ready. Returns the
 * release; it lets go by itself after MAX_HOLD_MS, so a page that never
 * gets there still shows. A hold only keeps up an overlay that is already
 * covering: it never brings it back over a page that's been seen.
 */
export function hold(): () => void {
  holds++;
  let released = false;
  const timer = setTimeout(release, MAX_HOLD_MS);
  function release() {
    if (released) return;
    released = true;
    clearTimeout(timer);
    holds--;
    settle();
  }
  return release;
}
