# PvP scope: Wilds, Duels, Teams

## Context
Herzies has PvE combat only: bosses, the Tower, mobs and dummies. The user wants PvP in three modes, each with a reason to play it:
- **Wilds**: open PvP on the existing Wilds island.
- **Duel**: 1v1, started anywhere.
- **Teams**: matchmade team fights.

Decisions the user made:
- Dying in the Wilds costs only time.
- The Wilds are always PvP except a safe camp around the spawn and portal.
- Rewards are **cosmetic only**.
- Teams use an **always-on queue**.

No PvP code exists yet. The next migration is `00141`.

## What we build on (found in code)
- **In the boss room and Tower, casts are already judged on the server.**
  - The client sends only aim (yaw/pitch).
  - `FightRuntime.cast` (`packages/town-server/src/fight.ts:672`) → `BossEngine.cast` / `spendCast` (`boss.ts:860/894`) handles it, using lag-compensated positions from `history.ts` (`PositionHistory`, rewind 120 ms).
  - The math is `hitDamage`, `meleeReaches`, `discChain` and aim assist in `packages/shared/src/combat.ts`.
  - Damage to herzies goes through `mitigatedHit` (`boss.ts:1634`: 30% max-HP cap per hit, `defReduction`, 75% reduction clamp) and `takeHits` (`fight.ts:1691`: domes, KOs, `hp`/`down` broadcasts).
- **Everywhere else (home, wilds, the `arena` training ground) there is no server combat.** `room.fight` is null, casts are only a 3-bit visual counter, and `onCast` strikes the socket (`room.ts:829`). Training dummies are hit client-side. **PvP needs a new lightweight server-side engine for normal rooms that reuses those pieces.** This is the core of phase 1.
- **Rooms:**
  - `packages/town-server/src/index.ts` routes `/v1/town/<map>?shard=n[&i=]`.
  - `TOWN_INSTANCED_MAPS` rooms are named `map:<instance>` (only the Tower today; `room.ts:773` checks `instance === uid`). A team match is an instanced map named by a match id, with a `match` ticket claim (the same pattern as the `boss`/`tower` claims in `town-ticket`).
  - Shard choice happens on the client and goes to the first room that fits (40 cap), so friends can land on different shards. That's fine for duels, since you can only challenge who you see. It also suits the Wilds: first-fit keeps players together on one shard until it's full.
- **No terrain on the server.** It knows only `radius`/`spawn`, with no collision, elevation or line of sight. **v1 accepts no line-of-sight checks** (the duel ring and `stage` are flat). A coarse check using the Wilds `heights` grid is a later polish item.
- **Tickets:** HMAC `TownTicketPayload` (`shared/src/town-net.ts:119`) already carries stats, level, class, skills and HP, so the server has everything it needs to judge PvP. `TOWN_PROTOCOL = 4` → bump to **5**.
- **Wilds:** a rest map with benches and no combat flag. **Its portal from Home was removed in `8f7cf57`**, so it has to be re-added.
- **Move guard.** `rules.ts` checks speed and edges against `TOWN_MAPS` (`wilds: radius 83, spawn 66.5,0.5`).
- **Stats.** `statsOf` (`fight.ts:2255`) builds them from the signed ticket `st`. That's where PvP normalization goes.
- **Patterns to copy:**
  - Monthly boards: `herzie_xp_monthly` (00119) and `/api/leaderboard/route.ts`.
  - Payout tiers: boss contribution (00111/00124).
  - Champion statue: `boss_champion_json` (00109), shown in town via `town-ticket`.
  - Emote grants: `herzies.emotes` (00132).
  - Replay-safe batches into `town-vitals`: the Tower (00115).
  - Messages: `notify()` in desktop `lib/notices.ts`.

## Design principles (industry research, adapted to a small population)
1. **The server decides every PvP hit,** using the existing 120 ms rewind cap.
2. **Fairness comes from normalization, not gear.** Ranked duels and Teams flatten stats to a class template (GW2 model). Gear shows only as looks, which suits cosmetic-only rewards. The Wilds use real stats, with these limits:
   - The existing `MAX_HIT_FRACTION 0.3` (no one-shots).
   - The attacker's Sonic Power is capped to the victim's level band (victim level + 10).
3. **Anti-grief without killing the zone.**
   - Safe camp around the spawn and portal.
   - Spawn protection (5 s, or until you attack).
   - No kill credit on the same victim more than once per 10 min.
   - A rising **"Wanted"** bounty on players with long kill streaks. Low-level kills give the killer nothing.
4. **Anti-farm rewards.**
   - Wins only.
   - Diminishing returns per distinct opponent per day.
   - Daily currency cap.
   - Duels between the same pair pay once a day.
   - No rewards for fights under a minimum duration or damage dealt.
