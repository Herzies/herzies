use crate::lastfm::TrackEnrichment;
use crate::types::*;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

pub struct ManagedState {
    pub herzie: Option<Herzie>,
    pub pending_minutes: f64,
    pub current_now_playing: Option<NowPlayingDisplay>,
    pub current_genres: Vec<String>,
    /// Genre from Apple Music (empty for Spotify).
    pub current_local_genre: Option<String>,
    /// Whether the current track's source is trusted on its own (see
    /// `media_remote_adapter::is_trusted_music_source`). Fed into
    /// `is_confirmed_listen` in `poll_tick`, which gates `current_now_playing`
    /// itself — an unconfirmed browser/YouTube play shows up nowhere (not
    /// this device's own widget, not the server, no listen_log entry) until
    /// Last.fm confirms it.
    pub source_verified: bool,
    pub last_track_key: Option<String>,
    pub enrichment: Option<TrackEnrichment>,
    pub enrichment_requested_at: Option<Instant>,
    pub enrichment_in_flight: bool,
    /// Album art from the system Now Playing session (`data:` URL), when available.
    pub system_album_art_url: Option<String>,
    /// Current artist's portrait photo (Spotify), fetched via our backend.
    /// Cleared and re-fetched only when the artist actually changes, so
    /// consecutive tracks by the same artist (e.g. an album) don't flicker.
    pub artist_image_url: Option<String>,
    /// Last known result of a `/sync` round-trip. The frontend's connectivity
    /// indicator is derived from this *plus* `ms_since_reachable` so that
    /// successful traffic on other endpoints (chat, inventory, …) instantly
    /// recovers the indicator without waiting for the next sync tick.
    pub last_sync_ok: bool,
    /// Cached wearables for the home 3D view (persisted locally, refreshed from API).
    pub equipped: HashMap<String, serde_json::Value>,
    /// Latest chat messages for the home feed (refreshed from API).
    pub chat_messages: Vec<ChatMessage>,
    /// Cached inventory (`None` until first successful fetch).
    pub inventory: Option<Inventory>,
    pub inventory_currency: u32,
    /// Dice-upgrade levels (itemId -> 0-3), cached the same way as
    /// `inventory` — see MAX_ITEM_UPGRADE_LEVEL in @herzies/shared.
    pub item_upgrades: ItemUpgrades,
    /// Every owned copy of every item, each with its own level and worn slot
    /// — the source of truth that `inventory`, `equipped` and `item_upgrades`
    /// are derived from server-side. Cached alongside them.
    pub units: Vec<ItemUnit>,
    /// Inventory Expansions the player has bought — see `bankCapacity` in
    /// @herzies/shared. Only the sync loop sets it: the purchase completes in
    /// the browser and is credited by the Stripe webhook, so no response the app
    /// makes carries it. Cached so the grid opens at its real size.
    pub bank_expansions: u32,
    /// Emotes owned, from the last `/inventory` (which the Premium window
    /// refetches on coming back from checkout). Not cached: it's an empty
    /// Alt bar for the moment before that first fetch.
    pub emotes: Vec<String>,
    /// The Crystal (CrystalState in @herzies/shared), from the last sync or
    /// attune that carried it. Passed through as-is; see `accept_crystal`.
    pub crystal: Option<serde_json::Value>,
    /// What the herzie's XP comes to once an attune's payout lands, and
    /// when it was paid. The XP goes through `pending_xp`, so the server
    /// only adds it on the next sync; until then (or a minute) the UI shows
    /// at least this much, so the exp bar fills the moment you attune and
    /// a sync that left before the attune can't drag it back.
    pub xp_floor: Option<(f64, std::time::Instant)>,
    /// The class skills, from the last sync that carried them.
    pub skills: Vec<HerzieSkill>,
    /// Friend profiles keyed by friend code (persisted when codes match).
    pub friends: HashMap<String, HerzieProfile>,
    /// Latest incoming trade from `/sync` (cleared when absent on a successful sync).
    pub pending_trade_request: Option<PendingTradeRequest>,
    /// Newest incoming friend request from `/sync` (drives the prompt overlay).
    pub pending_friend_request: Option<PendingFriendRequest>,
    /// All pending friend requests sent to you (Requests tab).
    pub incoming_friend_requests: Vec<FriendRequestSummary>,
    /// All pending friend requests you sent (Add friend tab).
    pub outgoing_friend_requests: Vec<FriendRequestSummary>,
    /// Pending world drops from `/sync` — any number can be outstanding at
    /// once (replaced wholesale with the server's list on every sync, e.g.
    /// emptied after a Spirit Orb auto-collects them all).
    pub pending_drops: Vec<PendingDrop>,
    /// Drops being picked up, by drop id, until the server's state shows them
    /// (see collects.rs).
    pub collects: HashMap<String, crate::collects::PendingCollect>,
    /// Bumped on every local `friend_codes` mutation (add/accept/remove). A
    /// `sync_tick` captures this before its network call; if it changes while
    /// the request is in flight, the (now-stale) server `friend_codes` is not
    /// applied so it can't clobber a just-accepted friend.
    pub friend_epoch: u64,
    /// Bumped on every local `pending_drops` replacement (debug spawn, an
    /// attune's drops). Same purpose as `friend_epoch`: a `sync_tick` captures
    /// this before its network call, and skips applying the (now-stale)
    /// server `pendingDrops` if it changed while the request was in flight.
    /// Pickups don't bump it: `collects` covers them, over any snapshot.
    pub drop_epoch: u64,
    /// Bumped on every local `equipped` mutation (equip/unequip). Same purpose
    /// as `friend_epoch`: an `/inventory` fetch captures this before its
    /// network call, and `apply_inventory` skips the (now-stale) server
    /// `equipped` if it changed while the request was in flight — otherwise an
    /// equip that completes mid-fetch gets undone by a response that was
    /// issued before it happened, which the desktop UI sees as the item
    /// popping back off.
    pub equip_epoch: u64,
    /// Bumped on every local `inventory` mutation (sell, buy; not pickups,
    /// which `collects` re-applies over any snapshot). Same purpose as `friend_epoch`: `sync_tick` captures this
    /// before its network call and skips the response's `inventory` if it
    /// moved, so a sync issued before the mutation can't reinstate the old
    /// contents. Distinct from `equip_epoch`/`drop_epoch` because buying
    /// changes inventory without touching either.
    pub inventory_epoch: u64,
    /// Bumped when a local call sets the coin balance from its response (a
    /// sell, a purchase, a quest hand-in). `sync_tick` skips the response's
    /// balance if it moved, so a sync issued before the change can't put the
    /// old balance back until the one after.
    pub currency_epoch: u64,
    /// Bumped when a local call changes the Crystal (attune, upgrade, shards
    /// from a quest). `sync_tick` skips the response's Crystal if it moved.
    pub crystal_epoch: u64,
    /// Bumped whenever a trade invite arrives over Realtime
    /// (`trade_request_ingest`). Same purpose as `friend_epoch`: `sync_tick`
    /// captures it before its network call and skips the response's
    /// `pending_trade_request` if it moved — otherwise a sync issued just
    /// before the trade was created hides the invite the broadcast just
    /// showed, and the next sync notifies about it again.
    pub trade_epoch: u64,
    /// Active XP multipliers from the last `/sync`. Held here (and persisted
    /// for the next launch) rather than re-read from disk by every
    /// `to_app_state`, which runs every few seconds under this state's lock.
    pub multipliers: Option<Vec<ActiveMultiplier>>,
    /// When `pending_minutes` was last persisted. `poll_tick` grows it every
    /// few seconds; writing it each time was a disk write per tick, so it is
    /// throttled (see `PENDING_MINUTES_SAVE_EVERY` in lib.rs) and flushed on
    /// quit/relaunch.
    pub pending_minutes_saved_at: Option<Instant>,
    /// When the current track started (as `poll_tick` first saw it). Decides
    /// whether a track played long enough to be flushed to the server when it
    /// ends — see `OutgoingTrack` in lib.rs.
    pub track_started_at: Option<Instant>,
    /// See `AppState::logging_in`.
    pub logging_in: bool,
}

