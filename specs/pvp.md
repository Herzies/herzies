# PvP scope: Wilds, Duels, Teams

## Context
Herzies has PvE combat only: bosses, the Tower, mobs and dummies. The user wants PvP in three modes, each with a reason to play it:
- **Wilds**: open PvP on the existing Wilds island.
- **Duel**: 1v1, started anywhere.
- **Teams**: matchmade team fights.

Decisions the user made:
- ~~Dying in the Wilds costs only time.~~ Reversed 2026-11-21: **taken down on the Wilds, you drop one random card from your bag** (see Wilds below). Everywhere else (duels, Teams) dying still costs only time.
- The Wilds are always PvP except a safe camp around the spawn and Sky Dock.
- ~~Rewards are **cosmetic only**.~~ Reversed 2026-11-21: **the Wilds have real loot**: Wilds-only bits (crafting materials) from caches, takedowns and listening there; Wilds instruments crafted from bits, stronger than the class instruments; tuning with bits; and +50% listening XP while you're there. Duel and Team rewards stay cosmetic.
- Teams use an **always-on queue**.

**Status:** Duels (phase 1) are built: `packages/shared/src/duel.ts` (rules), `packages/town-server/src/duel.ts` (the judge), the desktop's `components/town/duel/`, and `duel_results` / `record_duel` (migration 00152) for title credit. The Wilds' free-for-all (phase 2) is built without Marks, parties or Wanted: `packages/shared/src/wilds-pvp.ts` (rules), `packages/town-server/src/wilds.ts` (the judge; `pvp.ts` holds what it shares with duels) and the desktop's `components/town/wilds/`. Its loot is built too: `packages/shared/src/wilds-loot.ts` (bits, recipes, tuning, caches, drops, the listening bonus), `packages/town-server/src/wilds-loot.ts` (the room's side), migration 00154 with `town-vitals`' `wildsDrop`/`wildsTake`/`wildsReturn`/`wildsCache` actions, and `/api/wilds/craft` + `/api/wilds/tune`. Teams are still a plan. Titles (`packages/shared/src/titles.ts`) shipped alongside, as a general feats system rather than PvP-only rewards. The next free migration number is in `supabase/migrations`, not here.

## What we build on (found in code)
- **In the boss room and Tower, casts are already judged on the server.**
  - The client sends only aim (yaw/pitch).
  - `FightRuntime.cast` (`packages/town-server/src/fight.ts:672`) → `BossEngine.cast` / `spendCast` (`boss.ts:860/894`) handles it, using lag-compensated positions from `history.ts` (`PositionHistory`, rewind 120 ms).
  - The math is `hitDamage`, `meleeReaches`, `discChain` and aim assist in `packages/shared/src/combat.ts`.
  - Damage to herzies goes through `mitigatedHit` (`boss.ts:1634`: 30% max-HP cap per hit, `defReduction`, 75% reduction clamp) and `takeHits` (`fight.ts:1691`: domes, KOs, `hp`/`down` broadcasts).
- **Everywhere else (home, wilds) there is no server combat.** `room.fight` is null, casts are only a 3-bit visual counter, and `onCast` strikes the socket (`room.ts:829`). Training dummies are hit client-side. **PvP needs a new lightweight server-side engine for normal rooms that reuses those pieces.** This is the core of phase 1.
- **Rooms:**
  - `packages/town-server/src/index.ts` routes `/v1/town/<map>?shard=n[&i=]`.
  - `TOWN_INSTANCED_MAPS` rooms are named `map:<instance>` (only the Tower today; `room.ts:773` checks `instance === uid`). A team match is an instanced map named by a match id, with a `match` ticket claim (the same pattern as the `boss`/`tower` claims in `town-ticket`).
  - Shard choice happens on the client and goes to the first room that fits (40 cap), so friends can land on different shards. That's fine for duels, since you can only challenge who you see. It also suits the Wilds: first-fit keeps players together on one shard until it's full.
