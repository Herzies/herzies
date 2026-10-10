import { isTauri } from "@tauri-apps/api/core";

/**
 * Mouse-look for aiming: the cursor hidden and held still while the mouse
 * turns the view, as in any shooter. Browsers do that with the Pointer Lock
 * API — but macOS's WKWebView (the desktop app on a Mac) doesn't have it.
 * So, best first:
 *
 * - "locked": Pointer Lock (Windows' WebView2, a browser).
 * - "grabbed": the app holds the cursor itself (Tauri's cursor grab, which
 *   on macOS freezes it in place), hidden, while mouse moves still report
 *   how far they went.
 * - "free": neither: the cursor is hidden over the Town and its moves turn
 *   the view until it leaves the window.
 *
 * Whichever it is, `onDelta` gets each move's (dx, dy) in pixels.
 */
export type LookMode = "locked" | "grabbed" | "free";

type Handle = {
  mode: LookMode;
  exit: () => void;
};

let current: Handle | null = null;

/** Hold the mouse for aiming over `el`. Resolves to how it's held; `onLost`
 * fires if it's let go other than by exitMouseLook (Esc under Pointer Lock,
 * which the page never sees). */
export async function enterMouseLook(
  el: HTMLElement,
  onDelta: (dx: number, dy: number) => void,
  onLost: () => void,
): Promise<LookMode> {
  exitMouseLook();
  const onMove = (e: MouseEvent) => {
    if (e.movementX || e.movementY) onDelta(e.movementX, e.movementY);
  };
  const mode = await hold(el);
  let done = false;
  const onLockChange = () => {
    if (document.pointerLockElement !== el && !done) {
      done = true;
      cleanup();
      onLost();
    }
  };
  const cleanup = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("pointerlockchange", onLockChange);
    el.style.cursor = "";
  };
  document.addEventListener("mousemove", onMove);
  if (mode === "locked") {
    document.addEventListener("pointerlockchange", onLockChange);
  } else {
    el.style.cursor = "none";
  }
  current = {
    mode,
    exit: () => {
      if (done) return;
      done = true;
      cleanup();
      release(el, mode);
    },
  };
  return mode;
}

/** Let the mouse go again. */
export function exitMouseLook(): void {
  const h = current;
  current = null;
  h?.exit();
}

async function hold(el: HTMLElement): Promise<LookMode> {
  if (await pointerLock(el)) return "locked";
  if (isTauri() && (await grab(true))) return "grabbed";
  return "free";
}

/** Pointer Lock, if this webview has it and grants it. */
function pointerLock(el: HTMLElement): Promise<boolean> {
  if (typeof el.requestPointerLock !== "function") {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("pointerlockchange", onChange);
      document.removeEventListener("pointerlockerror", onError);
      clearTimeout(timer);
      resolve(ok);
    };
    const onChange = () => finish(document.pointerLockElement === el);
    const onError = () => finish(false);
    document.addEventListener("pointerlockchange", onChange);
    document.addEventListener("pointerlockerror", onError);
    // A webview that has the method but never answers (WKWebView).
    const timer = setTimeout(() => finish(false), 400);
    try {
      // Raw mouse moves, without the OS's acceleration, where offered.
      const asked = (
        el.requestPointerLock as (o?: object) => Promise<void> | undefined
      ).call(el, { unadjustedMovement: true });
      asked?.catch?.(() =>
        // Not offered: ask again without it.
        Promise.resolve(el.requestPointerLock()).catch(() => finish(false)),
      );
    } catch {
      finish(false);
    }
  });
}

/** The app's own hold on the cursor (Tauri), hidden. */
async function grab(on: boolean): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.setCursorGrab(on);
    await w.setCursorVisible(!on);
    return true;
  } catch {
    return false;
  }
}

function release(el: HTMLElement, mode: LookMode) {
  if (mode === "locked" && document.pointerLockElement === el) {
    document.exitPointerLock();
  } else if (mode === "grabbed") {
    void grab(false);
  }
}
