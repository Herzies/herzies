/**
 * The server-side game loop: the sync tick that awards XP, rolls drops,
 * matches events and returns the player's state.
 *
 * CANONICAL SOURCE, shared by the Next.js API and the Supabase edge functions.
 * This file used to exist twice — once here (as packages/web/src/lib/game-server.ts)
 * and once hand-copied under supabase/functions/_shared/ — and the two had
 * drifted: two different equipped-item checks, one of which silently failed to
 * detect a Good Eye Sniper stored as a bare string.
 *
 * `scripts/vendor-shared.mjs` now regenerates the edge copy from this file and
 * `pnpm check` fails if it is stale, so the copies cannot diverge again.
 *
 * RUNTIME CONSTRAINTS: no Node or Deno APIs. The one thing that needed the
 * runtime — the drop-test-mode env var — is passed in via SyncOptions by each
 * caller instead. Reached through the `@herzies/shared/server` export so the
 * desktop bundle never pulls this in.
 */
import {
  type ActiveMultiplier,
  applyXp,
  calculateXpGain,
  classifyGenre,
  DROP_CHANCE_PER_TICK,
  type EventNotification,
  filterDroppablePool,
  type FriendRequestSummary,
  getDailyCraving,
  goodEyeSniperBonus,
  hasRoomFor,
  isModifierEquipped,
  type Herzie,
  matchesCraving,
  NON_DROPPABLE_ITEM_IDS,
  normalizeEquipped,
  type PendingDrop,
  type PendingFriendRequest,
  type PendingTradeRequest,
  pickWeightedDrop,
  recordGenreMinutes,
  type SecretTrackConfig,
  type Stage,
  stageForLevel,
} from "./game-rules.js";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Good Eye Sniper occupies the modifier slot — an unbounded array, unlike
 * every other equip slot. */
function hasGoodEyeSniperEquipped(equipped: unknown): boolean {
  // Was an inline Array.isArray check here, which missed a `modifier` stored as
  // a bare string — normalizeEquipped coerces that to a single-element array,
  // so the Next.js copy detected a sniper the live edge path did not. Latent
  // rather than live (no herzie has a modifier equipped yet), but it is exactly
  // the class of drift the shared game-rules module exists to prevent.
  return isModifierEquipped(normalizeEquipped(equipped), "good-eye-sniper");
}

/** Spirit Orb occupies a ground slot (either side) and auto-collects pending
 * world drops so the user doesn't have to manually click to collect. */
function hasSpiritOrbEquipped(equipped: unknown): boolean {
  const e = normalizeEquipped(equipped);
  return e.ground_left === "spirit-orb" || e.ground_right === "spirit-orb";
}

/** Normalize a track string for fuzzy matching */
function normalizeTrack(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, "") // strip parenthetical: (Remastered), (feat. X)
    .replace(/\s*\[.*?\]\s*/g, "") // strip bracketed: [Deluxe Edition]
    .replace(/\s+-\s+.*$/, "") // strip Spotify dash suffix: " - Kantoi Version", " - Remastered 2011"
    .trim();
}

/** Check if a now_playing matches a secret track event config */
function matchesSecretTrack(
  title: string,
  artist: string,
  config: SecretTrackConfig,
): boolean {
  const normTitle = normalizeTrack(title);
  const normArtist = normalizeTrack(artist);
  const configTitle = normalizeTrack(config.trackTitle);
  const configArtist = normalizeTrack(config.trackArtist);

  return normTitle === configTitle && normArtist === configArtist;
}

/** Convert a Supabase herzie row to the shared Herzie type */
export function rowToHerzie(row: Record<string, unknown>): Herzie {
  return {
    id: row.id as string,
    name: row.name as string,
    createdAt: row.created_at as string,
    appearance: row.appearance as Herzie["appearance"],
    xp: row.xp as number,
    level: row.level as number,
    stage: row.stage as Stage,
    totalMinutesListened: row.total_minutes_listened as number,
    genreMinutes: (row.genre_minutes ?? {}) as Record<string, number>,
    friendCode: row.friend_code as string,
    friendCodes: (row.friend_codes ?? []) as string[],
    lastCravingDate: (row.last_craving_date ?? "") as string,
    lastCravingGenre: (row.last_craving_genre ?? "") as string,
    boostUntil: row.boost_until as number | undefined,
    streakDays: (row.streak_days ?? 0) as number,
    streakLastDate: (row.streak_last_date ?? null) as string | null,
    currency: (row.currency ?? 0) as number,
  };
}

