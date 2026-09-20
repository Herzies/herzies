#!/usr/bin/env bash
# Run the desktop app against the LOCAL Supabase stack instead of production.
#
# The app reaches three different backends and each has its own env var. Miss
# one and it silently keeps using the production default — api_base() in
# api.rs falls back to https://www.herzies.app/api, so onboarding would POST
# to production while everything else talked to localhost.
#
# Prereqs, in three other terminals:
#   npx supabase start
#   npx supabase functions serve      # events-active lives here, not in `start`
#   cd packages/web && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
#     NEXT_PUBLIC_SUPABASE_ANON_KEY=<local anon> \
#     SUPABASE_SERVICE_ROLE_KEY=<local service role> pnpm dev
#
# (packages/web/.env.local holds PRODUCTION credentials; shell vars take
# precedence over it in Next.js, which is what keeps the above local.)
#
# Then seed a boss to look at:
#   node scripts/boss-fight-demo.mjs --keep
#
set -euo pipefail

# Rust (api.rs::supabase_url / supabase_anon_key) and the frontend's auth
# config (lib.rs::get_auth_config) both read these.
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
# events-active is an edge function; `supabase start` does not serve those.
export HERZIES_FUNCTIONS_URL="http://127.0.0.1:54321/functions/v1"
# /herzie, /leaderboard and friends — the Next.js API, not an edge function.
export HERZIES_API_URL="http://localhost:3000/api"
# The login flow opens <web>/auth/cli in a browser.
export HERZIES_WEB_URL="http://localhost:3000"

echo "desktop -> $SUPABASE_URL"
cd "$(dirname "$0")/../packages/desktop"
exec pnpm tauri dev
