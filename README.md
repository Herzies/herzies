<p align="center">
  <img src="packages/desktop/src-tauri/icons/icon.png" alt="Herzies" width="128" height="128" />
</p>

Your digital pet that grows by listening to music. **[herzies.app](https://www.herzies.app)**

Day-to-day work in this repo centres on the **desktop app** (Tauri, macOS and Windows): it is the main product surface we ship and extend. Everything else supports it: the database and game loop, the multiplayer Town, and the website.

## Getting Started

Download the latest **Herzies Desktop** build for macOS or Windows from the [latest GitHub release](https://github.com/Herzies/herzies/releases/latest). The app updates itself.

> [!IMPORTANT]
> **Beta** — Herzies Desktop is still in beta. If you run into errors or bugs, please report them as [GitHub issues](https://github.com/Herzies/herzies/issues).

## How it fits together

```
 desktop app ──sync, chat, events…──▶ Supabase edge functions ──▶ Postgres
      │                                        ▲
      │ town-ticket (signed pass)              │ town-vitals (HP, bench rest)
      ▼                                        │
 Town server (Cloudflare Worker + Durable Objects) ◀──watch── website
```

- **Supabase** holds everything persistent: the Postgres database (`supabase/migrations`) and the edge functions the app calls (`supabase/functions`).
- **The Town server** is the real-time multiplayer Town: a Cloudflare Worker with one Durable Object per room (`herzies-town`). It has no database access. It trusts the pass `town-ticket` signs, and reports health back through `town-vitals`.
- **The website** (Next.js on Vercel) is the landing page, sign-in, the store, and a few API routes. Its front page watches the Town live, read-only, with stand-in bodies.
- **Shared rules** live once in `@herzies/shared`. The edge functions get a vendored copy (`pnpm vendor:shared`; `pnpm check` fails when it's stale).

## Packages

| Package | Description |
|---------|-------------|
| [`herzies-desktop`](packages/desktop) | The desktop app (Tauri + React). Music detection, the herzie, the 3D Town. Also builds the website's Town showcase (`build:showcase`) |
| [`@herzies/shared`](packages/shared) | Game rules, item catalog, types, the sync game loop (`game-server.ts`), and the WebGL herzie renderer (`gl/`) |
| [`@herzies/town-server`](packages/town-server) | The multiplayer Town: Cloudflare Worker + Durable Objects. Rooms, combat, the boss cave and the Tower |
| [`@herzies/web`](packages/web) | Website, sign-in, store (Stripe) and the remaining API routes, on Vercel |

## Edge functions

| Function | What it does |
|----------|--------------|
| `sync` | The game loop: listening becomes XP, drops, streaks, events. Called every few seconds by each active app |
| `chat` | Town chat, read and send |
| `events-active` | What's on now (song hunts, bosses, visitors), polled by the app |
| `trade-pending` | Incoming trade requests, polled by the app |
| `collect-drop` | Picks up a drop off the ground |
| `town-ticket` | Signs the pass into the Town server |
| `town-vitals` | Where herzie HP is written, by the Town server and the app |
| `attune-crystal` | Cashes in the Crystal: XP and drops |
| `upgrade-crystal` | Spends Crystal Shards on a bigger Crystal |
| `debug-spawn-drop` | Dev builds only: spawns a drop on demand |

## Local development

Needs Node, [pnpm](https://pnpm.io) 10, Rust (for Tauri) and Docker (for the local Supabase).

```sh
pnpm install
scripts/local.sh up        # local Supabase + edge functions, web on :3101, Town on :8797
scripts/local.sh desktop   # the desktop app against all of that (quit the installed beta first)
```

Nothing in `local.sh` touches prod. Sign in with any email. Run `scripts/local.sh` with no arguments for the rest (level a herzie, open the boss cave or the Tower, reset the database).

Other useful commands:

```sh
pnpm check                          # typecheck everything + vendored-shared staleness
pnpm test                           # unit tests
npx biome ci .                      # lint + format, as CI runs it
pnpm --filter herzies-desktop sandbox      # Town sandbox in the browser
pnpm --filter herzies-desktop map-editor   # the Town map editor
```

`pnpm --filter @herzies/web test:integration` runs the integration tests against the local database (`scripts/local.sh reset` first).

## Releasing

Server first, then the app:

1. **Migrations** go to prod one at a time through the Supabase MCP `apply_migration`, never `supabase db push`.
2. **Edge functions**: `npx -y supabase@2 functions deploy <name> --project-ref ojqfqxolbjegorgoyond`, one per call. CLI v3 rejects this repo's `config.toml`.
3. **Website**: pushing `main` builds production on Vercel.
4. **Town server**: `pnpm --filter @herzies/town-server deploy` (`wrangler deploy`), from a clean checkout of `main`, with shared built first. Redeploy it whenever `TOWN_PROTOCOL` changes, or every app is shut out of the Town.
5. **Desktop**: bump the version in `package.json`, `tauri.conf.json` and `Cargo.toml`, add the notes to `packages/desktop/release-notes.json`, and push a `desktop-v<version>` tag. CI builds macOS and Windows and publishes the release, which the in-app updater picks up.

## Want to contribute?

- **Add support for more platforms**: now-playing detection uses MediaRemote (with AppleScript as a fallback) on macOS and System Media Transport Controls on Windows. Linux (e.g. MPRIS) is not supported yet.
- **Add support for more music players**: detection works for players that report to the system's now-playing feed. Players that don't are worth covering too.