/** Convert Herzie to DB update payload */
function herzieToRow(
  herzie: Herzie,
  nowPlaying: { title: string; artist: string; albumArtUrl?: string } | null,
) {
  return {
    xp: Math.floor(herzie.xp),
    level: herzie.level,
    stage: herzie.stage,
    total_minutes_listened: herzie.totalMinutesListened,
    genre_minutes: herzie.genreMinutes,
    last_craving_date: herzie.lastCravingDate,
    last_craving_genre: herzie.lastCravingGenre,
    now_playing: nowPlaying,
    streak_days: herzie.streakDays,
    streak_last_date: herzie.streakLastDate,
    last_synced_at: new Date().toISOString(),
  };
}

/**
 * Process a sync request from the CLI daemon.
 * This is the core game loop — server is the authority for XP and items.
 */
interface MultiplierSchedule {
  days: number[]; // 0=Sunday, 1=Monday, ..., 6=Saturday
  hourStart: number; // 0-23
  hourEnd: number; // 1-24 (exclusive)
}

/** Check if a schedule-based multiplier is active right now */
function isScheduleActive(schedule: MultiplierSchedule, now: Date): boolean {
  const day = now.getDay();
  const hour = now.getHours();
  return (
    schedule.days.includes(day) &&
    hour >= schedule.hourStart &&
    hour < schedule.hourEnd
  );
}

// fetchServerMultipliers() lived here. sync_context now applies its date-range
// filter in SQL and returns the rows; processSync applies the schedule filter
// with isScheduleActive above. The Next.js copy still has the function.

export interface SyncOptions {
  /** "cli" (default) applies wall-clock and per-sync caps. "spotify" skips them (dedup via play log). */
  source?: "cli" | "spotify";
  /**
   * Dev-only: roll for a drop on every sync instead of every 10 listened
   * minutes. Supplied by the caller (process.env in Next.js, Deno.env in the
   * edge functions) rather than read here, so this module stays runtime-
   * agnostic. Must never be true in production — it would drop an item on
   * every single sync.
   */
  dropTestMode?: boolean;
}

/**
 * Everything processSync reads up front, returned by the sync_context RPC
 * (00060_sync_context.sql) in a single round trip. Field names mirror the
 * columns/shapes the individual queries used to return, so the logic consuming
 * them is unchanged.
 */
interface SyncContext {
  herzie: Record<string, unknown> | null;
  multipliers: {
    name: string;
    bonus: number;
    schedule: MultiplierSchedule | null;
  }[];
  pending_drops: { id: string; item_id: string; dropped_at: string }[];
  active_hunts: { id: string; title: string }[];
  pending_trade: {
    tradeId: string;
    fromName: string;
    fromFriendCode: string;
  } | null;
  friend_requests: {
    requestId: string;
    incoming: boolean;
    name: string;
    friendCode: string;
    createdAt: string;
  }[];
}