5. **CC needs diminishing returns.**
   - Rimshot stun reuses the existing `stunMs` diminishing returns, with a shorter base duration against players.
   - Taunt (boss-only) is disabled in PvP.
   - Combat logging: leaving or changing map within 10 s of taking PvP damage gives the kill to the last hitter and forfeits any duel.
   - PvP HP is kept per uid for 30 s, so reconnecting doesn't heal.
   - Bard Resurrect does nothing to a PvP-defeated herzie.
   - Contact damage is off between players.
   - The Cymbrella dome blocks enemy hits only, and only for its team.
6. **Make queues pop with a small population.**
   - Glicko-2 rating (1v1 and per-player team rating), shown as tiers rather than raw numbers.
   - Search widens every 15 s. After ~60 s it matches anyone.
   - Teams queue as **2v2 by default** and can drop to a 1v1 offer.
   - A visible "N in queue" count. You can keep playing in Town while queued.
7. **Mid-match disconnects.** A 30 s rejoin window, then the match counts as a forfeit. Leavers get a short queue lockout.

## Modes

### Duel (phase 1, proves the PvP damage path)
- **Start a duel:** right-click a herzie → "Challenge to duel", or `/duel "Name"`. The target gets a `notify()` with Accept/Decline (20 s timeout).
- **Where it happens:** in place, in the current room. A ring is drawn around the midpoint (radius ~12). Leaving it for more than 3 s forfeits.
- **Who it affects:** only the two duelists can damage each other. Everyone else is unaffected and can watch.
- **Format:** best of 1, a 3-2-1 countdown, a 90 s limit, then sudden-death damage ramps up.
- **Losing:** you're "defeated", not KO'd. **All PvP HP is room-local:** it starts at full max HP, is never reported to `town-vitals`, and is never sent home by `respawn_herzie`. Stored PvE HP is untouched, which keeps "death costs only time" true everywhere.
- **Ranked vs unranked:** unranked by default, using real stats. A "Ranked duel" toggle uses normalized stats and changes duel rating.
- **Where duels are blocked:** boss cave and the Tower. Home is fine.

### Wilds (phase 2)
- PvP is on everywhere in `wilds` except the safe camp. The camp radius sits around the spawn and comes from a `safe` layer in the map editor.
- Player hits go through the same judge as mob hits.
- **On KO:**
  - A 6 s respawn at camp.
  - The killer gets a kill-feed line, `Took down "Name"`, shown to people nearby.
- **Level scaling:** the attacker's Sonic Power is capped at what a herzie at the victim's level + 10 could have, and the 30% max-HP-per-hit cap applies.
- **Rewards:** **Marks** (see Incentives) per credited kill, plus streak bonuses. The Wanted bounty pays out to whoever ends the streak.
- **Parties don't hurt each other.** This adds a **party** concept, which Teams needs anyway: invite/accept in chat and a party frame. It's minimal at first: a party id lives in the room, and members are friendly.

### Teams (phase 3)
- **Queue:** an always-on queue from a PvP window (new tab in the Events/Menu area). Solo or party.
- **Server:**
  - A new **`pvp-queue` Durable Object** (single instance, in the town-server worker) holds the queue, runs widening matching every 2 s, and creates a match id.
  - Clients then fetch a ticket from `town-ticket?map=stage&match=<id>`. The ticket checks the match with the DO and signs `match`, `team` and `norm: true`.
  - v1 is a solo queue. Party queueing (premades matched against premades or against solos with a rating handicap) comes in phase 3b.
- **Map:** a new instanced map **`stage`**, a small symmetric concert stage built in the map editor (`arena` is taken by the training ground). Its room is `stage:<matchId>`.
- **Format:** 2v2 (later 3v3). First team to 5 KOs, 4 s respawns at a team base, 5 min limit, and the tiebreak is total damage.
- **When it ends:** the room posts the result to a new `pvp-result` edge function (service role). That function updates Glicko-2, match history and rewards. A results screen shows MVP, damage, healing, blocked and KOs.

## Incentives (all cosmetic)
- **Marks**
  - A new PvP currency (`herzies.pvp_marks`, service-role write). Earned in all modes, with the caps above.
  - Spent at a new **Arena vendor NPC** in Town, on cosmetics only: trophy items, PvP-themed cloaks/back items, emotes such as Bow and Taunt-dance, and auras.
- **New item type: Trophy** (new equip slot `trophy`)
  - Shows as a small floating badge/banner over the herzie in Town and on the profile card. It's visible to everyone, so it's a status signal.
  - Comes in tiered seasonal trophies: Bronze/Silver/Gold/Platinum/Herzie Legend, based on peak rating. The season's year/month is printed on the item.
  - Duel-streak and Wanted-hunter trophies are awarded once.
  - Uses the per-copy `item_units` row so it records the season. Not tradable, not sellable (`NON_DROPPABLE_ITEM_IDS`).
- **Titles**
  - "Duelist", "Wanted", "Arena Champion".
  - Shown with the name like the GM mark and carried in the ticket. Store them in `herzies.title` + an `earned_titles text[]`.
- **Leaderboards**
  - `pvp_duel`, `pvp_team` and `pvp_wilds_month` (kills), with `_friends` variants on the existing leaderboard route.