impl ManagedState {
    pub fn new(herzie: Option<Herzie>) -> Self {
        let friend_codes: Vec<String> = herzie
            .as_ref()
            .map(|h| h.friend_codes.clone())
            .unwrap_or_default();
        let (inventory, inventory_currency, item_upgrades, units, bank_expansions) =
            match crate::storage::load_inventory_cache() {
                Some((inv, cur, upgrades, units, expansions)) => {
                    (Some(inv), cur, upgrades, units, expansions)
                }
                None => (None, 0, ItemUpgrades::new(), Vec::new(), 0),
            };
        Self {
            herzie,
            pending_minutes: crate::storage::load_pending_minutes(),
            current_now_playing: None,
            current_genres: Vec::new(),
            current_local_genre: None,
            source_verified: false,
            last_track_key: None,
            enrichment: None,
            enrichment_requested_at: None,
            enrichment_in_flight: false,
            system_album_art_url: None,
            artist_image_url: None,
            last_sync_ok: true,
            equipped: crate::storage::load_equipped(),
            chat_messages: Vec::new(),
            inventory,
            inventory_currency,
            item_upgrades,
            units,
            bank_expansions,
            emotes: Vec::new(),
            crystal: None,
            xp_floor: None,
            skills: Vec::new(),
            friends: crate::storage::load_friends_cache(&friend_codes),
            pending_trade_request: None,
            pending_friend_request: None,
            incoming_friend_requests: Vec::new(),
            outgoing_friend_requests: Vec::new(),
            pending_drops: Vec::new(),
            collects: HashMap::new(),
            friend_epoch: 0,
            drop_epoch: 0,
            equip_epoch: 0,
            inventory_epoch: 0,
            currency_epoch: 0,
            crystal_epoch: 0,
            trade_epoch: 0,
            multipliers: crate::storage::load_multipliers(),
            pending_minutes_saved_at: None,
            track_started_at: None,
            logging_in: false,
        }
    }