export async function processSync(
  admin: SupabaseClient,
  userId: string,
  nowPlaying: {
    title: string;
    artist: string;
    genre?: string;
    albumArtUrl?: string;
  } | null,
  minutesListened: number,
  genres: string[],
  options: SyncOptions = {},
): Promise<{
  herzie: Herzie;
  notifications: EventNotification[];
  multipliers: ActiveMultiplier[];
  pendingTradeRequest?: PendingTradeRequest;
  pendingFriendRequest?: PendingFriendRequest;
  incomingFriendRequests: FriendRequestSummary[];
  outgoingFriendRequests: FriendRequestSummary[];
  pendingDrops: PendingDrop[];
  inventory: Record<string, number>;
  equipped: Record<string, unknown>;
}> {
  const source = options.source ?? "cli";
  // 1. Fetch everything this sync reads, in one round trip.
  //
  // This used to be 7-9 sequential queries spread through the function (the
  // herzie row here, then multipliers, pending drops, active hunts, a pending
  // trade plus its initiator's name, and friend requests plus the other
  // parties' names further down). At a 5s cadence per visible client that made
  // sync roughly 70% of all database traffic. sync_context
  // (00060_sync_context.sql) returns the lot as one jsonb document; the game
  // logic below is untouched and still runs here in TypeScript.
  const { data: ctxRaw, error } = await admin.rpc("sync_context", {
    p_user_id: userId,
  });
  const ctx = ctxRaw as SyncContext | null;

  const row = ctx?.herzie;
  if (error || !row) {
    throw new Error("Herzie not found for this user");
  }

  const herzie = rowToHerzie(row);
  const notifications: EventNotification[] = [];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Log track change to listen_log (CLI source only — Spotify logged in cron)
  if (source === "cli" && nowPlaying) {
    const prev = row.now_playing as { title?: string; artist?: string } | null;
    const trackChanged =
      !prev ||
      prev.title !== nowPlaying.title ||
      prev.artist !== nowPlaying.artist;
    if (trackChanged) {
      const classifiedGenre =
        genres.length > 0 ? classifyGenre(genres)[0] : undefined;
      await admin.from("listen_log").insert({
        user_id: userId,
        track_name: nowPlaying.title,
        artist_name: nowPlaying.artist,
        genre: classifiedGenre ?? nowPlaying.genre ?? null,
        album_art_url: nowPlaying.albumArtUrl ?? null,
        source: "cli",
      });
    }
  }

  // 2. Update daily streak (if user is listening)
  if (minutesListened > 0 && herzie.streakLastDate !== today) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    if (herzie.streakLastDate === yesterdayStr) {
      // Consecutive day — extend streak
      herzie.streakDays += 1;
    } else if (herzie.streakLastDate === today) {
      // Already counted today — no change
    } else {
      // Streak broken — reset to 1
      herzie.streakDays = 1;
    }
    herzie.streakLastDate = today;

    if (herzie.streakDays > 1) {
      notifications.push({
        type: "info",
        title: "Streak!",
        message: `${herzie.streakDays}-day streak! +${herzie.streakDays}% XP`,
      });
    }
  }

  // 3. Gather all active multipliers (includes migrated time-based ones).
  // The date-range filter ran in sync_context; the recurring-schedule filter
  // stays here because isScheduleActive reads the runtime's local day/hour.
  const serverMultipliers = (ctx.multipliers ?? [])
    .filter((m) => !m.schedule || isScheduleActive(m.schedule, now))
    .map((m) => ({ name: m.name, bonus: m.bonus }));

  // Add BOOST if active (stored on the herzie, not in multipliers table)
  const allMultipliers = [...serverMultipliers];
  if (herzie.boostUntil && now.getTime() < herzie.boostUntil) {
    allMultipliers.push({ name: "BOOST", bonus: 10.0 });
  }

  // Add streak bonus (1% per day)
  if (herzie.streakDays > 0) {
    allMultipliers.push({
      name: `${herzie.streakDays}-day streak`,
      bonus: herzie.streakDays * 0.01,
    });
  }

  // 4. Calculate and apply XP (server-authoritative)
  if (minutesListened > 0) {
    const classifiedGenres =
      genres.length > 0 ? classifyGenre(genres) : classifyGenre(["pop"]);
    const craving = getDailyCraving(herzie.id);
    const isCraving = genres.length > 0 && matchesCraving(genres, craving);

    let minutes = minutesListened;

    // CLI sync: cap to prevent abuse via rapid requests
    if (source === "cli") {
      // Cap at 10 minutes per sync hard limit
      minutes = Math.min(minutes, 10);

      // Cap to actual elapsed wall-clock time since last sync (+5s grace)
      const lastSyncedAt = row.last_synced_at as string | null;
      if (lastSyncedAt) {
        const elapsedMs = now.getTime() - new Date(lastSyncedAt).getTime();
        const elapsedMinutes = Math.max(0, elapsedMs / 60_000);
        minutes = Math.min(minutes, elapsedMinutes + 5 / 60);

        // Enforce minimum 8-second cooldown between syncs
        if (elapsedMs < 8_000) {
          minutes = 0;
        }
      }
    }
    // Spotify source: no caps — deduplication handled by spotify_play_log

    // Good Eye Sniper bonus (2% XP per song hunt won, capped at 30%) — only
    // queries the win count when both equipped and actually about to credit
    // XP this tick, since minutes is commonly 0 here (cooldown-throttled or
    // nothing billable) and this runs on every sync.
    if (minutes > 0 && hasGoodEyeSniperEquipped(row.equipped)) {
      const { data: songHuntWins, error: sniperError } = await admin.rpc(
        "count_song_hunt_wins",
        { p_user_id: userId },
      );
      // Skip the bonus (rather than treating a query error as 0 wins) so a
      // transient RPC failure can't silently zero out an earned bonus.
      if (!sniperError) {
        const bonus = goodEyeSniperBonus(songHuntWins as number);
        if (bonus > 0) {
          allMultipliers.push({ name: "Good Eye Sniper", bonus });
        }
      }
    }

    const xp = calculateXpGain(
      minutes,
      herzie.friendCodes.length,
      isCraving,
      allMultipliers,
    );

    const events = applyXp(herzie, xp);
    herzie.totalMinutesListened += minutes;
    recordGenreMinutes(herzie.genreMinutes, classifiedGenres, minutes);

    if (events.leveledUp) {
      notifications.push({
        type: "info",
        title: "Level Up!",
        message: `${herzie.name} is now level ${herzie.level}!`,
      });
    }
    if (events.evolved && events.newStage) {
      notifications.push({
        type: "info",
        title: "Evolution!",
        message: `${herzie.name} evolved to stage ${events.newStage}!`,
      });
    }
  }

  // 5. Roll for a world drop every 10 listened minutes, then auto-collect it
  // immediately if a Spirit Orb pet is equipped — any number of drops can be
  // pending on the ground at once (see the pending_drops table), so this no
  // longer waits for an earlier drop to be collected first. CDs come from
  // this pool too (with the highest drop weight, see
  // ITEM_DROP_WEIGHT_OVERRIDES) rather than being granted straight to
  // inventory — every item, CDs included, has to be picked up off the
  // ground.
  //
  // Dev-only test mode: HERZIES_DROP_TEST_MODE=1 rolls on every sync call
  // instead of every 10 listened minutes (DROP_CHANCE_PER_TICK is already 1
  // in production, so the only thing test mode changes is the cadence gate)
  // — since the sync daemon calls roughly every 10s, this gives a fast ~10s
  // drop cadence for local iteration. Must never be set on the deployed
  // function (it would drop an item on every single sync) — only set it via
  // `supabase functions serve --env-file` for local testing. Deliberately
  // skips drop_rolls_done bookkeeping in test mode so toggling it off
  // resumes normal cadence unaffected.
  const dropTestMode = options.dropTestMode ?? false;
  const totalDropRollsEligible = Math.floor(herzie.totalMinutesListened / 10);
  const dropRollsDone = (row.drop_rolls_done ?? 0) as number;
  // Whether this sync actually inserted a drop, which is the only case where
  // sync_context's pending_drops snapshot is stale.
  let rolledThisSync = false;

  if (dropTestMode || totalDropRollsEligible > dropRollsDone) {
    if (dropTestMode || Math.random() < DROP_CHANCE_PER_TICK) {
      const { data: pool } = await admin
        .from("items")
        .select("id, rarity")
        .not(
          "id",
          "in",
          `(${NON_DROPPABLE_ITEM_IDS.map((id) => `"${id}"`).join(",")})`,
        );
      // Rows come from the DB, not this shim's catalog mirror — filter out
      // any id/rarity that mirror doesn't recognize before feeding the
      // picker (see filterDroppablePool's doc comment for why this matters).
      const picked = pool
        ? pickWeightedDrop(filterDroppablePool(pool))
        : undefined;
      if (picked) {
        await admin.rpc("roll_pending_drop", {
          p_user_id: userId,
          p_item_id: picked.id,
        });
        rolledThisSync = true;
      }
    }
    // drop_rolls_done used to be its own UPDATE here. It is now folded into the
    // single herzie update in step 7 (see dropRollsToPersist) — same write,
    // one fewer round trip, and it can no longer land without the rest of the
    // sync's changes.
  }

  // sync_context already returned the drops standing on the ground. Only a roll
  // that actually inserted one invalidates that snapshot, and that happens at
  // most once per 10 listened minutes — so the common path costs no query here.
  let pendingDrops: PendingDrop[];
  if (rolledThisSync) {
    const { data: pendingDropRows } = await admin
      .from("pending_drops")
      .select("id, item_id, dropped_at")
      .eq("user_id", userId)
      .order("dropped_at", { ascending: true });
    pendingDrops = (pendingDropRows ?? []).map((r) => ({
      id: r.id as string,
      itemId: r.item_id as string,
      droppedAt: r.dropped_at as string,
    }));
  } else {
    pendingDrops = (ctx.pending_drops ?? []).map((r) => ({
      id: r.id,
      itemId: r.item_id,
      droppedAt: r.dropped_at,
    }));
  }

  if (pendingDrops.length > 0 && hasSpiritOrbEquipped(row.equipped)) {
    // Auto-collect only what the bank can hold. `collect_pending_drop` credits
    // inventory unconditionally, and an over-capacity item stays owned with no
    // grid slot to render in — so it would silently vanish from view. Anything
    // that doesn't fit stays on the ground (pending drops never expire) and is
    // retried next sync. `stackable` comes from the items table; `category`
    // isn't a column and every catalog item is "deck" today.
    const running = { ...((row.inventory_v2 ?? {}) as Record<string, number>) };
    const { data: dropItemRows } = await admin
      .from("items")
      .select("id, stackable")
      .in("id", [
        ...Object.keys(running),
        ...pendingDrops.map((d) => d.itemId),
      ]);
    const stackableById = new Map(
      (dropItemRows ?? []).map((r) => [r.id as string, !!r.stackable]),
    );
    const bankLookup = (id: string) => ({
      stackable: stackableById.get(id) ?? false,
      category: "deck" as const,
    });

    const uncollected: PendingDrop[] = [];
    for (const drop of pendingDrops) {
      if (
        !hasRoomFor(
          running,
          normalizeEquipped(row.equipped),
          drop.itemId,
          bankLookup,
        )
      ) {
        uncollected.push(drop);
        continue;
      }
      const { data: collectedId } = await admin.rpc("collect_pending_drop", {
        p_user_id: userId,
        p_drop_id: drop.id,
      });
      if (collectedId) {
        // Keep the running tally in step so the next iteration sees this one —
        // otherwise a full bank would still let the whole queue through.
        running[drop.itemId] = (running[drop.itemId] ?? 0) + 1;
        notifications.push({
          type: "item_granted",
          title: "Spirit Orb",
          message: `Your Spirit Orb collected: ${collectedId}`,
          itemId: collectedId as string,
          quantity: 1,
        });
      } else {
        uncollected.push(drop);
      }
    }
    pendingDrops = uncollected;
  }

  // Track which song-hunt announcements this user has already seen.
  const notifiedHunts = (row.notified_hunts ?? []) as string[];

  // 6. Match live now_playing against secret tracks / song hunts.
  // Skip Spotify catch-up sync — it has no real-time now_playing.
  if (source !== "spotify" && nowPlaying) {
    const eventNotifications = await checkSecretTrackEvents(
      admin,
      userId,
      nowPlaying.title,
      nowPlaying.artist,
      notifiedHunts,
    );
    notifications.push(...eventNotifications);
  }

  // 6b. First-finder notifications for song hunts
  {
    // Came from sync_context; same filter, no query here.
    const activeHunts = ctx.active_hunts ?? [];
    {
      for (const hunt of activeHunts) {
        if (notifiedHunts.includes(hunt.id)) continue;

        // Check if user already claimed this hunt (they'd get the item_granted notif instead)
        const { data: ownClaim } = await admin
          .from("event_claims")
          .select("id")
          .eq("event_id", hunt.id)
          .eq("user_id", userId)
          .maybeSingle();

        if (ownClaim) continue;

        // Check if anyone has found it
        const { data: firstClaim } = await admin
          .from("event_claims")
          .select("user_id")
          .eq("event_id", hunt.id)
          .order("claimed_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (!firstClaim) continue;

        // Get the finder's name
        const { data: finderHerzie } = await admin
          .from("herzies")
          .select("name")
          .eq("user_id", firstClaim.user_id as string)
          .single();

        const finderName = (finderHerzie?.name as string) ?? "Someone";
        notifications.push({
          type: "info",
          title: hunt.title as string,
          message: `${finderName} found the song! Find it yourself to claim your reward.`,
        });
        notifiedHunts.push(hunt.id);
      }
    }
  }

  // 7. Update the herzie in DB
  // Spotify catch-up: don't overwrite now_playing (it may be stale)
  const npPayload =
    source !== "spotify" && nowPlaying
      ? {
          title: nowPlaying.title,
          artist: nowPlaying.artist,
          albumArtUrl: nowPlaying.albumArtUrl,
        }
      : null;
  const updateData: Record<string, unknown> = {
    ...herzieToRow(herzie, npPayload),
    notified_hunts: notifiedHunts,
  };
  // Folded in from step 5's former standalone UPDATE. Test mode deliberately
  // skips the bookkeeping so toggling it off resumes the normal cadence.
  if (!dropTestMode && totalDropRollsEligible > dropRollsDone) {
    updateData.drop_rolls_done = totalDropRollsEligible;
  }
  if (source === "spotify") {
    // Don't overwrite now_playing for spotify catch-up
    delete updateData.now_playing;
  }
  // Return the post-update row so the response can carry authoritative
  // inventory/equipped. Every inventory mutation in this sync (Spirit Orb
  // auto-collect, event reward grants) has already committed by this point, and
  // `updateData` never touches inventory_v2/equipped — so this reflects them,
  // and piggybacking on the update costs no extra round trip.
  const { data: syncedRow } = await admin
    .from("herzies")
    .update(updateData)
    .eq("user_id", userId)
    .select("inventory_v2, equipped")
    .single();

  // 8. Pending trade request — resolved with the initiator's name in
  // sync_context, which was previously two queries here.
  const pendingTradeRequest = ctx.pending_trade ?? undefined;

  // 9. Pending friend requests — also resolved in sync_context (two queries
  // before: the requests, then the other parties' names). loadFriendRequests
  // is still exported and used by callers outside this sync path.
  const incomingFriendRequests: FriendRequestSummary[] = [];
  const outgoingFriendRequests: FriendRequestSummary[] = [];
  for (const fr of ctx.friend_requests ?? []) {
    const summary: FriendRequestSummary = {
      requestId: fr.requestId,
      friendCode: fr.friendCode,
      name: fr.name,
      createdAt: fr.createdAt,
    };
    if (fr.incoming) incomingFriendRequests.push(summary);
    else outgoingFriendRequests.push(summary);
  }

  const pendingFriendRequest: PendingFriendRequest | undefined =
    incomingFriendRequests[0]
      ? {
          requestId: incomingFriendRequests[0].requestId,
          fromName: incomingFriendRequests[0].name,
          fromFriendCode: incomingFriendRequests[0].friendCode,
        }
      : undefined;

  return {
    herzie,
    notifications,
    multipliers: allMultipliers,
    pendingTradeRequest,
    pendingFriendRequest,
    incomingFriendRequests,
    outgoingFriendRequests,
    pendingDrops,
    // Carried on the regular sync cadence so clients don't have to re-fetch
    // /inventory after every mutation. Falls back to the pre-update row if the
    // returning select came back empty.
    inventory: (syncedRow?.inventory_v2 ?? row.inventory_v2 ?? {}) as Record<
      string,
      number
    >,
    // Raw, not normalized — same convention as /api/inventory. The desktop
    // client normalizes at its own boundary (see useOptimisticEquipped).
    equipped: (syncedRow?.equipped ?? row.equipped ?? {}) as Record<
      string,
      unknown
    >,
  };
}