- **Champion statue**
  - A second statue for the monthly top Team-rated player, using the `boss_champion_json` pattern.
- **Seasons**
  - Monthly (fits the Monthly Tower series). Ratings soft-reset toward the mean, and trophies are minted at season end.

## Phases and files
**Phase 1: PvP core + Duels**
- **`packages/shared/src/combat.ts`, `skills.ts`:** a `pvp` rules module covering player-as-body, CC diminishing returns, PvP-only skill overrides and the normalized stat template.
- **`packages/town-server/src/pvp.ts` (new): a `PvpRuntime`** that a room creates when `room.fight` is null. It owns:
  - Per-player PvP HP, cast budget (reuse `spendCast` logic), skill cooldowns and the duel state machine (challenge, countdown, active, end).
  - `canHurt(a, b)`.
  - Hit resolution against other players via `PositionHistory` + the combat.ts math + `mitigatedHit`, with player-vs-player skill rules (Rimshot stun diminishing returns via `stunMs`, Cymbrella blocks only hostile hits, Drones/Haste only on friendlies, no contact damage).
  - Pull the shared pieces out of `boss.ts`/`fight.ts` into small helpers, rather than copying them.
  - `room.ts` routes `OP_CAST` and `skill` to it instead of striking when there's no fight.
- **`room.ts`:** new messages `duelAsk`, `duelAnswer`, `duelState`, `duelEnd` and `pvpHit` (or reuse `hit`/`hp`), behind a **TOWN_PROTOCOL bump**.
- **Desktop Town client:**
  - On PvP-capable maps, send real `OP_CAST` frames and skill messages (today only the visual counter is sent), and skip local damage rolls.
  - Draw remote HP bars, `hit` numbers and defeats outside the boss room.
  - Challenge UI (player click menu, `/duel` in `ChatPanel.tsx` `CHAT_SLASH_COMMANDS`), duel ring, countdown and a result shown with `notify()`.
- **Copies to keep in sync:** `supabase/functions/_shared/shared/town-net.ts` and `items.ts` are hand-made copies, so new ticket claims, the `stage` map and the trophy slot go in both. Also add the `stage` entry to the `TOWN_MAPS`↔desktop map sync test.
- **Migration `00141_pvp.sql`:**
  - Columns `pvp_marks`, `title`, `earned_titles` and Glicko columns, stored in a new `pvp_ratings(user_id, mode, rating, rd, vol, wins, losses, season)` table (service role only).
  - A `pvp_matches` log.
  - Function `settle_pvp_match`.
- **Edge function `pvp-result` (new):**
  - Receives HMAC-signed posts from the room, the same way `town-vitals` does (`vitals.ts signedPost`), with a replay guard.
  - Does the Glicko-2 math and calls `settle_pvp_match` to pay Marks under the caps.
  - Kill and duel log lines use quoted display names.

**Phase 2: Wilds**
- **Map:** re-add the Home → Wilds portal, add a safe-camp layer in `wilds` (map editor + server radius in `TOWN_MAPS`), and send the Wilds to the least-full shard.
- **Room-level party** (`partyAsk`/`partyAnswer`/`partyState`).
- **Wilds rules:** respawn, scaling, kill credit, Wanted.
- **Kills:** batched into `pvp-result` (replay-safe like Tower batches).

**Phase 3: Teams**
- `pvp-queue` DO, the `arena` map, arena ticket fields in `town-ticket`, the match room flow, the results screen and the PvP window.

**Phase 4: Rewards**
- Trophy slot (`EQUIP_SLOTS`, items.ts + SQL rows, item tests), Arena vendor, titles, boards, statue and season rollover.

## Deploy order (each phase)
1. Apply the migration via MCP `apply_migration` (never `db push`). Verify grants via the catalog only.
2. Deploy the edge functions (`npx supabase@2`): `pvp-result`, `town-ticket`, `town-vitals`.
3. Deploy town-server **from clean main** (TOWN_PROTOCOL bump). For phase 3, this includes the wrangler `new_classes` migration and binding for the `PvpQueue` DO.
4. Deploy web (leaderboard), then the desktop release.

## Verification
- **Unit tests** in `packages/town-server/test` (pattern from `room.test.ts` / `bossroom.test.ts`):
  - Duel lifecycle and forfeit.
  - `canHurt` matrix (party, safe camp, non-duelist bystander).
  - CC diminishing returns.
  - Normalized stats.
  - Kill-credit dedupe.
  - Glicko-2 math in a shared test.
- **Integration:** `db reset` first, then `settle_pvp_match` caps and repeat-opponent decay. Compare against the known 5+2 failing baseline.
- **Local end-to-end:** `scripts/local.sh up` plus two `desktop` clients:
  - Duel in Town.
  - Fight in the Wilds, including camp safety.
  - Queue 2v2 with 4 local herzies.
- **Frame capture:** use the Playwright recipe to frame-step a duel and check that hits land only on the opponent.
