import { useEffect, useSyncExternalStore } from "react";
import { herzies, type QuestBoard, useWindowFocused } from "../tauri-bridge";

// One quest board for the whole app: the Quests window and every quest giver
// in Town read the same copy, so accepting from Pip shows up in the window at
// once and a quest finishing in sync lights Pip's "!" without a refetch each.

let board: QuestBoard | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Puts a board the server already answered with (accept, claim). */
export function setQuestBoard(next: QuestBoard | null | undefined) {
  if (!next) return;
  board = next;
  emit();
}

/** Fetches the board again. Calls while one is on the way share it. */
export function refreshQuests(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = herzies
    .fetchQuests()
    .then((b) => setQuestBoard(b))
    .catch(() => {})
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Sync's line when a quest finishes (game-server.ts, noteQuestTrack). */
export const QUEST_COMPLETE_TITLE = "Quest complete";

/** How often the board is fetched while something shows it and the window
 * has focus. Progress mostly arrives with sync's "Quest complete", so this
 * only covers the rest (a new day, Spotify listens). */
const POLL_MS = 60_000;

/**
 * The quest board, or null until it first loads. While `active`, it's
 * fetched on mount, every minute with the window focused, and whenever sync
 * says a quest finished.
 */
export function useQuestBoard(active: boolean): QuestBoard | null {
  const current = useSyncExternalStore(subscribe, () => board);
  const focused = useWindowFocused();

  useEffect(() => {
    if (!active || !focused) return;
    refreshQuests();
    const timer = setInterval(refreshQuests, POLL_MS);
    return () => clearInterval(timer);
  }, [active, focused]);

  useEffect(() => {
    if (!active) return;
    return herzies.onActivity((message) => {
      if (message.startsWith(`${QUEST_COMPLETE_TITLE}:`)) refreshQuests();
    });
  }, [active]);

  return current;
}