/**
 * Load all pending friend requests for a user, resolving the other party's
 * name and friend code for display. Incoming requests are ordered newest-first
 * so the first entry can drive the prompt overlay / notification.
 */
export async function loadFriendRequests(
  admin: SupabaseClient,
  userId: string,
): Promise<{
  incomingFriendRequests: FriendRequestSummary[];
  outgoingFriendRequests: FriendRequestSummary[];
}> {
  const { data: rows } = await admin
    .from("friend_requests")
    .select("id, from_user_id, to_user_id, created_at")
    .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (!rows || rows.length === 0) {
    return { incomingFriendRequests: [], outgoingFriendRequests: [] };
  }

  const otherIds = Array.from(
    new Set(
      rows.map((r) =>
        r.from_user_id === userId ? r.to_user_id : r.from_user_id,
      ),
    ),
  );

  const { data: profiles } = await admin
    .from("herzies")
    .select("user_id, name, friend_code")
    .in("user_id", otherIds);

  const byUser = new Map(
    (profiles ?? []).map((p) => [
      p.user_id as string,
      { name: p.name as string, friendCode: p.friend_code as string },
    ]),
  );

  const incomingFriendRequests: FriendRequestSummary[] = [];
  const outgoingFriendRequests: FriendRequestSummary[] = [];

  for (const row of rows) {
    const incoming = row.to_user_id === userId;
    const otherId = incoming ? row.from_user_id : row.to_user_id;
    const profile = byUser.get(otherId as string);
    if (!profile) continue;
    const summary: FriendRequestSummary = {
      requestId: row.id as string,
      friendCode: profile.friendCode,
      name: profile.name,
      createdAt: row.created_at as string,
    };
    if (incoming) incomingFriendRequests.push(summary);
    else outgoingFriendRequests.push(summary);
  }

  return { incomingFriendRequests, outgoingFriendRequests };
}