    /// Mark that the local `pending_drops` list just changed so any `/sync`
    /// already in flight won't overwrite it with stale server data.
    pub fn bump_drop_epoch(&mut self) {
        self.drop_epoch = self.drop_epoch.wrapping_add(1);
    }

    /// Mark that the local `friend_codes` set just changed so any `/sync`
    /// already in flight won't overwrite it with stale server data.
    pub fn bump_friend_epoch(&mut self) {
        self.friend_epoch = self.friend_epoch.wrapping_add(1);
    }

    /// Mark that the local `equipped` map just changed so any `/inventory`
    /// fetch already in flight won't overwrite it with stale server data.
    pub fn bump_equip_epoch(&mut self) {
        self.equip_epoch = self.equip_epoch.wrapping_add(1);
    }

    /// Mark that the local `inventory` just changed so any `/sync` already in
    /// flight won't overwrite it with stale server data.
    pub fn bump_inventory_epoch(&mut self) {
        self.inventory_epoch = self.inventory_epoch.wrapping_add(1);
    }

    /// The coin balance a call's response reported, everywhere it's shown:
    /// the herzie, and `inventory_currency`, which the bag reads first.
    pub fn set_currency(&mut self, currency: u32) {
        self.inventory_currency = currency;
        if let Some(ref mut herzie) = self.herzie {
            herzie.currency = currency;
            crate::storage::save_herzie(herzie);
        }
        self.currency_epoch = self.currency_epoch.wrapping_add(1);
    }

    /// Shards granted by a call whose response doesn't carry the Crystal (a
    /// quest hand-in), shown now rather than at the next sync.
    pub fn add_crystal_shards(&mut self, shards: u64) -> bool {
        let Some(crystal) = self.crystal.as_mut().and_then(|c| c.as_object_mut()) else {
            return false;
        };
        let held = crystal.get("shards").and_then(|v| v.as_u64()).unwrap_or(0);
        crystal.insert("shards".into(), serde_json::json!(held + shards));
        self.crystal_epoch = self.crystal_epoch.wrapping_add(1);
        true
    }

    pub fn clear_app_cache(&mut self) {
        self.equipped.clear();
        self.chat_messages.clear();
        self.inventory = None;
        self.inventory_currency = 0;
        self.item_upgrades.clear();
        self.units.clear();
        self.bank_expansions = 0;
        self.emotes.clear();
        self.friends.clear();
        self.pending_trade_request = None;
        self.pending_friend_request = None;
        self.incoming_friend_requests.clear();
        self.outgoing_friend_requests.clear();
        self.pending_drops.clear();
        self.collects.clear();
        crate::storage::clear_equipped();
        crate::storage::clear_inventory_cache();
        crate::storage::clear_friends_cache();
    }

