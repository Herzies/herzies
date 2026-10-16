import { useSyncExternalStore } from "react";

/**
 * Notices: short messages that matter now but need nothing from the player —
 * "Already at full health", "Only a Bard can wear this". Classic RPG error
 * text: a line over the middle of the screen, about a third of the way down,
 * that holds just long enough to read and then floats up and fades. Nothing
 * to click away; anything still worth keeping goes to the activity log as
 * well (callers do that).
 *
 * The rules, after how MMO error frames behave:
 * - a few lines at most: a new one pushes the older ones up, and the oldest
 *   past {@link MAX_NOTICES} goes at once;
 * - the same text again while it's up doesn't stack, it restarts that line
 *   (with a little pulse), so mashing a refused key reads as one message;
 * - how long a line holds follows its length (reading time), within bounds,
 *   and the fade is separate from the hold.
 *
 * `notify` works from anywhere (no React needed); `<Notices />`, mounted once
 * at the root, draws them.
 */

export type NoticeKind = "error" | "info" | "success";

export type Notice = {
  id: number;
  text: string;
  kind: NoticeKind;
  /** How long it holds fully visible, ms, before floating off. */
  holdMs: number;
  /** Bumped when the same text comes again: the line restarts. */
  bump: number;
};

/** Most lines on screen at once. */
export const MAX_NOTICES = 3;
/** The float-up-and-fade at the end, ms. */
export const NOTICE_FADE_MS = 650;
/** Hold: a base plus reading time per character, within these bounds. */
const HOLD_BASE_MS = 900;
const HOLD_PER_CHAR_MS = 40;
const HOLD_MIN_MS = 1_400;
const HOLD_MAX_MS = 3_500;

/** How long `text` holds before it fades. */
export function holdFor(text: string): number {
  return Math.min(
    HOLD_MAX_MS,
    Math.max(HOLD_MIN_MS, HOLD_BASE_MS + text.length * HOLD_PER_CHAR_MS),
  );
}

let notices: Notice[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function expire(id: number, after: number) {
  const old = timers.get(id);
  if (old) clearTimeout(old);
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      notices = notices.filter((n) => n.id !== id);
      emit();
    }, after),
  );
}

/** Say `text` to the player for a moment. Always white; `kind` (an error,
 * news, or something that went well) only says what it is, for callers and
 * for later. */
export function notify(
  text: string,
  opts: { kind?: NoticeKind; holdMs?: number } = {},
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const kind = opts.kind ?? "error";
  const holdMs = opts.holdMs ?? holdFor(trimmed);
  const same = notices.find((n) => n.text === trimmed && n.kind === kind);
  if (same) {
    // Again: the same line starts over (newest, so to the bottom).
    const again = { ...same, holdMs, bump: same.bump + 1 };
    notices = [...notices.filter((n) => n.id !== same.id), again];
    expire(same.id, holdMs + NOTICE_FADE_MS);
  } else {
    const n: Notice = { id: nextId++, text: trimmed, kind, holdMs, bump: 0 };
    notices = [...notices, n];
    expire(n.id, holdMs + NOTICE_FADE_MS);
    // Too many: the oldest goes now.
    while (notices.length > MAX_NOTICES) {
      const [oldest] = notices;
      const t = timers.get(oldest.id);
      if (t) clearTimeout(t);
      timers.delete(oldest.id);
      notices = notices.slice(1);
    }
  }
  emit();
}

/** Everything showing, oldest first. */
export function useNotices(): readonly Notice[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => notices,
  );
}

/** Tests: start clean. */
export function clearNotices(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  notices = [];
  emit();
}
