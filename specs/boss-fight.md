# Boss Fight

## Problem

Every event Herzies has shipped is single-player. `secret_track` and `song_hunt` are both "match a track, claim a reward" — the only social surface is a first-finders list, which is a scoreboard of people racing each other, not playing together. There is no reason for two herzies to ever coordinate.

Meanwhile genres are nearly dead weight. `GENRES` (`packages/shared/src/types.ts:232`) is a curated 15-value union with a working classifier, but the only mechanic reading it is the daily craving — a private 1.5x XP multiplier nobody else can see.

A boss with a shared health bar makes both problems one problem: a health pool too large for any one player forces the community to pool listening, and the only way to deal damage is to listen to genres the boss hates.

## Appetite

**Large** — up to a week. This is bigger than Song Hunt. Song Hunt reused `event_claims` wholesale; Boss Fight needs the first **mutable shared state** in the game (HP), the first **accumulating per-user contribution** (damage), and a restructure of the events tab, which today is a Song Hunt screen wearing an events-tab costume.

What already exists and must not be rebuilt: the `events` table's `type` + `config jsonb` shape, `grant_inventory_item`, the pg_cron pattern, the `FOR UPDATE` atomic-mutation pattern, the 10s events poll, the genre classifier, and the whole ASCII creature renderer.

If the week runs out, cut in this order: the gold reward tier → the 3D boss render (ship a static ASCII placeholder) → the per-second timer bar (fall back to the existing hour-granular `formatCountdown`).

## Solution

### The screen

```
BOSS FIGHT

Completion reward: "Obsidian Fang"

        <boss 3d render>

Health:
[████████████░░░░░░░░░░░░░░░░]  42,180 / 100,000

Time left:
[███████████████████░░░░░░░░░]  2d 14h

Hates: metal · punk · thrash

Top damage dealers:
  1  herzie1   412
  2  herzie2   288
  3  herzie3   190
  ...
  7  you       64
```

Both bars use the **40-segment div pattern already in `HomeView.tsx:428-438`** (`i < Math.round(progress * 40) ? "bg-green" : "bg-[#333]"`), extracted into a shared `SegmentBar` component. Segments, not percentage widths — it reads terminal-native, which is the house style.

### Damage

**Damage = billed listening minutes on a track whose classified genres intersect the boss's hated genres.**

The critical detail: damage uses `billedMinutes`, the value `processSync` has *already* passed through every anti-cheat guard (`MAX_MINUTES_PER_SYNC` = 10, `BILL_COOLDOWN_MS` = 8s, the wall-clock `CATCHUP_RATE` cap) — **not** the raw client-asserted `minutesListened`. This is the whole reason to hang the mechanic off `processSync` rather than build a separate damage endpoint: the anti-cheat comes free and stays in one place.

Matching uses `classifyGenre(genres)` (`packages/shared/src/genres.ts:3`) so the boss's hated list and the player's listen are compared in the same 15-value vocabulary. It is the classified array, not `[0]` — `listen_log.genre` persists only the first genre, which would silently drop a metal/thrash track's second match.

**The damage RPC must be fired conditionally, and this is not optional.** `processSync` runs every 5s per visible client, and `00057_expire_stale_trades_cron.sql` exists *specifically* because an RPC sitting on a polled path accumulated 1.93M calls from ~26 users. `deal_boss_damage` is a separate round trip — it cannot fold into the existing single `UPDATE herzies` — so it fires only when **all three** hold: `billedMinutes > 0`, the classified genres intersect the boss's hated list, and a boss is currently active. All three are already in hand from `sync_context`, so the guard costs nothing and the RPC stays rare. Fire it unconditionally and you rebuild the exact problem that migration was written to undo.

### Shared HP is the real engineering problem

HP lives in a new `boss_state` row and is decremented **only** through a `SECURITY DEFINER` RPC that takes a row lock first, following `roll_pending_drops` (`00065_cap_ground_drops.sql:26`) exactly:

```sql
PERFORM 1 FROM public.boss_state WHERE event_id = p_event_id FOR UPDATE;
UPDATE public.boss_state
   SET hp = GREATEST(0, hp - p_damage)
 WHERE event_id = p_event_id
RETURNING hp, (hp = 0 AND NOT killed) AS is_killing_blow;
```