    /// The herzie to show in the UI: the last server-confirmed record, plus an
    /// optimistic display-only projection of xp/level/stage/minutes from
    /// listening time accrued since the last successful sync
    /// (`pending_minutes`). This projection is never written to disk — only
    /// `sync_tick` persists confirmed xp/level/stage, so there's a single
    /// writer for those fields and nothing for a later sync to clobber.
    fn display_herzie(&self) -> Option<Herzie> {
        let herzie = self.herzie.as_ref()?;
        // An attune's XP, shown before the sync that lands it.
        let floor = self
            .xp_floor
            .filter(|(xp, at)| *xp > herzie.xp && at.elapsed().as_secs() < 60)
            .map(|(xp, _)| xp);
        if let Some(floor) = floor {
            let (xp, level, stage) =
                crate::game::project_xp(herzie.xp, herzie.level, herzie.stage, floor - herzie.xp);
            let mut paid = herzie.clone();
            paid.xp = xp;
            paid.level = level;
            paid.stage = stage;
            paid.total_minutes_listened += self.pending_minutes.max(0.0);
            return Some(paid);
        }
        if self.pending_minutes <= 0.01 {
            return Some(herzie.clone());
        }

        let mut projected = herzie.clone();
        // With the Crystal on, listening XP waits in the Crystal rather than
        // landing on the herzie: projecting it here would tick the exp bar
        // up only for the next sync to put it back.
        let crystal_on = self
            .crystal
            .as_ref()
            .and_then(|c| c["enabled"].as_bool())
            .unwrap_or(false);
        if !crystal_on {
            // Same no-multiplier estimate the old local-application path used —
            // a display approximation only; the server remains authoritative.
            let xp_gain = crate::game::calculate_xp_gain(self.pending_minutes, &[]);
            let (xp, level, stage) =
                crate::game::project_xp(herzie.xp, herzie.level, herzie.stage, xp_gain);
            projected.xp = xp;
            projected.level = level;
            projected.stage = stage;
        }
        projected.total_minutes_listened += self.pending_minutes;
        Some(projected)
    }

    pub fn to_app_state(&self, version: &str) -> AppState {
        let is_logged_in = crate::api::is_logged_in();
        AppState {
            herzie: self.display_herzie(),
            now_playing: self.current_now_playing.clone(),
            multipliers: self.multipliers.clone(),
            // Withheld until a login finishes loading, so the renderer sees
            // the logged-in transition once, with the herzie already there.
            is_online: is_logged_in && !self.logging_in,
            is_connected: compute_is_connected(
                is_logged_in,
                self.last_sync_ok,
                crate::api::ms_since_reachable(),
            ),
            version: version.to_string(),
            equipped: self.equipped.clone(),
            chat_messages: self.chat_messages.clone(),
            inventory: self.inventory.clone(),
            inventory_currency: self.inventory_currency,
            item_upgrades: self.item_upgrades.clone(),
            units: self.units.clone(),
            bank_expansions: self.bank_expansions,
            emotes: self.emotes.clone(),
            crystal: self.crystal.clone(),
            skills: self.skills.clone(),
            friends: self.friends.clone(),
            pending_trade_request: self.pending_trade_request.clone(),
            pending_friend_request: self.pending_friend_request.clone(),
            incoming_friend_requests: self.incoming_friend_requests.clone(),
            outgoing_friend_requests: self.outgoing_friend_requests.clone(),
            pending_drops: self.pending_drops.clone(),
            logging_in: self.logging_in,
        }
    }
}

pub type SharedState = Mutex<ManagedState>;

/// Pure helper so the connectivity rule is testable without touching the
/// session-on-disk or the global reachable atomic.
///
/// Rule: we're "connected" when the user is logged in AND either the last
/// `/sync` succeeded OR we've gotten *any* HTTP response from the server
/// recently. The grace window lets non-sync traffic (chat fetch, inventory)
/// keep the indicator green even if `/sync` itself just hiccuped.
pub fn compute_is_connected(
    is_logged_in: bool,
    last_sync_ok: bool,
    ms_since_reachable: u64,
) -> bool {
    is_logged_in && (last_sync_ok || ms_since_reachable < crate::api::REACHABLE_GRACE_MS)
}

