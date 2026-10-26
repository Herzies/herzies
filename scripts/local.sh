#!/usr/bin/env bash
# The whole game on this machine: a local Supabase (Docker), its edge
# functions, the web API, the Town server, and the desktop app pointed at
# all of them. Nothing here touches prod.
#
#   scripts/local.sh up                 functions + web (:3101) + Town (:8797), Ctrl-C stops all
#   scripts/local.sh desktop            the desktop app against them (quit the installed beta first)
#   scripts/local.sh herzie EMAIL LVL   set a local herzie's level (xp and stage to match)
#   scripts/local.sh boss [HP] [LOBBY]  open the cave's lobby now; the fight locks in LOBBY
#                                       minutes (default 3) with HP per herzie (default 20000)
#   scripts/local.sh tower [HOURS]      open the Tower (its portal in Town) for a few hours
#   scripts/local.sh reset              wipe the local database (all migrations re-applied)
#
# Sign in from the desktop with any email: the web's sign-in page offers a
# local-only form when it runs against this stack. The app keeps its data in
# ~/.config/herzies-local, away from your real session.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Off the usual 3001/8787, so a prod-backed `pnpm dev` can keep running.
WEB_PORT="${HERZIES_LOCAL_WEB_PORT:-3101}"
TOWN_PORT="${HERZIES_LOCAL_TOWN_PORT:-8797}"
FUNCTIONS_ENV="$ROOT/supabase/functions/.env.local"
DB_CONTAINER=supabase_db_herzies

supa() { npx --yes supabase "$@" 2>/dev/null; }

# API_URL, ANON_KEY, SERVICE_ROLE_KEY of the running local stack.
load_stack() {
  if ! supa status -o env >/dev/null; then
    echo "Starting the local Supabase stack (Docker)…"
    npx --yes supabase start
  fi
  eval "$(supa status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
  export API_URL ANON_KEY SERVICE_ROLE_KEY
}

psql_local() { docker exec -i "$DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -At "$@"; }

cmd_up() {
  load_stack
  local secret
  secret="$(grep -E '^TOWN_TICKET_SECRET=' packages/town-server/.dev.vars | cut -d= -f2- || true)"
  if [ -z "$secret" ]; then
    secret="$(openssl rand -hex 32)"
    echo "TOWN_TICKET_SECRET=$secret" >>packages/town-server/.dev.vars
  fi
  # The edge functions' secrets; Supabase injects its own URL and keys.
  cat >"$FUNCTIONS_ENV" <<EOF
TOWN_TICKET_SECRET=$secret
TOWN_SERVER_URL=http://127.0.0.1:$TOWN_PORT
EOF
  for port in "$WEB_PORT" "$TOWN_PORT"; do
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Port $port is taken. Free it, or set HERZIES_LOCAL_WEB_PORT / HERZIES_LOCAL_TOWN_PORT." >&2
      exit 1
    fi
  done

  echo "Supabase   $API_URL"
  echo "Functions  $API_URL/functions/v1"
  echo "Web API    http://localhost:$WEB_PORT/api"
  echo "Town       http://127.0.0.1:$TOWN_PORT (vitals -> $API_URL/functions/v1/town-vitals)"
  echo

  trap 'kill 0' EXIT INT TERM
  npx --yes supabase functions serve --env-file "$FUNCTIONS_ENV" 2>&1 | sed 's/^/[functions] /' &
  (
    cd packages/web
    # Process env beats .env.local, which points at prod.
    # Its own build folder: the client bundle bakes in NEXT_PUBLIC_*.
    NEXT_DIST_DIR=.next-local \
      NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
      NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
      SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
      npx next dev -p "$WEB_PORT" 2>&1 | sed 's/^/[web] /'
  ) &
  (
    # next dev points next-env.d.ts at its build folder; once it's up, put
    # back the committed one so git stays clean.
    until curl -sf -o /dev/null "http://localhost:$WEB_PORT/api/health"; do sleep 1; done
    git checkout -- packages/web/next-env.d.ts
  ) &
  (
    cd packages/town-server
    npx wrangler dev --port "$TOWN_PORT" \
      --var "TOWN_VITALS_URL:$API_URL/functions/v1/town-vitals" 2>&1 | sed 's/^/[town] /'
  ) &
  wait
}

cmd_desktop() {
  load_stack
  cd packages/desktop
  # Exported here, so they win over .env.local (dotenvy never overwrites).
  NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
    NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
    HERZIES_FUNCTIONS_URL="$API_URL/functions/v1" \
    HERZIES_API_URL="http://localhost:$WEB_PORT/api" \
    HERZIES_WEB_URL="http://localhost:$WEB_PORT" \
    HERZIES_CONFIG_DIR="$HOME/.config/herzies-local" \
    exec npx tauri dev
}

cmd_herzie() {
  local email="${1:?email}" level="${2:?level}"
  # Cumulative XP for the level (totalXpForLevel) and its stage
  # (stageForLevel), so the next sync doesn't move it back.
  psql_local <<SQL
update public.herzies h
   set level = $level,
       xp = (select coalesce(sum(floor(100 * power(i, 1.5))), 0)
               from generate_series(2, $level) i),
       stage = case when $level >= 25 then 3 when $level >= 10 then 2 else 1 end
  from auth.users u
 where u.id = h.user_id and u.email = '$email'
returning h.name, h.level, h.stage, h.class,
          h.stat_stamina, h.stat_sonic, h.stat_euphony;
SQL
}

cmd_boss() {
  local hp="${1:-20000}" lobby="${2:-3}"
  # The lobby is open from now; the roster locks at starts_at. Any earlier
  # local boss is cleared first (only one may run at a time).
  psql_local <<SQL
delete from public.events where type = 'boss_fight';
select public.create_boss_event(
  'Local Boss', 'Listen to what it hates.',
  now() + interval '$lobby minutes', now() + interval '$lobby minutes' + interval '1 hour',
  jsonb_build_object('hpPerPlayer', $hp, 'rewardItemId', 'cd')
) as event, now() + interval '$lobby minutes' as locks_at;
SQL
}

cmd_tower() {
  local hours="${1:-3}"
  psql_local -c "insert into public.events (type, title, active, starts_at, ends_at, config)
    values ('tower', 'The Tower', true, now() - interval '1 minute', now() + interval '$hours hours', '{}')
    returning id, ends_at;"
}

cmd_reset() {
  npx --yes supabase db reset --local
}

case "${1:-}" in
  up) cmd_up ;;
  desktop) cmd_desktop ;;
  herzie) shift; cmd_herzie "$@" ;;
  boss) shift; cmd_boss "$@" ;;
  tower) shift; cmd_tower "$@" ;;
  reset) cmd_reset ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
