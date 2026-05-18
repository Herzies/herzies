# @herzies/web

Next.js app for [Herzies](https://www.herzies.app): marketing site, Supabase-backed auth, game server API routes, and internal tooling. Consumes [`@herzies/shared`](../shared) for shared types and utilities.

## Prerequisites

- Node.js compatible with the monorepo
- [pnpm](https://pnpm.io/)

## Environment variables

Local development expects a `.env.local` (not committed) with at least:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Other routes may require additional variables (Spotify integration, cron, admin, mailing list, and so on). Inspect `src/lib` and `src/app/api` for `process.env` usage when enabling those features.

## Development

From the repository root:

```sh
pnpm install
pnpm --filter @herzies/web dev
```

Or from this directory:

```sh
pnpm dev
```

## Scripts

| Script | Purpose |
|--------|---------|
| `pnpm dev` | Next.js dev server |
| `pnpm build` | Production build |
| `pnpm start` | Run production server locally |
| `pnpm check` | Typecheck (`tsc --noEmit`) |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:integration` | Integration tests |

## Related packages

- [`herzies-desktop`](../desktop) — macOS client that uses the web API
- [`@herzies/shared`](../shared) — shared types and utilities