/// The Crystal is on and its resonance holds all it can (or more).
pub fn crystal_full(crystal: &serde_json::Value) -> bool {
    let capacity = crystal["capacity"].as_f64().unwrap_or(0.0);
    crystal["enabled"].as_bool().unwrap_or(false)
        && capacity > 0.0
        && crystal["fill"].as_f64().unwrap_or(0.0) >= capacity
}

/// The resonance filled up between two pictures of the Crystal: worth a
/// notification. Only a change seen this session counts: with no picture
/// before (just launched), a Crystal that's already full says nothing, so
/// every launch doesn't announce it again.
pub fn crystal_became_full(before: Option<&serde_json::Value>, after: &serde_json::Value) -> bool {
    before.is_some_and(|b| !crystal_full(b)) && crystal_full(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quest_shards_show_at_once_and_hold_off_a_stale_sync() {
        let mut s = ManagedState::new(None);
        // No Crystal yet (feature off): nothing to add to.
        assert!(!s.add_crystal_shards(3));
        s.crystal = Some(serde_json::json!({ "attunes": 2, "shards": 4 }));
        let before = s.crystal_epoch;
        assert!(s.add_crystal_shards(3));
        assert_eq!(s.crystal.as_ref().unwrap()["shards"], 7);
        assert_ne!(s.crystal_epoch, before);
    }

    #[test]
    fn set_currency_sets_the_balance_the_bag_reads() {
        let mut s = ManagedState::new(None);
        let before = s.currency_epoch;
        s.set_currency(512);
        assert_eq!(s.inventory_currency, 512);
        assert_ne!(s.currency_epoch, before);
    }

    fn crystal(enabled: bool, fill: f64, capacity: f64) -> serde_json::Value {
        serde_json::json!({ "enabled": enabled, "fill": fill, "capacity": capacity })
    }

    #[test]
    fn crystal_filling_up_is_announced_once() {
        assert!(crystal_became_full(
            Some(&crystal(true, 179.0, 180.0)),
            &crystal(true, 180.0, 180.0)
        ));
        // Overcharging on from full: already said.
        assert!(!crystal_became_full(
            Some(&crystal(true, 180.0, 180.0)),
            &crystal(true, 190.0, 180.0)
        ));
        // Still charging.
        assert!(!crystal_became_full(
            Some(&crystal(true, 10.0, 180.0)),
            &crystal(true, 20.0, 180.0)
        ));
    }

    #[test]
    fn crystal_full_at_launch_or_switched_off_is_quiet() {
        assert!(!crystal_became_full(None, &crystal(true, 180.0, 180.0)));
        assert!(!crystal_became_full(
            Some(&crystal(false, 0.0, 180.0)),
            &crystal(false, 180.0, 180.0)
        ));
        assert!(!crystal_became_full(
            Some(&crystal(true, 0.0, 0.0)),
            &crystal(true, 0.0, 0.0)
        ));
    }

    #[test]
    fn crystal_grown_past_its_fill_can_fill_again() {
        // An upgrade raised the capacity: no longer full, so the next fill
        // is news again.
        assert!(!crystal_full(&crystal(true, 180.0, 240.0)));
        assert!(crystal_became_full(
            Some(&crystal(true, 180.0, 240.0)),
            &crystal(true, 240.0, 240.0)
        ));
    }

    #[test]
    fn logged_out_is_never_connected() {
        assert!(!compute_is_connected(false, true, 0));
        assert!(!compute_is_connected(false, false, u64::MAX));
    }

    #[test]
    fn logged_in_with_successful_sync_is_connected() {
        assert!(compute_is_connected(true, true, u64::MAX));
    }

    #[test]
    fn logged_in_with_failed_sync_but_recent_reachable_is_connected() {
        // The bug fix: /sync failed (last_sync_ok=false) but chat/inventory
        // just succeeded — we should still appear connected.
        assert!(compute_is_connected(true, false, 1_000));
    }

    #[test]
    fn logged_in_with_failed_sync_and_stale_reachable_is_offline() {
        assert!(!compute_is_connected(
            true,
            false,
            crate::api::REACHABLE_GRACE_MS
        ));
        assert!(!compute_is_connected(true, false, u64::MAX));
    }

    fn test_herzie(xp: f64, level: u32, stage: u32) -> Herzie {
        Herzie {
            id: "test-id".to_string(),
            name: "Test".to_string(),
            created_at: "2024-01-01".to_string(),
            appearance: HerzieAppearance {
                head_index: 0,
                eyes_index: 0,
                mouth_index: 0,
                accessory_index: 0,
                limbs_index: 0,
                body_index: 0,
                legs_index: 0,
                color_scheme: "default".to_string(),
            },
            xp,
            level,
            stage,
            class: None,
            stat_points: None,
            total_minutes_listened: 0.0,
            genre_minutes: HashMap::new(),
            friend_code: "ABCD".to_string(),
            friend_codes: Vec::new(),
            last_craving_date: String::new(),
            last_craving_genre: String::new(),
            streak_days: 0,
            streak_last_date: None,
            currency: 0,
            share_listening: true,
        }
    }

    fn test_state(herzie: Option<Herzie>, pending_minutes: f64) -> ManagedState {
        ManagedState {
            herzie,
            pending_minutes,
            current_now_playing: None,
            current_genres: Vec::new(),
            current_local_genre: None,
            source_verified: false,
            last_track_key: None,
            enrichment: None,
            enrichment_requested_at: None,
            enrichment_in_flight: false,
            system_album_art_url: None,
            artist_image_url: None,
            last_sync_ok: true,
            equipped: HashMap::new(),
            chat_messages: Vec::new(),
            inventory: None,
            inventory_currency: 0,
            item_upgrades: ItemUpgrades::new(),
            units: Vec::new(),
            bank_expansions: 0,
            emotes: Vec::new(),
            crystal: None,
            xp_floor: None,
            skills: Vec::new(),
            friends: HashMap::new(),
            pending_trade_request: None,
            pending_friend_request: None,
            incoming_friend_requests: Vec::new(),
            outgoing_friend_requests: Vec::new(),
            pending_drops: Vec::new(),
            collects: HashMap::new(),
            friend_epoch: 0,
            drop_epoch: 0,
            equip_epoch: 0,
            inventory_epoch: 0,
            currency_epoch: 0,
            crystal_epoch: 0,
            trade_epoch: 0,
            multipliers: None,
            pending_minutes_saved_at: None,
            track_started_at: None,
            logging_in: false,
        }
    }

    #[test]
    fn display_herzie_matches_confirmed_when_no_pending_minutes() {
        let confirmed = test_herzie(500.0, 3, 1);
        let state = test_state(Some(confirmed.clone()), 0.0);
        let displayed = state.display_herzie().unwrap();
        assert_eq!(displayed.xp, confirmed.xp);
        assert_eq!(displayed.level, confirmed.level);
    }

    #[test]
    fn display_herzie_projects_forward_with_pending_minutes() {
        let confirmed = test_herzie(500.0, 3, 1);
        let state = test_state(Some(confirmed.clone()), 5.0);
        let displayed = state.display_herzie().unwrap();
        assert!(displayed.xp >= confirmed.xp);
        assert!(displayed.level >= confirmed.level);
        assert!(displayed.total_minutes_listened > confirmed.total_minutes_listened);
    }

    #[test]
    fn display_herzie_never_persists_projection() {
        let confirmed = test_herzie(500.0, 3, 1);
        let state = test_state(Some(confirmed.clone()), 5.0);
        let _ = state.display_herzie();
        // The projection is display-only — the underlying stored herzie must
        // be untouched by computing it.
        assert_eq!(state.herzie.as_ref().unwrap().xp, confirmed.xp);
        assert_eq!(state.herzie.as_ref().unwrap().level, confirmed.level);
    }

    #[test]
    fn display_herzie_none_when_no_herzie() {
        let state = test_state(None, 5.0);
        assert!(state.display_herzie().is_none());
    }
}

impl ManagedState {
    /// Take a Crystal state from the server unless it's older than the one we
    /// hold: a sync that left before an attune comes back with the Crystal as
    /// it was, and must not refill the one that was just emptied. Every attune
    /// bumps `attunes`, so a lower count is always the older picture.
    pub fn accept_crystal(&mut self, next: &serde_json::Value) -> bool {
        if !next.is_object() {
            return false;
        }
        let held = self
            .crystal
            .as_ref()
            .and_then(|c| c["attunes"].as_u64())
            .unwrap_or(0);
        if next["attunes"].as_u64().unwrap_or(0) < held {
            return false;
        }
        self.crystal = Some(next.clone());
        true
    }
}
