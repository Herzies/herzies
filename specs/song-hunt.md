# Song Hunt

## Problem
There's no recurring event that gives users a reason to come back each week or engage with music discovery as a game mechanic. The secret track event exists but it's passive — no hints, no progression, no social element. Song Hunt turns "listen to a song, get a reward" into a weekly puzzle with daily reveals and social proof.

## Appetite
**Large** — up to a week. The event infrastructure, sync detection, and item granting already exist. The new work is: events tab UI, hint system with server-side garbling, daily hint unlocking, first-finders tracking, and the notifications. No new Supabase Realtime, no new polling infrastructure.

## Solution

**Weekly cycle**: A new Song Hunt drops every Monday, runs through Sunday. Admin creates hunts via the existing admin events API with an extended config.

**Hint system**: The event config stores an ordered array of hints, each with an unlock date. The server returns all hints on the active events endpoint, but **garbles locked hints server-side** — replaces characters with random characters while preserving length, so it looks like pixelated/corrupted text. Once a hint's date passes, it's returned in plain text. This prevents inspect-element cheating.

**Events tab**: New tab in the desktop app showing:
- The active hunt with title, duration (countdown to end), and reward item preview (using existing 3D ASCII item renderer)
- The full list of hints — unlocked ones readable, locked ones garbled with a visual treatment (monospace, maybe a subtle color difference to signal "not yet")
- "First 3 finders" section showing herzie names + timestamps of the earliest claims, pulled from `event_claims`
- Empty state for when no hunt is active

**Detection**: The existing `processSync()` flow handles matching. When a user's now-playing matches the hunt's target song, it auto-claims and grants the reward. The sync response already supports notifications. Remove the `source: "cli"` gate so desktop syncs also trigger secret track checks.

**First-finder notification**: When the first person claims, that fact is stored on the event (or derived from claims). On subsequent syncs, if the user hasn't seen the "first finder" announcement yet, the server includes a notification: "[herzie name] found the song! Find it yourself to claim your reward." Delivered as a native macOS notification via the existing notification system.

**Polling**: The desktop app fetches active event data on each sync (or on a slower cadence, e.g., every 60s). No Realtime subscription needed — the events tab refreshes from cached data.

## Rabbit Holes
- **`source: "cli"` gate on secret track checks**: Currently the server only checks secret tracks for CLI-sourced syncs. Need to open this up for desktop. Should be a small change but need to verify no side effects with Spotify catch-up syncs (which use a different source).
- **Garbling algorithm**: Needs to be deterministic per-session or it'll "shimmer" on every poll. Could seed the randomization with the hint index + event ID so it's stable.
- **Timezone handling for daily hint unlocks**: Hints unlock by date — but whose timezone? Suggest UTC to keep it simple, and show "unlocks in X hours" in the UI rather than a specific time.
- **Admin tooling for creating hunts**: The existing admin events API works, but the config shape changes. Need to make sure the admin flow supports the new hint array + target song + reward setup without breaking existing event types.
- **What happens when a user opens the Events tab and there's no active hunt?** (Between Sunday end and Monday start, or if no hunt is scheduled.) Need an empty state.

## No-gos
- No Supabase Realtime — poll-based only for now
- No CLI support — desktop app only
- No hint request/unlock mechanics (hints are purely time-based, not user-action-based)
- No leaderboard beyond first 3 finders
- No general song preview or full-track playback — users still figure out the song and go play it in their music app. (Update: short admin-uploaded audio *hint* snippets, capped at 3 plays/user, are now supported per-hint — see the audio hints addition. This is a bounded hint mechanic, not a way to preview or hear the actual target track.)
- No history of past hunts (just the current active one)
- No push notifications or webhooks — notifications only arrive during sync when the app is open
