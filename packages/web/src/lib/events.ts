/**
 * Next.js entry point for the shared song-hunt / secret-track event logic.
 *
 * The implementation lives once, in `packages/shared/src/game-events.ts`; the
 * Supabase edge copy is generated from it by `scripts/vendor-shared.mjs`. This
 * file exists so `import { ... } from "@/lib/events"` keeps working.
 */
export * from "@herzies/shared/game-events";