Never a client-side or server-side read-modify-write. **The write that crosses zero is the one that kills the boss**, and it flips `killed = true` in that same statement — so exactly one caller ever observes the kill, no matter how many players sync in the same second.

This is not hypothetical: `checkSecretTrackEvents` (`game-server.ts:886-909`) already has this bug in miniature — it `COUNT`s claims then inserts, and only the `unique(event_id, user_id)` constraint saves it, which enforces per-user uniqueness and *not* the global `maxClaims` cap. Boss Fight has no equivalent constraint to hide behind.

### Contribution tracking

`event_claims` cannot hold damage — it is a boolean participation record whose `unique(event_id, user_id)` would reject the second hit. New table:

```sql
create table public.boss_damage (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id  uuid not null references auth.users(id)   on delete cascade,
  damage   real not null default 0,
  primary key (event_id, user_id)
);
```

Accumulated with `insert ... on conflict (event_id, user_id) do update set damage = boss_damage.damage + excluded.damage` — the same atomic upsert idiom as `increment_hint_play` (`00038:38`).

### The weekly window: Thursday → Sunday

A boss is **not** a week-long event. It runs **Thursday 00:00 UTC to Monday 00:00 UTC** — four days, covering Thursday through end of Sunday. Monday to Wednesday is deliberately left empty so other event types (a Song Hunt, whatever comes next) own the front half of the week and never compete with a boss for the events tab.

That leaves the events tab with a real weekly rhythm rather than a permanent boss occupying it.

### Spawning: pg_cron

`pg_cron` is already an extension in this project with two live jobs (`00026_chat_message_retention.sql`, `00057_expire_stale_trades_cron.sql`), so the spawner is in-database. **This matters:** `packages/web/vercel.json` is `{"crons": []}` and the Spotify cron was removed entirely because Hobby plans cap out at daily — a Vercel-hosted weekly spawner is not available.

Three jobs, all following `00057`'s unschedule-then-schedule guard, and all of them **thin wrappers over plain SQL functions** (`00057` ends with a bare `select public.expire_stale_trades();` for exactly this reason). The cron is only ever a caller — that is what makes local testing possible:

- `spawn-boss-fight` → `spawn_boss_fight()`, `0 0 * * 4` (Thursdays 00:00 UTC) — picks a template from a pool, rolls 3 hated genres, computes HP, inserts an `events` row with `type = 'boss_fight'`, `ends_at = starts_at + interval '4 days'`, plus a `boss_state` row.
- `settle-boss-fight` → `settle_boss_fight()`, every minute — pays out killed-but-unsettled bosses.
- `resolve-boss-fight` → `resolve_boss_fight()`, hourly — marks bosses past `ends_at` that are still alive as escaped.

`spawn_boss_fight()` **must no-op if a `boss_fight` event is already active**, or a hand-run during testing (or a cron retry) silently produces two live bosses and the "find the active boss" query in `sync_context` becomes non-deterministic.

**HP formula:**

```
hp = clamp(active_herzies * 35, 900, 50000)
```

where `active_herzies` = count of `herzies` with `last_synced_at` inside the last 7 days. 35 damage-minutes per active player, over a **four-day** window. Sanity check: with 3 of 15 genres hated, a player matching ~20% of their listening and playing ~2h/day contributes ~96 minutes across four days, so the target lands near 36% participation.

> These numbers are scaled from a 7-day assumption (60/player) to the 4-day window. If the window changes again, this constant has to move with it — it is minutes-per-player-per-*event*, not per week.

**This formula is load-bearing and it is the thing most likely to be wrong.** Combined with "boss escapes, no reward", an over-sized boss means the feature never pays out and the mechanic reads as broken rather than hard. The floor of 900 exists because the player base is small (production notes in `00057` cite ~26 users). Ship the first boss deliberately under-tuned.

### Testing it locally, without waiting for Thursday

This is a hard requirement, not a nice-to-have: a four-day event on a weekly cron is otherwise untestable in under a week. Three levers, cheapest first:

