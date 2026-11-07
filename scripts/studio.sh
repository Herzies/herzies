#!/usr/bin/env bash
# The control panel (/admin) on this machine, with its local-only parts:
# item art and game text (saved into the repo by the web dev server) and
# the map editor (started by the panel when you open it).
#
#   scripts/studio.sh           against prod (web dev on :3001)
#   scripts/studio.sh --local   against the local stack: run `scripts/local.sh up`
#                               first; its web (:3101) serves the panel
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WEB_PORT=3001
if [ "${1:-}" = "--local" ]; then
  WEB_PORT="${HERZIES_LOCAL_WEB_PORT:-3101}"
fi
URL="http://localhost:$WEB_PORT/admin"

listening() { lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if listening "$WEB_PORT"; then
  echo "Control panel: $URL"
  open "$URL" 2>/dev/null || true
  exit 0
fi
if [ "$WEB_PORT" != 3001 ]; then
  echo "Nothing on :$WEB_PORT. Run scripts/local.sh up first." >&2
  exit 1
fi

# Open the browser once the dev server answers.
(
  for _ in $(seq 1 120); do
    curl -s -o /dev/null "$URL" && break
    sleep 1
  done
  echo "Control panel: $URL"
  open "$URL" 2>/dev/null || true
) &
exec pnpm --filter @herzies/web exec next dev -p "$WEB_PORT"
