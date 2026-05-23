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
    pub stage: u32,
    pub level: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<HerzieAppearance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_artists: Option<Vec<TopArtist>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equipped: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopArtist {
    pub name: String,
    pub plays: u32,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub herzie: Herzie,
    pub notifications: Vec<EventNotification>,
    pub multipliers: Vec<ActiveMultiplier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_trade_request: Option<PendingTradeRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTradeRequest {
    pub trade_id: String,
    pub from_name: String,
    pub from_friend_code: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeOffer {
    pub items: HashMap<String, u32>,
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
    pub equipped: Vec<String>,
    pub chat_messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory: Option<Inventory>,
    pub inventory_currency: u32,
    pub friends: HashMap<String, HerzieProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingDisplay {
    pub title: String,
    pub artist: String,
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
    pub content: String,
    pub item_refs: Vec<String>,
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
}