1. **Call the functions by hand.** Because the cron jobs are thin wrappers, `select public.spawn_boss_fight();` spawns one immediately, and `settle_boss_fight()` / `resolve_boss_fight()` force either ending. No waiting, no cron, no clock manipulation.
2. **Admin UI spawn with full control.** `GameAdmin.tsx` already creates events from a per-type `DEFAULT_CONFIGS` map and a type `<option>` list (`:99`, `:708`). Boss Fight gets an entry plus a small form for hated genres, HP, reward ids, and `ends_at` — so a dev can spawn a 50-HP boss that hates a genre they can actually play, ending in ten minutes. **Give the genre picker an explicit list rather than a text field**; the whole mechanic is silent if a genre is typed that `classifyGenre` never emits.
3. **Force the panel without a live boss.** `EventsView.tsx:162` already has a `debugForceActive` escape hatch for previewing the Song Hunt UI; the boss panel should honour the same flag so the layout, bars, and 3D render can be iterated on with fixture data.

The awkward part is *dealing damage* — it needs a real track whose Last.fm tags classify into the hated genre. Spawning a boss that hates a genre you own music in (lever 2) is the practical answer; calling `deal_boss_damage` directly is the fallback for testing the kill and settle paths without touching a music player at all.

### Rewards — the kill does not hand out the loot

The obvious design is "the killing blow grants everyone their item", and it is wrong. That runs N grants synchronously inside one unlucky player's `/sync` request. If it dies halfway — edge function timeout, bad item id, network blip — some players are paid and some aren't, `boss_state.killed` is already `true`, and nothing ever retries.

So split it:

1. **The killing blow does one thing**: flips `killed = true` atomically and returns. No fan-out.
2. **A settle job pays out**, and is safe to run any number of times. Per participant: `insert into event_claims (event_id, user_id)` → on success call `grant_inventory_item` → **on conflict, skip**. This is the exact race-safe idiom `checkSecretTrackEvents` already uses (`game-server.ts:911-919`), and it is what `unique(event_id, user_id)` is for. The claim row *is* the "already paid" ledger, which is why `event_claims` still earns its place even though damage lives elsewhere.

Runs on its own pg_cron job at **one minute**, like `expire-stale-trades`, so the kill-to-reward gap stays short.

Payout:

- **every player with `damage > 0`** → the base reward item
- **top 3 by damage** → the base item **and** the gold variant

Reward ids live in `config` as `rewardItemId` + `topRewardItemId`, mirroring Song Hunt's `rewardItemId`. Delivery is the existing `notifications: EventNotification[]` channel on the sync response, so the reward reaches the UI on the next tick with no new plumbing — and per house style those lines read `You received: 1x "Obsidian Fang"`, never a raw item id.

**Do not build claiming on `/api/events/claim`.** Despite its docstring advertising itself as the path for "future event types", it writes the legacy `inventory` `string[]` column with a non-atomic read-modify-write (`route.ts:78-92`), while every live path uses `inventory_v2` + `grant_inventory_item`. Fix it or bypass it.

### The boss render

A new `buildBoss` body type in `creature-renderer.ts`, **not** a renderer change — `specs/desktop-herzie-visual-pop.md` has a standing no-go on starfield and render-pipeline work, and the appetite only survives if the boss is new *input* to the existing renderer.

Thematically: **a corrupted herzie.** Same pipeline, same silhouette language, wrong colours and wrong motion.

The renderer has no emissive, no glow, no shaders, and a single-glyph ramp (`RAMP_HERZIE = "▓"`), so *all* shading is carried by colour. That leaves four levers:

1. **Palette** — a `VOID_RAMP` (dark red → black) added to `ascii3d.ts` and registered in `COLOR_SCHEMES` (`creature-renderer.ts:1275`). This is the highest-leverage change: the existing scheme mechanism resolves hue from the ray hit point's Y, so it's per-pixel, rotation-stable, and needs zero renderer surgery.
2. **Silhouette** — start from `buildSpiky` (`:752`), crank `spikeCount`, widen the stance, drop the head lower into the body.
3. **Eyes** — a new `ColorZone` (`"eye-evil"`) plus a `zoneColor` case. **Not** a change to `EYE_COLOR`, which is shared by every creature and asserted in `creature-renderer.test.ts:38,66`.
4. **Motion** — a slower, heavier idle block (`cycles: 1`, larger `amp`) alongside `IDLE` (`:148`). Low-frequency motion reads as menacing; `cycles` must stay a whole number or the loop won't tile.

Optional, if time: a dark-red CSS aura copying the `animate-prismatic` overlay at `desktop/src/components/Herzie3D.tsx:88-107`, swapping `mixBlendMode: "screen"` for `"multiply"`.

## Rabbit Holes

