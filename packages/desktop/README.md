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

## Related packages

- [`@herzies/shared`](../shared) — shared types and utilities
- [`@herzies/web`](../web) — website and game server API the app talks to