- **No terrain on the server.** It knows only `radius`/`spawn`, with no collision, elevation or line of sight. **v1 accepts no line-of-sight checks** (the duel ring and `stage` are flat). A coarse check using the Wilds `heights` grid is a later polish item.
- **Tickets:** HMAC `TownTicketPayload` (`shared/src/town-net.ts:119`) already carries stats, level, class, skills and HP, so the server has everything it needs to judge PvP. `TOWN_PROTOCOL = 4` → bump to **5**.
- **Wilds:** a rest map with benches and no combat flag. It has no portal: it's reached and left only by the sky ship, Sofia III (a "wilds" event runs her; she leaves each dock every `departEverySec`, 96–1200 s, default 120), and whoever's there when she won't call again is sent back to Town.
- **Move guard.** `rules.ts` checks speed and edges against `TOWN_MAPS` (`wilds: radius 83, spawn -66.5,0.5`; the camp and Sky Dock are on its west rim, facing Town).
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
2. **Fairness comes from normalization, not gear.** Ranked duels and Teams flatten stats to a class template (GW2 model). Gear shows only as looks there, so the Wilds' stronger instruments buy nothing in them. The Wilds use real stats, with these limits:
   - The existing `MAX_HIT_FRACTION 0.3` (no one-shots).
   - The attacker's Sonic Power is capped to the victim's level band (victim level + 10).
3. **Anti-grief without killing the zone.**
   - Safe camp around the spawn and Sky Dock.
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

