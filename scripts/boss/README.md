# Boss raid helpers (local stack only)

Run against `scripts/local.sh up` (Supabase, functions, Town on :8797).
Each needs the local keys: `eval "$(npx supabase status -o env | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY)=' | sed 's/^/export /')"`.

- `e2e-raid.mjs`: one whole raid with three herzies (one revived, one who
  forfeits), then checks the database: roster, health sized to it, who's
  out, who's paid, the fight log.
- `raid-bots.mjs [LOBBY_SECONDS] [HP_PER_HERZIE]`: six bot teammates (a
  Bard, a Percussionist, a Record Slinger, strong and weak) to play a raid
  with from the desktop app.
- `down-bot.mjs`: a knocked-out herzie ("Floppy") in Town, to try
  Resurrect on.
