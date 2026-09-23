# Herzies Desktop

macOS desktop app for [Herzies](https://www.herzies.app), built with [Tauri](https://tauri.app/) and React. This package is the primary product surface in the monorepo.

Prebuilt installers are published on [GitHub Releases](https://github.com/Herzies/herzies/releases/latest).

## Prerequisites

- macOS
- [Rust](https://www.rust-lang.org/tools/install) and Xcode / CLT (required by Tauri)
- [pnpm](https://pnpm.io/) (workspace uses pnpm 10)

## Development

From the repository root:

```sh
pnpm install
pnpm --filter herzies-desktop dev
```

This runs `tauri dev` (Vite + native shell).

## Useful scripts

| Script | Purpose |
|--------|---------|
| `pnpm dev` | Tauri development mode |
| `pnpm check` | Typecheck (`tsc --noEmit`) |
| `pnpm build` | Production Tauri build |
| `pnpm vite:dev` | Vite only (port 1420), without Tauri |
| `pnpm sandbox` | Vite dev with sandbox HTML |

## Releasing

1. Bump the version in `package.json` and `src-tauri/tauri.conf.json` (must match).
2. Add an entry to [`release-notes.json`](./release-notes.json) for that version:
   ```json
   { "version": "0.1.0-beta.40", "highlights": ["Added X", "Fixed Y"] }
   ```
   CI fails the release if the tagged version has no entry with a non-empty `highlights` array. These are also what ships as the GitHub release notes, the updater's release notes, and the in-app "New in version" modal (shown once, to existing users, on their next launch after updating).
3. Commit, then push a `desktop-vX.Y.Z` tag matching the version — this triggers `.github/workflows/desktop-release.yml`.

## Related packages

- [`@herzies/shared`](../shared) — shared types and utilities
- [`@herzies/web`](../web) — website and game server API the app talks to