### Duel (phase 1, built)
Shaped from an industry survey (WoW, ESO, FFXIV, OSRS, Lost Ark, BDO, New World, GW2, plus fighting-game and shooter feel). The numbers live in `DUEL` (`shared/src/duel.ts`); this is the why.
- **Start a duel:** click a herzie's name → "Challenge to duel". You must stand within **8 units** (server-checked against positions it knows, +1.5 slack), roughly WoW's 9.9 yd interact range: you walk up to someone you can see. The target gets an in-Town card showing your level and class, with Accept/Decline, a **20 s** drain, and "Block duels from…". The pair must still be within 20 units when it's accepted.
- **Anti-spam:** one outgoing challenge at a time; 5 s between challenges; 30 s per pair after a decline or no answer, 5 min after a second decline within 10 min. Settings has "Duel requests: Everyone / Friends only / Nobody" (ESO's default-off auto-decline drew harassment complaints, so this one is easy to find). Copy stays neutral: "didn't answer", "declined", "yielded" (never "fled").
- **Where it happens:** in place. A ring of radius **14** (12 left disc users no room to kite) drops between the two, pulled in to fit the map. Both are put on marks 6 units either side of the centre, which removes the "opener" problem duel tournaments write pages of rules about.
- **Countdown:** a VS card (skipped on a rematch), then 3-2-1-FIGHT at 0.8 s each, timed from the server's clock. Moving and casting are held; aiming isn't.
- **Who it affects:** only the two duelists can hurt, heal or buff each other. Everyone else can watch: the ring and both health bars are visible to the room.
- **Fight:** casts and skills are judged by the server exactly like PvE casts, with the opponent as a herzie body. Gear still matters (Sonic Power, crits, Timing), but three duel-only levers keep classes even: duel health comes from level alone (Stamina made Percussionists outlast everyone), Def counts at 15%, and the PvE disc/stick bonuses don't apply (discs deal 0.85 of a wave). A matrix test holds every class pairing at 15–30 s to kill at levels 20 and 40, with neither side more than 1.33× faster. One hit never takes more than 30% of max HP; Rimshot stuns at half strength with diminishing returns; Taunt and Resurrect do nothing. Leaving the ring for **3 s** yields (paused while stunned), and hits from outside the ring don't count.
- **Time:** 90 s, then sudden death (+25% damage, −50% healing, compounding every 10 s). At 150 s the higher share of health wins, or it's a draw.
- **Losing:** you kneel; you're not KO'd. All duel HP is room-local: it starts full, is never reported to `town-vitals`, and never sends anyone home. Stored PvE HP is untouched, and nothing is dropped: a duel costs only time.
- **Leaving:** yield or changing map ends it at once. A dropped connection has 10 s to come back; a drop during the countdown cancels the duel.
- **After:** VICTORY/DEFEAT banner, a room line `"A" defeated "B" in a duel`, and Rematch (both must click within 12 s) or GG.
- **Credit:** every finished duel is posted to `town-vitals` (`record_duel`, replay-safe). A win counts towards titles only if the fight lasted 15 s, the loser dealt 10% of the winner's max HP, the levels are within 10, and it's the first such win over that opponent that day.
- **Ranked duels:** not built. When they come, they use the normalized stat template below and Glicko-2.
- **Where duels are blocked:** boss cave, the Tower, and the Wilds (everyone there already fights; a ring of radius 14 won't fit in the camp of radius 15 without spilling into the free-for-all).

### Wilds (phase 2, built)
Reached by sky ship (`wilds.ts`); the numbers live in `WILDS_PVP` (`shared/src/wilds-pvp.ts`) and, for the loot, `shared/src/wilds-loot.ts`.
- **Where:** PvP is on everywhere in `wilds` except the safe camp, `WILDS_SAFE_CAMP` (a circle of radius 15 round the spawn and the Sky Dock). A blow cast from the camp, or landing on someone in it (now or 120 ms before, in the defender's favour), doesn't count.
- **Judging:** casts and skills go through the same judge as a duel's (lag-compensated aim at the first herzie in the way, the cast budget, a Slinger's disc hands). Health, damage, Def and attack shares are a duel's (`duelMaxHp`, `duelDamage` in regulation): every class pairing stays 15–30 s to bring down. PvP health lives in the room only: never sent to `town-vitals`, never a knock-out in the database.
- **Level scaling:** the attacker's Sonic Power is capped at what a herzie at the victim's level + 10 could have (every point in Sonic Power, plus 40 for gear), and the 30% max-HP-per-hit cap applies.
- **Skills:** Rimshot stuns at half a mob's stun with the usual diminishing returns; Taunt and Resurrect are refused (`wilds`); Drones heal only yourself; a Cymbrella's dome shelters only its owner. No contact damage.
- **On KO:** you lie where you fell for **6 s**, then get up at the spawn (in the camp) with full health. The killer, the victim and anyone within 40 units get a line, `Took down "Name"`. While a "wilds" event runs you also drop a card (below).
- **Spawn protection:** **5 s** after arriving or getting up, or until you attack from outside the camp.
- **Out of combat** (10 s since you last took or dealt PvP damage) health comes back at 4% of max a second (about 25 s from nothing): longer than getting up in camp, so walking away hurt costs something.
- **Combat logging:** leaving within 10 s of taking PvP damage counts as being taken down (the last hitter gets the line); PvP health (or time left down) is kept per uid for 30 s, so a reconnect doesn't heal. No sky ship takes you aboard for those 10 s (the gangway stops you, client-side), and the room holds you to a fight's move rules (no hop onto the spawn).
- **Taken down, you drop a card.** While a "wilds" event runs (the ticket's `wilds` claim: the room keeps the newest), a herzie taken down (or leaving mid-fight, which counts the same) drops **one random card from its bag** where it fell: not worn, not held by a loadout, one copy from a stack, picked uniformly over bag tiles. The room posts `wildsDrop` (its own uuid); `town-vitals` escrows the copy (upgrade level and all) and the room shows it to everyone, telling the victim what it lost. Whoever took it down has it alone for **15 s**, then anyone within reach (1.8, judged on the room's positions) may take it, if their bag has room. Taking it is a choice: in reach of a card you may take, the app offers "Pick up … [E]"; walking over it leaves it lying. Unclaimed after **2 min**, it goes **back to its owner** (`wildsReturn` on the room's sweep; the database settles any a dead room left behind, on the next wilds call or the owner's next sync). One take at a time; a failed ask refuses (`not-yet`) and changes nothing.
- **Bits:** Tonewood, Sky String, Storm Hide and Resonite (common to legendary), stackable, found only on the Wilds: in caches, from listening there, and in bags dropped by herzies taken down.
- **Caches:** one turns up every **5 min** (the first a minute in) while the event runs, at a spot out of the camp (its whole ring too), announced to the room; each shard has its own. A cache is **held, not clicked**: it opens for the first herzie to stay **on their feet within 5 units of it for 10 s**, so you have to defend it. Stepping out of the ring (a holder may stand 0.5 past its edge before it counts as out) or going down starts your hold over from nothing; while **two or more** up herzies are in the ring it's **contested** and nobody's hold counts on (each keeps what they had) till only one is left. The room judges all of it from the positions it already has (no client message) and tells everyone `wildsHold {id, holders: [{id, ms}], contested, at}` on each change (step in/out, down, contested or not; at most every 250 ms, never as it counts) and in the newcomer's `wildsLoot` (`hold`); the app counts the lone holder's progress on from `at`, and draws the ring on the ground (yours filling in gold, anyone else's in red, flashing red while contested) with a HUD line ("Opening the cache… 7 s" / "Contested!"). The full hold gets a handful of bits, now and then a Power Die or a Safety Pick, as pending drops picked up the usual way; the database opens each cache once, so a race between two rooms has one winner. If the database doesn't answer, the holder hears `wildsRefused` (`not-yet`), the cache stays and their hold drops back 2 s, to ask again. Unopened, the next replaces it.
- **Wilds instruments:** one for each class instrument (Wildwood Lute, Stormcut Discs, Thunderhide Sticks, Storm Cymbal), about half as strong again. Crafted from the base instrument (used up, its upgrade level carried over) plus bits; they play exactly like the base (same attack, same skills).
- **Tuning:** spend bits to raise any class or Wilds instrument's upgrade level, up to **+6**; it never fails and never breaks anything. Past +6, Power Dice as ever.
- **Listening bonus:** **+50% listening XP** while you're on the Wilds, and half the listening drops rolled there are bits. The room reports who's there (holding the event's claim, inside its window) with its 30 s sweep; each report counts for 75 s.
- **What drops on the Wilds stays there.** A cache's loot and what listening drops while you're there (`pending_drops.wilds`, migration 00159) are yours, but lie on the Wilds' ground: unlike the Tower's or the cave's, they don't follow you to the next island. The app shows them only on the Wilds (a cache's where it fountained them, coming back), and a worn spirit's sync sweep takes them only while the room says you're there. A full bag refuses the pickup, walked up to or fetched by a spirit: it stays lying there. Once their event is over they're gone (`collect_pending_drop` won't hand one over; the owner's next sync clears them). The Wilds' ground has its own cap of ten listening drops, apart from the rest.
- **Still to come:** Marks per credited kill and streak bonuses, the Wanted bounty, kill-credit dedupe (once per victim per 10 min), parties (a party id in the room, members friendly), and batching kills into `pvp-result`.

### Teams (phase 3)
- **Queue:** an always-on queue from a PvP window (new tab in the Events/Menu area). Solo or party.
- **Server:**
  - A new **`pvp-queue` Durable Object** (single instance, in the town-server worker) holds the queue, runs widening matching every 2 s, and creates a match id.
  - Clients then fetch a ticket from `town-ticket?map=stage&match=<id>`. The ticket checks the match with the DO and signs `match`, `team` and `norm: true`.
  - v1 is a solo queue. Party queueing (premades matched against premades or against solos with a rating handicap) comes in phase 3b.
- **Map:** a new instanced map **`stage`**, a small symmetric concert stage built in the map editor. Its room is `stage:<matchId>`.
- **Format:** 2v2 (later 3v3). First team to 5 KOs, 4 s respawns at a team base, 5 min limit, and the tiebreak is total damage.
- **When it ends:** the room posts the result to a new `pvp-result` edge function (service role). That function updates Glicko-2, match history and rewards. A results screen shows MVP, damage, healing, blocked and KOs.

## Incentives (cosmetic, outside the Wilds' loot)
- **Marks**
  - A new PvP currency (`herzies.pvp_marks`, service-role write). Earned in all modes, with the caps above.
  - Spent at a new **Arena vendor NPC** in Town, on cosmetics only: trophy items, PvP-themed cloaks/back items, emotes such as Bow and Taunt-dance, and auras.
- **New item type: Trophy** (new equip slot `trophy`)
  - Shows as a small floating badge/banner over the herzie in Town and on the profile card. It's visible to everyone, so it's a status signal.
  - Comes in tiered seasonal trophies: Bronze/Silver/Gold/Platinum/Herzie Legend, based on peak rating. The season's year/month is printed on the item.
  - Duel-streak and Wanted-hunter trophies are awarded once.
  - Uses the per-copy `item_units` row so it records the season. Not tradable, not sellable (`NON_DROPPABLE_ITEM_IDS`).
- **Titles** (the system exists: `shared/src/titles.ts`, `herzie_titles`, worn under the name and carried in the ticket as `ti`)
  - Duels already grant "Duelist", "Battle of the Bands", "Dueling Banjos" and "Encore".
  - Still to add with their modes: "Wanted", "Arena Champion".
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
- **Map:** a safe-camp layer in `wilds` (map editor + server radius in `TOWN_MAPS`), and send the Wilds to the least-full shard. (The Wilds are reached by sky ship, not a portal.)
- **Room-level party** (`partyAsk`/`partyAnswer`/`partyState`).
- **Wilds rules:** respawn, scaling, kill credit, Wanted.
- **Kills:** batched into `pvp-result` (replay-safe like Tower batches).

**Phase 3: Teams**
- `pvp-queue` DO, the `stage` map, `match` ticket fields in `town-ticket`, the match room flow, the results screen and the PvP window.

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
