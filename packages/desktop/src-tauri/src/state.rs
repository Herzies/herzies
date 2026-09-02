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
    pub last_track_key: Option<String>,
    pub enrichment: Option<TrackEnrichment>,
    pub enrichment_requested_at: Option<Instant>,
    pub enrichment_in_flight: bool,
    /// Album art from the system Now Playing session (`data:` URL), when available.
    pub system_album_art_url: Option<String>,
    /// Last known result of a `/sync` round-trip. The frontend's connectivity
    /// indicator is derived from this *plus* `ms_since_reachable` so that
    /// successful traffic on other endpoints (chat, inventory, …) instantly
    /// recovers the indicator without waiting for the next sync tick.
    pub last_sync_ok: bool,
    /// Cached wearables for the home 3D view (persisted locally, refreshed from API).
    pub equipped: HashMap<String, String>,
    /// Latest chat messages for the home feed (refreshed from API).
    pub chat_messages: Vec<ChatMessage>,
    /// Cached inventory (`None` until first successful fetch).
    pub inventory: Option<Inventory>,
    pub inventory_currency: u32,
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
    /// Bumped on every local `friend_codes` mutation (add/accept/remove). A
    /// `sync_tick` captures this before its network call; if it changes while
    /// the request is in flight, the (now-stale) server `friend_codes` is not
    /// applied so it can't clobber a just-accepted friend.
    pub friend_epoch: u64,
}

impl ManagedState {
    pub fn new(herzie: Option<Herzie>) -> Self {
        let friend_codes: Vec<String> = herzie
            .as_ref()
            .map(|h| h.friend_codes.clone())
            .unwrap_or_default();
        let (inventory, inventory_currency) = match crate::storage::load_inventory_cache() {
            Some((inv, cur)) => (Some(inv), cur),
            None => (None, 0),
        };
        Self {
            herzie,
            pending_minutes: crate::storage::load_pending_minutes(),
            current_now_playing: None,
            current_genres: Vec::new(),
            current_local_genre: None,
            last_track_key: None,
            enrichment: None,
            enrichment_requested_at: None,
            enrichment_in_flight: false,
            system_album_art_url: None,
            last_sync_ok: true,
            equipped: crate::storage::load_equipped(),
            chat_messages: Vec::new(),
            inventory,
            inventory_currency,
            friends: crate::storage::load_friends_cache(&friend_codes),
            pending_trade_request: None,
            pending_friend_request: None,
            incoming_friend_requests: Vec::new(),
            outgoing_friend_requests: Vec::new(),
            friend_epoch: 0,
        }
    }

    /// Mark that the local `friend_codes` set just changed so any `/sync`
    /// already in flight won't overwrite it with stale server data.
    pub fn bump_friend_epoch(&mut self) {
        self.friend_epoch = self.friend_epoch.wrapping_add(1);
    }

    pub fn clear_app_cache(&mut self) {
        self.equipped.clear();
        self.chat_messages.clear();
        self.inventory = None;
        self.inventory_currency = 0;
        self.friends.clear();
        self.pending_trade_request = None;
        self.pending_friend_request = None;
        self.incoming_friend_requests.clear();
        self.outgoing_friend_requests.clear();
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
        if self.pending_minutes <= 0.01 {
            return Some(herzie.clone());
        }

        let craving = crate::game::get_daily_craving(&herzie.id, None);
        let is_craving = !self.current_genres.is_empty()
            && crate::game::matches_craving(&self.current_genres, &craving);
        // Same no-multiplier estimate the old local-application path used —
        // a display approximation only; the server remains authoritative.
        let xp_gain = crate::game::calculate_xp_gain(
            self.pending_minutes,
            herzie.friend_codes.len(),
            is_craving,
            &[],
        );
        let (xp, level, stage) =
            crate::game::project_xp(herzie.xp, herzie.level, herzie.stage, xp_gain);

        let mut projected = herzie.clone();
        projected.xp = xp;
        projected.level = level;
        projected.stage = stage;
        projected.total_minutes_listened += self.pending_minutes;
        Some(projected)
    }

    pub fn to_app_state(&self, version: &str) -> AppState {
        let is_logged_in = crate::api::is_logged_in();
        AppState {
            herzie: self.display_herzie(),
            now_playing: self.current_now_playing.clone(),
            multipliers: crate::storage::load_multipliers(),
            is_online: is_logged_in,
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
            friends: self.friends.clone(),
            pending_trade_request: self.pending_trade_request.clone(),
            pending_friend_request: self.pending_friend_request.clone(),
            incoming_friend_requests: self.incoming_friend_requests.clone(),
            outgoing_friend_requests: self.outgoing_friend_requests.clone(),
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

#[cfg(test)]
mod tests {
    use super::*;

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
            total_minutes_listened: 0.0,
            genre_minutes: HashMap::new(),
            friend_code: "ABCD".to_string(),
            friend_codes: Vec::new(),
            last_craving_date: String::new(),
            last_craving_genre: String::new(),
            boost_until: None,
            streak_days: 0,
            streak_last_date: None,
            currency: 0,
        }
    }

    fn test_state(herzie: Option<Herzie>, pending_minutes: f64) -> ManagedState {
        ManagedState {
            herzie,
            pending_minutes,
            current_now_playing: None,
            current_genres: Vec::new(),
            current_local_genre: None,
            last_track_key: None,
            enrichment: None,
            enrichment_requested_at: None,
            enrichment_in_flight: false,
            system_album_art_url: None,
            last_sync_ok: true,
            equipped: HashMap::new(),
            chat_messages: Vec::new(),
            inventory: None,
            inventory_currency: 0,
            friends: HashMap::new(),
            pending_trade_request: None,
            pending_friend_request: None,
            incoming_friend_requests: Vec::new(),
            outgoing_friend_requests: Vec::new(),
            friend_epoch: 0,
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
