/**
 * Next.js entry point for the shared game loop.
 *
 * The logic used to live here in full, with a hand-maintained copy under
 * `supabase/functions/_shared/`. The two drifted — most notably two different
 * equipped-item checks, one of which missed a Good Eye Sniper stored as a bare
 * string. The implementation now lives once, in
 * `packages/shared/src/game-server.ts`, and the edge copy is generated from it
 * by `scripts/vendor-shared.mjs` with a staleness check in `pnpm check`.
 *
 * All this file does is supply the one thing the shared module deliberately
 * refuses to read for itself: the Node runtime's env var. Everything else is
 * re-exported unchanged, so `import { ... } from "@/lib/game-server"` keeps
 * working for existing callers.
 */
import {
  processSync as processSyncShared,
  type SyncOptions,
} from "@herzies/shared/server";

export * from "@herzies/shared/server";

/**
 * Dev-only: roll for a drop on every sync instead of every 10 listened
 * minutes. Read here rather than inside the shared module so that module stays
 * runtime-agnostic (the edge functions pass the Deno equivalent).
 */
function dropTestModeFromEnv(): boolean {
  return process.env.HERZIES_DROP_TEST_MODE === "1";
}

/** `processSync` with this runtime's drop-test-mode flag applied. */
export const processSync: typeof processSyncShared = (
  admin,
  userId,
  nowPlaying,
  minutesListened,
  genres,
  options: SyncOptions = {},
) =>
  processSyncShared(admin, userId, nowPlaying, minutesListened, genres, {
    dropTestMode: dropTestModeFromEnv(),
    ...options,
  });