- **"pop" is the fallback genre for everything, and it will break the boss.** Unmatched Last.fm tags fall back to `["pop"]` (`genres.ts:57`), the Spotify path hardcodes `["pop"]`, and a Last.fm timeout or missing API key resolves to `["pop"]` (`lastfm.rs:175`). A boss that hates pop takes damage from every listen in the game, including from users with no genre data at all. **Ban `pop` from the hated-genre pool** and say so in the spawner.

- **HP tuning vs. the escape condition** — covered above; the single most likely way this ships broken.

- **`EventsView` is not a dispatcher.** It's a Song Hunt screen built from sequential early returns (`:153`, `:161`, `:176`, `:309`, `:335`) that picks its event with `events.find((e) => e.type === "song_hunt")`. Boss Fight means restructuring it into per-type components. Budget for the restructure, not a new branch.

- **The type dispatch exists in three places, across two runtimes.** The desktop app talks to *both* the Supabase edge function (`supabase/functions/events-active/index.ts:74`) and Vercel (`api/events/active/route.ts:29`, `api/events/previous-hunt/route.ts:69`). All three need the new type. There is a **fourth** site in a different file: `main.tsx:225` computes the tab's star indicator as `events.some((e) => e.type === "song_hunt")`. Miss it and the failure is silent and expensive — a boss spawns, the events tab never lights up, nobody opens it, the boss escapes. Related: `00060_sync_context.sql:70` hardcodes `where e.type = 'song_hunt'`, so a boss will not appear in `sync_context` without a migration.

- **`packages/shared/src/game-server.ts` is vendored into `supabase/functions/_shared/shared/`.** Edit the canonical copy, run `pnpm vendor:shared`, and add anything new to `scripts/vendor-shared.mjs`'s `ENTRIES`. `pnpm check` fails CI on a stale copy. Never hand-edit the vendored file.

- **Clients cannot read `events` directly** — `00016_events_rls_lockdown.sql` revoked select from `anon`/`authenticated` after players read `config.trackTitle` straight out of PostgREST. Every boss field has to be explicitly projected by each API layer. Note the `else { config = e.config }` fallthrough in `events-active`, which would leak the whole config by default.

- **Don't widen the seeded body-type roll.** `generateCreatureParams:372` is `intSeeded(0, 3, rng)` and that `3` is *not* read from `CREATURE_PARAM_BOUNDS`. Bumping it to 4 remaps `bodyType` for every existing seed and silently changes what every herzie in the wild looks like. The boss arrives via the `creatureParams` override prop; leave the roll alone.

- **`SH = 48` rows is a module constant and is not parameterised** (`cols` is). A boss scaled up to loom will clip top and bottom rather than overflow. Prototype the silhouette in `packages/desktop/src/sandbox.tsx`, which already has every `CreatureParams` field on a slider.

- **Per-second timer ticking is new work.** Every existing countdown is a format function recomputed on the 10s poll, at hour granularity (`formatCountdown`, `EventsView.tsx:10`). A smooth time-left bar needs its own interval.

- **`frameCache` is never evicted** (`creature-renderer.ts:1956`) and keys on `JSON.stringify(params)`. A boss whose params vary with HP would leak a full 120-frame loop per distinct value.

## No-gos

- **No Supabase Realtime.** The 10s events poll is enough; a shared HP bar that updates every 10 seconds reads as live. Realtime templates exist (`00027_chat_broadcast.sql`) if it ever needs to be faster — but that's a later pitch, and it needs its own `realtime.messages` RLS policy.
- **No renderer changes.** New creature input only. No starfield changes, no lighting changes (the light vector is shared with the item renderer, so touching it moves every item card).
- **No new stage.** `stage` is `check (stage >= 1 and stage <= 3)` in the schema; the boss is not a herzie row and doesn't need one.
- **No persisted boss appearance.** Derived from the event's config at render time, like everything else the renderer does.
- **No partial-damage consolation reward.** The boss escapes clean — that's what makes the bar tense.
- **No boss history, no past-boss browser.** Current boss only, matching Song Hunt.
- **No per-player damage cap or rate limit beyond what `processSync` already enforces.**
- **No CLI support.** Desktop only.
- **No boss that hates `pop`.**

---

**Next steps:** Use plan mode or `/delegate` to break this into implementation tasks. Scope is bounded by this document; anything not described here is out of scope unless the pitch is revised.