/**
 * Check if the currently playing track matches any active secret track events.
 * If it does and the user hasn't claimed it yet, grant the reward.
 */
async function checkSecretTrackEvents(
  admin: SupabaseClient,
  userId: string,
  title: string,
  artist: string,
  notifiedHunts: string[],
): Promise<EventNotification[]> {
  const notifications: EventNotification[] = [];
  const now = new Date().toISOString();

  // Fetch active secret track events
  const { data: events } = await admin
    .from("events")
    .select("*")
    .in("type", ["secret_track", "song_hunt"])
    .eq("active", true)
    .lte("starts_at", now)
    .gte("ends_at", now);

  if (!events || events.length === 0) return notifications;

  for (const event of events) {
    const config = event.config as SecretTrackConfig;
    if (!matchesSecretTrack(title, artist, config)) continue;

    // Check total claims against maxClaims
    const { count: totalClaims } = await admin
      .from("event_claims")
      .select("*", { count: "exact", head: true })
      .eq("event_id", event.id);

    const maxClaims = (config.maxClaims as number | undefined) ?? Infinity;
    if ((totalClaims ?? 0) >= maxClaims) continue;

    // Check if this user already claimed
    const { data: existingClaim } = await admin
      .from("event_claims")
      .select("id")
      .eq("event_id", event.id)
      .eq("user_id", userId)
      .single();

    if (existingClaim) continue;

    // Grant the reward!
    const { error: claimError } = await admin
      .from("event_claims")
      .insert({ event_id: event.id, user_id: userId });

    if (claimError) continue; // race condition — someone else claimed first

    // Add item to inventory_v2 atomically
    await admin.rpc("grant_inventory_item", {
      p_user_id: userId,
      p_item_id: config.rewardItemId,
      p_quantity: 1,
    });

    // Resolve human-readable item name (falls back to the id if missing).
    const { data: itemRow } = await admin
      .from("items")
      .select("name")
      .eq("id", config.rewardItemId)
      .maybeSingle();
    const itemName =
      (itemRow?.name as string | undefined) ?? config.rewardItemId;

    const eventTitle = (event.title as string | null) ?? "Song Hunt";
    const isSongHunt = event.type === "song_hunt";
    const isFirstFinder = (totalClaims ?? 0) === 0;

    const winMessage = isSongHunt
      ? isFirstFinder
        ? `You won! You found "${config.trackTitle}" first.`
        : `You found the song! You solved "${config.trackTitle}".`
      : `You discovered the secret track "${config.trackTitle}"! You earned a collectible!`;

    // Native + log: the win / discovery line.
    notifications.push({
      type: "item_granted",
      title: eventTitle,
      message: winMessage,
      itemId: config.rewardItemId,
      quantity: 1,
    });

    // Log-only: the reward line. Desktop skips the native popup for this.
    notifications.push({
      type: "item_granted",
      title: eventTitle,
      message: `You received: ${itemName}`,
      itemId: config.rewardItemId,
      quantity: 1,
      logOnly: true,
    });

    if (isSongHunt) {
      // One-time bonus: the first time a user wins any song hunt, grant the
      // Good Eye Sniper (cosmetic, tracks their song-hunt win count via a
      // live query — never re-granted, so duplicate copies never pile up).
      const { data: sniperRow } = await admin
        .from("herzies")
        .select("inventory_v2")
        .eq("user_id", userId)
        .single();
      const alreadyOwnedSniper =
        ((sniperRow?.inventory_v2 as Record<string, number> | null)?.[
          "good-eye-sniper"
        ] ?? 0) > 0;
      if (!alreadyOwnedSniper) {
        await admin.rpc("grant_inventory_item", {
          p_user_id: userId,
          p_item_id: "good-eye-sniper",
          p_quantity: 1,
        });
      }
    }

    if (isSongHunt && !notifiedHunts.includes(event.id as string)) {
      notifiedHunts.push(event.id as string);
    }
  }

  return notifications;
}
