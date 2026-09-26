use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HerzieAppearance {
    pub head_index: u32,
    pub eyes_index: u32,
    pub mouth_index: u32,
    pub accessory_index: u32,
    pub limbs_index: u32,
    pub body_index: u32,
    pub legs_index: u32,
    pub color_scheme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Herzie {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub appearance: HerzieAppearance,
    pub xp: f64,
    pub level: u32,
    pub stage: u32,
    pub total_minutes_listened: f64,
    pub genre_minutes: HashMap<String, f64>,
    pub friend_code: String,
    pub friend_codes: Vec<String>,
    pub last_craving_date: String,
    pub last_craving_genre: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boost_until: Option<u64>,
    pub streak_days: u32,
    pub streak_last_date: Option<String>,
    pub currency: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HerzieProfile {
    pub name: String,
    pub friend_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_rank: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_total: Option<u32>,
    pub stage: u32,
    pub level: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<HerzieAppearance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_artists: Option<Vec<TopArtist>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equipped: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub now_playing: Option<ProfileNowPlaying>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_played: Option<ProfileLastPlayed>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub song_hunt_wins: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopArtist {
    pub name: String,
    pub plays: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileNowPlaying {
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_art_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileLastPlayed {
    pub title: String,
    pub artist: String,
    pub listened_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_art_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct SyncRequest {
    pub now_playing: Option<NowPlayingPayload>,
    pub minutes_listened: f64,
    pub genres: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingPayload {
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    /// Last.fm's remote artwork URL only — never the local system/data: URL
    /// (see `sync_tick`), which can be a multi-MB base64 blob unfit for the
    /// server or other viewers' clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_art_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub herzie: Herzie,
    pub notifications: Vec<EventNotification>,
    pub multipliers: Vec<ActiveMultiplier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_trade_request: Option<PendingTradeRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_friend_request: Option<PendingFriendRequest>,
    #[serde(default)]
    pub incoming_friend_requests: Vec<FriendRequestSummary>,
    #[serde(default)]
    pub outgoing_friend_requests: Vec<FriendRequestSummary>,
    #[serde(default)]
    pub pending_drops: Vec<PendingDrop>,
    /// Authoritative inventory, carried on every sync so mutations don't each
    /// have to re-fetch `/inventory`. `None` only when talking to a server
    /// older than this field.
    #[serde(default)]
    pub inventory: Option<Inventory>,
    /// Authoritative equip state, carried for the same reason as `inventory`.
    #[serde(default)]
    pub equipped: Option<HashMap<String, serde_json::Value>>,
    /// Dice-upgrade levels (itemId -> 0-3), carried for the same reason as
    /// `inventory` — see MAX_ITEM_UPGRADE_LEVEL in @herzies/shared.
    #[serde(default)]
    pub item_upgrades: Option<ItemUpgrades>,
    /// Every owned copy of every item, each with its own upgrade level and
    /// worn slot. The source of truth — `inventory`, `equipped` and
    /// `item_upgrades` above are derived from these server-side. `None` only
    /// when talking to a server older than this field.
    #[serde(default)]
    pub units: Option<Vec<ItemUnit>>,
    /// Inventory Expansions owned — see `bankCapacity` in @herzies/shared.
    /// `None` only when talking to a server older than this field, in which
    /// case the local count is left alone.
    #[serde(default)]
    pub bank_expansions: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTradeRequest {
    pub trade_id: String,
    pub from_name: String,
    pub from_friend_code: String,
}

/// A world drop waiting to be collected — removed from the list once picked
/// up (manually, by id, or automatically by an equipped Spirit Orb).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDrop {
    pub id: String,
    pub item_id: String,
    pub dropped_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFriendRequest {
    pub request_id: String,
    pub from_name: String,
    pub from_friend_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequestSummary {
    pub request_id: String,
    pub friend_code: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendSearchResult {
    pub friend_code: String,
    pub name: String,
    pub level: u32,
    pub relationship: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveMultiplier {
    pub name: String,
    pub bonus: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventNotification {
    #[serde(rename = "type")]
    pub notification_type: String,
    pub title: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_only: Option<bool>,
}

/// A trade offer as stored and shown: the copies being given (each snapshotted
/// with its level, so the other side sees "+3 Box of Boom" before accepting),
/// plus the same offer counted by item id. `items` is the only field an offer
/// made before copies existed has, so `units` is empty for those.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeOffer {
    #[serde(default)]
    pub items: HashMap<String, u32>,
    #[serde(default)]
    pub units: Vec<OfferedUnit>,
    pub currency: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferedUnit {
    pub unit_id: String,
    pub item_id: String,
    #[serde(default)]
    pub upgrade_level: u32,
}

/// What this player sends to change their side of a trade: the copies to give,
/// by id. The server snapshots them into a `TradeOffer`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeOfferRequest {
    pub units: Vec<String>,
    pub currency: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    pub id: String,
    pub initiator_id: String,
    pub target_id: String,
    pub initiator_name: String,
    pub target_name: String,
    pub initiator_offer: TradeOffer,
    pub target_offer: TradeOffer,
    pub state: String,
    pub initiator_accepted: bool,
    pub target_accepted: bool,
    pub created_at: String,
    pub expires_at: String,
}

pub type Inventory = HashMap<String, u32>;

/// All the item state the server reports at once — what `/inventory` returns
/// and what every inventory-changing call (sell, buy, equip, upgrade) answers
/// with. Applied to local state as a unit so the copies and the id-keyed views
/// derived from them never disagree.
#[derive(Debug, Clone)]
pub struct ItemSnapshot {
    pub inventory: Inventory,
    pub currency: u32,
    pub equipped: HashMap<String, serde_json::Value>,
    pub item_upgrades: ItemUpgrades,
    /// `None` when the server predates copies, in which case the local ones are
    /// left as they are rather than cleared.
    pub units: Option<Vec<ItemUnit>>,
}

/// One owned copy of an item — the unit of ownership. It is what a bank tile
/// is, what gets sold, traded and worn, and what a dice upgrade lands on.
/// Mirrors `ItemUnit` in @herzies/shared.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemUnit {
    pub id: String,
    pub item_id: String,
    #[serde(default)]
    pub upgrade_level: u32,
    /// A stored slot key, `"modifier"`, or `None` while it sits in the bank.
    #[serde(default)]
    pub equipped_slot: Option<String>,
}

/// Dice-upgrade levels (itemId -> 0-3) — see MAX_ITEM_UPGRADE_LEVEL in
/// @herzies/shared.
pub type ItemUpgrades = HashMap<String, u32>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreProduct {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub currency_amount: u32,
    pub price_nok_ore: u32,
}

/// A catalog item sold for real money rather than coins. Carries no name or
/// art: the app already has those in its own catalog under `item_id`, which
/// is the whole point of joining on the id (see /api/store/premium). The
/// exception is the Inventory Expansion, whose `item_id` is
/// `BANK_EXPANSION.id` in @herzies/shared rather than a catalog id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PremiumItem {
    pub item_id: String,
    pub price_id: String,
    /// Minor units in `currency` (e.g. 3900 = 39.00). Not assumed to be NOK.
    pub amount: u32,
    /// ISO 4217 code, lowercase, as Stripe returns it.
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub user_id: String,
}

/// State sent to the renderer
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub herzie: Option<Herzie>,
    pub now_playing: Option<NowPlayingDisplay>,
    pub multipliers: Option<Vec<ActiveMultiplier>>,
    pub is_online: bool,
    pub is_connected: bool,
    pub version: String,
    pub equipped: HashMap<String, serde_json::Value>,
    pub chat_messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory: Option<Inventory>,
    pub inventory_currency: u32,
    /// Dice-upgrade levels (itemId -> 0-3) — see MAX_ITEM_UPGRADE_LEVEL in
    /// @herzies/shared.
    #[serde(default)]
    pub item_upgrades: ItemUpgrades,
    /// Every owned copy — see `ItemUnit`. The desktop UI reads this wherever
    /// copies have to be told apart; `inventory`/`equipped` remain as the
    /// derived id-keyed views.
    #[serde(default)]
    pub units: Vec<ItemUnit>,
    /// Inventory Expansions owned; the grid's capacity is
    /// `bankCapacity(bankExpansions)` in @herzies/shared.
    #[serde(default)]
    pub bank_expansions: u32,
    pub friends: HashMap<String, HerzieProfile>,
    /// Present while the server reports an incoming trade you have not joined yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_trade_request: Option<PendingTradeRequest>,
    /// Newest incoming friend request you haven't responded to (drives the overlay).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_friend_request: Option<PendingFriendRequest>,
    /// Friend requests sent to you that are still pending.
    pub incoming_friend_requests: Vec<FriendRequestSummary>,
    /// Friend requests you sent that are still pending.
    pub outgoing_friend_requests: Vec<FriendRequestSummary>,
    /// World drops waiting to be collected (each removed once collected).
    pub pending_drops: Vec<PendingDrop>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingDisplay {
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_art_url: Option<String>,
    /// Artist portrait photo (Spotify), for the now-playing bar's background.
    /// Unlike `album_art_url`, this is keyed by artist only, so it lags one
    /// async round-trip behind a track change rather than resetting to `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vibe: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub title: String,
    pub description: Option<String>,
    pub active: bool,
    pub starts_at: String,
    pub ends_at: String,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveEventsResponse {
    pub events: Vec<GameEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub user_id: String,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friend_code: Option<String>,
    pub content: String,
    #[serde(default)]
    pub item_refs: Vec<String>,
    #[serde(default)]
    pub user_refs: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatFetchResponse {
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSendResponse {
    pub message: ChatMessage,
}

/// Full now-playing info from osascript
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct NowPlayingInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub duration: f64,
    pub elapsed: f64,
    pub is_playing: bool,
    pub source: String,
    pub volume: i32,
    /// Whether the source is a known music player (so this listen counts
    /// without further checks) as opposed to an unverified one (mainly
    /// browser web players, including YouTube) that needs Last.fm to confirm
    /// the track is real before it counts toward XP.
    pub verified: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_item_unit_reads_with_only_its_identity() {
        let u: ItemUnit = serde_json::from_str(r#"{"id":"a","itemId":"cd"}"#).unwrap();
        assert_eq!(u.upgrade_level, 0);
        assert_eq!(u.equipped_slot, None);
    }

    #[test]
    fn an_item_unit_serializes_camel_case_for_the_frontend() {
        let u = ItemUnit {
            id: "a".into(),
            item_id: "boombox".into(),
            upgrade_level: 2,
            equipped_slot: Some("modifier".into()),
        };
        let v = serde_json::to_value(&u).unwrap();
        assert_eq!(v["itemId"], "boombox");
        assert_eq!(v["upgradeLevel"], 2);
        assert_eq!(v["equippedSlot"], "modifier");
    }

    // An offer made before copies existed has only `items`; it must still parse
    // (an in-flight trade, or the other player on an older client).
    #[test]
    fn a_trade_offer_from_before_copies_existed_still_parses() {
        let o: TradeOffer = serde_json::from_str(r#"{"items":{"cd":2},"currency":10}"#).unwrap();
        assert_eq!(o.items["cd"], 2);
        assert!(o.units.is_empty());
        assert_eq!(o.currency, 10);
    }

    #[test]
    fn a_trade_offer_carries_each_copy_with_its_level() {
        let o: TradeOffer = serde_json::from_str(
            r#"{"units":[{"unitId":"u1","itemId":"boombox","upgradeLevel":3}],"items":{"boombox":1},"currency":0}"#,
        )
        .unwrap();
        assert_eq!(o.units.len(), 1);
        assert_eq!(o.units[0].unit_id, "u1");
        assert_eq!(o.units[0].upgrade_level, 3);
    }

    #[test]
    fn a_trade_offer_request_sends_only_the_copies_and_the_coins() {
        let req = TradeOfferRequest {
            units: vec!["u1".into(), "u2".into()],
            currency: 7,
        };
        assert_eq!(
            serde_json::to_value(&req).unwrap(),
            serde_json::json!({ "units": ["u1", "u2"], "currency": 7 })
        );
    }
}
