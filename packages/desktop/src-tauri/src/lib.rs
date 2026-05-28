mod api;
mod auth;
mod game;
mod hatch;
mod lastfm;
#[cfg(target_os = "macos")]
mod media_remote_adapter;
mod nowplaying;
mod state;
mod storage;
mod tray;
mod types;

use lastfm::{LastFmService, TrackEnrichment, ENRICHMENT_TIMEOUT};
use reqwest::Client;
use state::{ManagedState, SharedState};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use types::*;

// Wrapped in newtype structs so Tauri's type-keyed state manager can
// distinguish them — a plain `type` alias resolves to the same Rust type
// and would collide on the second `.manage()` call.
pub struct PendingDeepLink(pub Mutex<Option<String>>);
pub struct LastTradeNotified(pub Mutex<Option<String>>);

// --- Tauri commands ---

#[tauri::command]
fn get_state(state: tauri::State<SharedState>) -> AppState {
    let s = state.lock().unwrap();
    s.to_app_state(env!("CARGO_PKG_VERSION"))
}

#[tauri::command]
async fn login(app: AppHandle) -> Result<bool, String> {
    Ok(auth::login(&app).await)
}

#[tauri::command]
fn logout(app: AppHandle, state: tauri::State<SharedState>) {
    storage::clear_session();
    storage::clear_herzie();
    let mut s = state.lock().unwrap();
    s.herzie = None;
    s.clear_app_cache();
    let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
    drop(s);
    let _ = app.emit("state-update", &app_state);
}

#[tauri::command]
async fn register_herzie(
    name: String,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() || trimmed.len() > 20 {
        return Err("Name must be 1-20 characters.".into());
    }
    let name_re = regex_lite::Regex::new(r"^[A-Za-z0-9 _-]+$").unwrap();
    if !name_re.is_match(&trimmed) {
        return Err(
            "Name can only contain letters, numbers, spaces, hyphens, and underscores.".into(),
        );
    }

    // Refuse if a herzie already exists locally — caller should know.
    {
        let s = state.lock().unwrap();
        if s.herzie.is_some() {
            return Err("Herzie already exists.".into());
        }
    }

    if !api::is_logged_in() {
        return Err("Not logged in.".into());
    }

    let client = Client::new();

    // Retry on friend-code collision (vanishingly rare but cheap to handle).
    let mut last_err: Option<String> = None;
    for _ in 0..5 {
        let candidate = hatch::new_herzie(trimmed.clone());
        match api::api_register_herzie(&client, &candidate).await {
            Ok(registered) => {
                storage::save_herzie(&registered);
                let mut s = state.lock().unwrap();
                s.herzie = Some(registered);
                let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
                drop(s);
                let _ = app.emit("state-update", &app_state);
                let _ = app.emit("activity", format!("{} has hatched!", trimmed));
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    let client = Client::new();
                    refresh_app_cache(&app_clone, &client).await;
                });
                return Ok(());
            }
            Err(api::RegisterError::FriendCodeCollision) => {
                // Try again with a new code.
                continue;
            }
            Err(api::RegisterError::NameTaken) => {
                return Err("That name is already taken.".into());
            }
            Err(api::RegisterError::Network) => {
                last_err = Some("Network error. Check your connection and try again.".into());
                break;
            }
            Err(api::RegisterError::Server(msg)) => {
                last_err = Some(msg);
                break;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "Couldn't allocate a friend code. Try again.".into()))
}

#[tauri::command]
async fn friend_add(
    code: String,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<FriendResult, String> {
    let (friend_code, friend_codes_len, already_has) = {
        let s = state.lock().unwrap();
        let herzie = match &s.herzie {
            Some(h) => h,
            None => {
                return Ok(FriendResult {
                    success: false,
                    message: "No herzie".into(),
                })
            }
        };
        (
            herzie.friend_code.clone(),
            herzie.friend_codes.len(),
            herzie.friend_codes.contains(&code),
        )
    };

    let re = regex_lite::Regex::new(r"^HERZ-[A-Z0-9]{4}$").unwrap();
    if !re.is_match(&code) {
        return Ok(FriendResult {
            success: false,
            message: "Invalid code format".into(),
        });
    }
    if code == friend_code {
        return Ok(FriendResult {
            success: false,
            message: "Can't add yourself".into(),
        });
    }
    if already_has {
        return Ok(FriendResult {
            success: false,
            message: "Already friends".into(),
        });
    }
    if friend_codes_len >= 20 {
        return Ok(FriendResult {
            success: false,
            message: "Friend list full (max 20)".into(),
        });
    }

    let client = Client::new();
    let ok = api::api_add_friend(&client, &friend_code, &code).await;
    if ok {
        let mut s = state.lock().unwrap();
        if let Some(ref mut herzie) = s.herzie {
            herzie.friend_codes.push(code.clone());
            storage::save_herzie(herzie);
            let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
            drop(s);
            let _ = app.emit("state-update", &app_state);
        }
        let _ = app.emit("activity", format!("Added friend {}", code));
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let client = Client::new();
            refresh_friends_cache(&app_clone, &client).await;
        });
        Ok(FriendResult {
            success: true,
            message: "Friend added!".into(),
        })
    } else {
        Ok(FriendResult {
            success: false,
            message: "Friend code not found".into(),
        })
    }
}

#[tauri::command]
async fn friend_remove(
    code: String,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<FriendResult, String> {
    let friend_code = {
        let s = state.lock().unwrap();
        match &s.herzie {
            Some(h) => h.friend_code.clone(),
            None => {
                return Ok(FriendResult {
                    success: false,
                    message: "No herzie".into(),
                })
            }
        }
    };

    let client = Client::new();
    let ok = api::api_remove_friend(&client, &friend_code, &code).await;
    if ok {
        let mut s = state.lock().unwrap();
        if let Some(ref mut herzie) = s.herzie {
            herzie.friend_codes.retain(|c| c != &code);
            storage::save_herzie(herzie);
        }
        s.friends.remove(&code);
        if let Some(ref herzie) = s.herzie {
            storage::save_friends_cache(&herzie.friend_codes, &s.friends);
        }
        drop(s);
        emit_state_update(&app);
        let _ = app.emit("activity", format!("Removed friend {}", code));
        Ok(FriendResult {
            success: true,
            message: "Friend removed".into(),
        })
    } else {
        Ok(FriendResult {
            success: false,
            message: "Failed to remove friend".into(),
        })
    }
}

#[tauri::command]
async fn friend_lookup(
    codes: Vec<String>,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<HashMap<String, HerzieProfile>, String> {
    let client = Client::new();
    if let Some(profiles) = api::api_lookup_herzies(&client, &codes).await {
        let mut s = state.lock().unwrap();
        for (code, profile) in &profiles {
            s.friends.insert(code.clone(), profile.clone());
        }
        if let Some(ref herzie) = s.herzie {
            storage::save_friends_cache(&herzie.friend_codes, &s.friends);
        }
        drop(s);
        emit_state_update(&app);
        Ok(profiles)
    } else {
        let s = state.lock().unwrap();
        Ok(codes
            .iter()
            .filter_map(|c| s.friends.get(c).map(|p| (c.clone(), p.clone())))
            .collect())
    }
}

#[tauri::command]
async fn fetch_inventory(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<Option<InventoryResult>, String> {
    if !api::is_logged_in() {
        return Ok(None);
    }
    let client = Client::new();
    match api::api_fetch_inventory(&client).await {
        Some((inventory, currency, equipped)) => {
            let mut s = state.lock().unwrap();
            apply_inventory(&mut s, inventory.clone(), currency, equipped.clone());
            drop(s);
            emit_state_update(&app);
            Ok(Some(InventoryResult {
                inventory,
                currency,
                equipped,
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn sell_item(
    item_id: String,
    quantity: u32,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<Option<serde_json::Value>, String> {
    let client = Client::new();
    let result = api::api_sell_item(&client, &item_id, quantity).await;
    if let Some(ref data) = result {
        let mut s = state.lock().unwrap();
        let mut changed = false;
        if let Ok(inventory) = serde_json::from_value::<Inventory>(data["inventory"].clone()) {
            let currency = data["newCurrency"].as_u64().unwrap_or(0) as u32;
            let equipped = s.equipped.clone();
            apply_inventory(&mut s, inventory, currency, equipped);
            changed = true;
        } else if let Some(new_currency) = data["newCurrency"].as_u64() {
            s.inventory_currency = new_currency as u32;
            if let Some(ref inv) = s.inventory {
                storage::save_inventory_cache(inv, s.inventory_currency);
            }
            changed = true;
        }
        if let Some(ref mut herzie) = s.herzie {
            if let Some(new_currency) = data["newCurrency"].as_u64() {
                herzie.currency = new_currency as u32;
                storage::save_herzie(herzie);
                changed = true;
            }
        }
        drop(s);
        if changed {
            emit_state_update(&app);
        }
    }
    Ok(result)
}

#[tauri::command]
async fn equip_item(
    item_id: String,
    action: String,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let client = Client::new();
    let result = api::api_equip_item(&client, &item_id, &action).await?;
    if let Ok(equipped) = serde_json::from_value::<Vec<String>>(result["equipped"].clone()) {
        let mut s = state.lock().unwrap();
        s.equipped = equipped;
        storage::save_equipped(&s.equipped);
        drop(s);
        emit_state_update(&app);
    }
    Ok(result)
}

#[tauri::command]
async fn trade_create(target_code: String) -> Result<Option<serde_json::Value>, String> {
    let client = Client::new();
    Ok(api::api_create_trade(&client, &target_code).await)
}

#[tauri::command]
async fn trade_join(trade_id: String) -> Result<bool, String> {
    let client = Client::new();
    Ok(api::api_join_trade(&client, &trade_id).await)
}

#[tauri::command]
async fn trade_offer(trade_id: String, offer: TradeOffer) -> Result<bool, String> {
    let client = Client::new();
    Ok(api::api_update_trade_offer(&client, &trade_id, &offer).await)
}

#[tauri::command]
async fn trade_lock(trade_id: String) -> Result<bool, String> {
    let client = Client::new();
    Ok(api::api_lock_trade(&client, &trade_id).await)
}

#[tauri::command]
async fn trade_accept(trade_id: String) -> Result<Option<serde_json::Value>, String> {
    let client = Client::new();
    Ok(api::api_accept_trade(&client, &trade_id).await)
}

#[tauri::command]
async fn trade_cancel(trade_id: String) -> Result<bool, String> {
    let client = Client::new();
    Ok(api::api_cancel_trade(&client, &trade_id).await)
}

#[tauri::command]
async fn trade_poll(trade_id: String) -> Result<Option<Trade>, String> {
    let client = Client::new();
    Ok(api::api_poll_trade(&client, &trade_id).await)
}

#[tauri::command]
async fn fetch_active_events() -> Result<serde_json::Value, String> {
    let client = Client::new();
    match api::api_fetch_active_events(&client).await {
        Some(events) => Ok(serde_json::json!({ "events": events })),
        None => Ok(serde_json::json!({ "events": [] })),
    }
}

#[tauri::command]
async fn fetch_previous_hunt() -> Result<serde_json::Value, String> {
    let client = Client::new();
    match api::api_fetch_previous_hunt(&client).await {
        Some(events) => Ok(serde_json::json!({ "events": events })),
        None => Ok(serde_json::json!({ "events": [] })),
    }
}

#[tauri::command]
async fn get_auth_config() -> Result<Option<AuthConfig>, String> {
    let client = Client::new();
    let token = api::get_token_public(&client).await;
    let session = storage::load_session();

    match (token, session) {
        (Some(access_token), Some(session)) => {
            let supabase_url = std::env::var("NEXT_PUBLIC_SUPABASE_URL")
                .or_else(|_| std::env::var("SUPABASE_URL"))
                .unwrap_or_else(|_| "https://ojqfqxolbjegorgoyond.supabase.co".to_string());
            let anon_key = std::env::var("NEXT_PUBLIC_SUPABASE_ANON_KEY")
                .or_else(|_| std::env::var("SUPABASE_ANON_KEY"))
                .unwrap_or_else(|_| "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qcWZxeG9sYmplZ29yZ295b25kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NTcwMjgsImV4cCI6MjA5MzIzMzAyOH0.BBT77VK1ROJr57BJvMfCyra3lbycMA9u2-jxG-LhBJE".to_string());
            Ok(Some(AuthConfig {
                supabase_url,
                anon_key,
                access_token,
                user_id: session.user_id,
            }))
        }
        _ => Ok(None),
    }
}

#[tauri::command]
async fn chat_fetch(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<Option<ChatFetchResponse>, String> {
    if !api::is_logged_in() {
        return Ok(None);
    }
    let client = Client::new();
    if let Some(chat) = api::api_chat_fetch(&client).await {
        let mut s = state.lock().unwrap();
        s.chat_messages = chat.messages.clone();
        let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
        drop(s);
        let _ = app.emit("state-update", &app_state);
        Ok(Some(chat))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn chat_send(
    content: String,
    item_refs: Vec<String>,
    user_refs: Vec<String>,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<Option<ChatSendResponse>, String> {
    if !api::is_logged_in() {
        return Ok(None);
    }
    let client = Client::new();
    match api::api_chat_send(&client, &content, &item_refs, &user_refs).await {
        Some(msg) => {
            let mut s = state.lock().unwrap();
            if !s.chat_messages.iter().any(|m| m.id == msg.id) {
                s.chat_messages.push(msg.clone());
            }
            let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
            drop(s);
            let _ = app.emit("state-update", &app_state);
            Ok(Some(ChatSendResponse { message: msg }))
        }
        None => Ok(None),
    }
}

// --- Helper types for command results ---

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthConfig {
    supabase_url: String,
    anon_key: String,
    access_token: String,
    user_id: String,
}

#[derive(serde::Serialize)]
struct FriendResult {
    success: bool,
    message: String,
}

#[derive(serde::Serialize)]
struct InventoryResult {
    inventory: Inventory,
    currency: u32,
    equipped: Vec<String>,
}

// --- App cache (inventory, friends, chat, equipped) ---

fn emit_state_update(app: &AppHandle) {
    let shared = app.state::<SharedState>();
    let app_state = {
        let s = shared.lock().unwrap();
        s.to_app_state(env!("CARGO_PKG_VERSION"))
    };
    let _ = app.emit("state-update", &app_state);
}

fn apply_inventory(
    s: &mut ManagedState,
    inventory: Inventory,
    currency: u32,
    equipped: Vec<String>,
) {
    s.inventory = Some(inventory.clone());
    s.inventory_currency = currency;
    s.equipped = equipped;
    storage::save_inventory_cache(&inventory, currency);
    storage::save_equipped(&s.equipped);
}

fn notifications_include_item_grants(notifications: &[EventNotification]) -> bool {
    notifications
        .iter()
        .any(|n| n.notification_type == "item_granted")
}

async fn refresh_inventory_cache(app: &AppHandle, client: &Client) {
    if let Some((inventory, currency, equipped)) = api::api_fetch_inventory(client).await {
        let shared = app.state::<SharedState>();
        let mut s = shared.lock().unwrap();
        apply_inventory(&mut s, inventory, currency, equipped);
        drop(s);
        emit_state_update(app);
    }
}

async fn refresh_friends_cache(app: &AppHandle, client: &Client) {
    if !api::is_logged_in() {
        return;
    }
    let shared = app.state::<SharedState>();
    let friend_codes = {
        let s = shared.lock().unwrap();
        s.herzie
            .as_ref()
            .map(|h| h.friend_codes.clone())
            .unwrap_or_default()
    };
    let profiles = if friend_codes.is_empty() {
        Some(HashMap::new())
    } else {
        api::api_lookup_herzies(client, &friend_codes).await
    };
    if let Some(profiles) = profiles {
        let mut s = shared.lock().unwrap();
        s.friends = profiles;
        if let Some(ref herzie) = s.herzie {
            storage::save_friends_cache(&herzie.friend_codes, &s.friends);
        }
        drop(s);
        emit_state_update(app);
    }
}

/// Fetch inventory, chat, and friends in parallel into AppState.
async fn refresh_app_cache(app: &AppHandle, client: &Client) {
    if !api::is_logged_in() {
        return;
    }
    let shared = app.state::<SharedState>();
    let friend_codes = {
        let s = shared.lock().unwrap();
        if s.herzie.is_none() {
            return;
        }
        s.herzie
            .as_ref()
            .map(|h| h.friend_codes.clone())
            .unwrap_or_default()
    };

    let friends_fut = async {
        if friend_codes.is_empty() {
            Some(HashMap::new())
        } else {
            api::api_lookup_herzies(client, &friend_codes).await
        }
    };

    let (inv_result, chat_result, friends_result) = tokio::join!(
        api::api_fetch_inventory(client),
        api::api_chat_fetch(client),
        friends_fut,
    );

    let mut changed = false;
    {
        let mut s = shared.lock().unwrap();
        if let Some((inventory, currency, equipped)) = inv_result {
            apply_inventory(&mut s, inventory, currency, equipped);
            changed = true;
        }
        if let Some(chat) = chat_result {
            s.chat_messages = chat.messages;
            changed = true;
        }
        if let Some(friends) = friends_result {
            s.friends = friends;
            if let Some(ref herzie) = s.herzie {
                storage::save_friends_cache(&herzie.friend_codes, &s.friends);
            }
            changed = true;
        }
    }
    if changed {
        emit_state_update(app);
    }
}

// --- Background loops ---

async fn poll_loop(app: AppHandle) {
    let client = Client::new();

    loop {
        // 3s while the window is open (tight feedback for the now-playing card),
        // 6s while hidden — XP/min is unchanged because poll_tick credits real
        // elapsed seconds, not a fixed 3s slice.
        let delay = if tray::is_window_visible() { 3 } else { 6 };
        tokio::time::sleep(Duration::from_secs(delay)).await;

        if let Err(e) = poll_tick(&app, &client, delay).await {
            log::warn!("Poll error: {}", e);
        }
    }
}

fn display_tags(
    enrichment: Option<&TrackEnrichment>,
    local_genre: Option<&str>,
    current_genres: &[String],
) -> Option<Vec<String>> {
    let source: &[String] = if let Some(e) = enrichment {
        if !e.tags.is_empty() {
            &e.tags
        } else if !current_genres.is_empty() {
            current_genres
        } else {
            return local_genre
                .filter(|s| !s.is_empty())
                .map(|g| vec![g.to_string()]);
        }
    } else if !current_genres.is_empty() {
        current_genres
    } else {
        return local_genre
            .filter(|s| !s.is_empty())
            .map(|g| vec![g.to_string()]);
    };
    let tags: Vec<String> = source.iter().take(3).cloned().collect();
    if tags.is_empty() {
        None
    } else {
        Some(tags)
    }
}

fn resolve_album_art_url(
    system_art: Option<&str>,
    enrichment: Option<&TrackEnrichment>,
) -> Option<String> {
    system_art
        .filter(|url| !url.is_empty())
        .map(str::to_string)
        .or_else(|| enrichment.and_then(|e| e.album_art_url.clone()))
}

fn build_now_playing_display(
    title: &str,
    artist: &str,
    system_art: Option<&str>,
    enrichment: Option<&TrackEnrichment>,
    local_genre: Option<&str>,
    current_genres: &[String],
) -> NowPlayingDisplay {
    NowPlayingDisplay {
        title: title.to_string(),
        artist: artist.to_string(),
        album_art_url: resolve_album_art_url(system_art, enrichment),
        vibe: enrichment.and_then(|e| e.vibe.clone()),
        tags: display_tags(enrichment, local_genre, current_genres),
    }
}

fn apply_enrichment(app: &AppHandle, track_key: &str, enrichment: Option<TrackEnrichment>) {
    let state = app.state::<SharedState>();
    let app_state = {
        let mut s = state.lock().unwrap();
        if s.last_track_key.as_deref() != Some(track_key) {
            return;
        }
        s.enrichment_in_flight = false;
        s.enrichment = enrichment;
        if s.current_local_genre.is_none() {
            if let Some(ref e) = s.enrichment {
                if !e.tags.is_empty() {
                    s.current_genres = e.tags.clone();
                } else {
                    s.current_genres = vec!["pop".to_string()];
                }
            }
        }
        let tags = display_tags(
            s.enrichment.as_ref(),
            s.current_local_genre.as_deref(),
            &s.current_genres,
        );
        let album_art_url = resolve_album_art_url(
            s.system_album_art_url.as_deref(),
            s.enrichment.as_ref(),
        );
        let vibe = s.enrichment.as_ref().and_then(|e| e.vibe.clone());
        if let Some(ref mut np) = s.current_now_playing {
            np.album_art_url = album_art_url;
            np.vibe = vibe;
            np.tags = tags;
        }
        s.to_app_state(env!("CARGO_PKG_VERSION"))
    };
    let _ = app.emit("state-update", &app_state);
}

fn spawn_track_enrichment(app: &AppHandle, artist: String, title: String, track_key: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let service = app.state::<LastFmService>();
        let enrichment = service.fetch_track(&artist, &title).await;
        apply_enrichment(&app, &track_key, enrichment);
    });
}

#[cfg(target_os = "macos")]
fn spawn_system_artwork_fetch(app: &AppHandle, track_key: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let artwork = tokio::task::spawn_blocking(media_remote_adapter::fetch_system_artwork_url)
            .await
            .ok()
            .flatten();
        let Some(artwork) = artwork else {
            return;
        };

        let state = app.state::<SharedState>();
        let app_state = {
            let mut s = state.lock().unwrap();
            if s.last_track_key.as_deref() != Some(track_key.as_str()) {
                return;
            }
            s.system_album_art_url = Some(artwork);
            let album_art_url = resolve_album_art_url(
                s.system_album_art_url.as_deref(),
                s.enrichment.as_ref(),
            );
            if let Some(ref mut np) = s.current_now_playing {
                np.album_art_url = album_art_url;
            }
            s.to_app_state(env!("CARGO_PKG_VERSION"))
        };
        let _ = app.emit("state-update", &app_state);
    });
}

#[cfg(not(target_os = "macos"))]
fn spawn_system_artwork_fetch(_app: &AppHandle, _track_key: String) {}

async fn poll_tick(app: &AppHandle, _client: &Client, elapsed_secs: u64) -> Result<(), String> {
    let state = app.state::<SharedState>();
    let lastfm = app.state::<LastFmService>();

    let has_herzie = {
        let s = state.lock().unwrap();
        s.herzie.is_some()
    };

    if !has_herzie {
        return Ok(());
    }

    let np = nowplaying::get_now_playing().await;

    // Collect notification info to send after releasing the lock
    let mut notify_level_up: Option<(String, u32)> = None;
    let mut notify_evolved: Option<(String, u32)> = None;
    let mut spawn_enrichment: Option<(String, String, String)> = None;
    let mut spawn_artwork: Option<String> = None;

    {
        let mut s = state.lock().unwrap();
        if s.herzie.is_none() {
            return Ok(());
        }

        match np {
            Some(ref info) if info.is_playing && !info.title.is_empty() && info.volume > 0 => {
                let key = lastfm::track_key(&info.artist, &info.title);
                let track_changed = s.last_track_key.as_deref() != Some(key.as_str());

                if track_changed {
                    s.last_track_key = Some(key.clone());
                    s.enrichment = None;
                    s.system_album_art_url = None;
                    s.enrichment_requested_at = Some(Instant::now());
                    s.enrichment_in_flight = false;
                    #[cfg(target_os = "macos")]
                    if media_remote_adapter::is_configured() {
                        spawn_artwork = Some(key.clone());
                    }
                    s.current_local_genre = if info.genre.is_empty() {
                        None
                    } else {
                        Some(info.genre.clone())
                    };
                    s.current_genres = if info.genre.is_empty() {
                        vec![]
                    } else {
                        vec![info.genre.clone()]
                    };

                    if lastfm.has_api_key() {
                        s.enrichment_in_flight = true;
                        spawn_enrichment =
                            Some((info.artist.clone(), info.title.clone(), key.clone()));
                    }
                }

                let timed_out = s
                    .enrichment_requested_at
                    .map(|t| t.elapsed() > ENRICHMENT_TIMEOUT)
                    .unwrap_or(false);

                let local_genre = s.current_local_genre.as_deref();
                let genre_list = lastfm::resolve_listen_genres(
                    local_genre,
                    s.enrichment.as_ref(),
                    timed_out,
                    s.enrichment_in_flight,
                );

                let minutes = elapsed_secs as f64 / 60.0;
                if minutes > 0.01 {
                    s.pending_minutes += minutes;

                    if let Some(ref genres) = genre_list {
                        let classified = game::classify_genre(genres);

                        let herzie = s.herzie.as_mut().unwrap();
                        let craving = game::get_daily_craving(&herzie.id, None);
                        let is_craving =
                            !genres.is_empty() && game::matches_craving(genres, &craving);

                        let xp = game::calculate_xp_gain(
                            minutes,
                            herzie.friend_codes.len(),
                            is_craving,
                            &[],
                        );
                        let events = game::apply_xp(herzie, xp);
                        herzie.total_minutes_listened += minutes;
                        game::record_genre_minutes(&mut herzie.genre_minutes, &classified, minutes);
                        storage::save_herzie(herzie);

                        if events.leveled_up {
                            notify_level_up = Some((herzie.name.clone(), herzie.level));
                        }
                        if events.evolved {
                            if let Some(new_stage) = events.new_stage {
                                notify_evolved = Some((herzie.name.clone(), new_stage));
                            }
                        }
                    }
                }

                if let Some(ref genres) = genre_list {
                    s.current_genres = genres.clone();
                }

                s.current_now_playing = Some(build_now_playing_display(
                    &info.title,
                    &info.artist,
                    s.system_album_art_url.as_deref(),
                    s.enrichment.as_ref(),
                    s.current_local_genre.as_deref(),
                    &s.current_genres,
                ));
            }
            _ => {
                s.current_now_playing = None;
                s.current_genres.clear();
                s.current_local_genre = None;
                s.last_track_key = None;
                s.system_album_art_url = None;
                s.enrichment = None;
                s.enrichment_requested_at = None;
                s.enrichment_in_flight = false;
            }
        }
    }

    if let Some((artist, title, key)) = spawn_enrichment {
        spawn_track_enrichment(app, artist, title, key);
    }
    if let Some(track_key) = spawn_artwork {
        spawn_system_artwork_fetch(app, track_key);
    }

    // Send notifications outside the lock
    if let Some((name, level)) = notify_level_up {
        let msg = format!("{} is now level {}!", name, level);
        send_notification(app, "Level Up!", &msg, None);
    }
    if let Some((name, stage)) = notify_evolved {
        let msg = format!("{} evolved to Stage {}!", name, stage);
        send_notification(app, "Evolution!", &msg, None);
    }

    let app_state = {
        let s = state.lock().unwrap();
        s.to_app_state(env!("CARGO_PKG_VERSION"))
    };
    let _ = app.emit("state-update", &app_state);

    Ok(())
}

#[tauri::command]
fn test_notification(app: AppHandle) {
    send_notification(&app, "CD", "You received: 1x CD", Some("cd"));
    let _ = app.emit("activity", "You received: 1x CD".to_string());
}

#[tauri::command]
fn test_activity(app: AppHandle) {
    let _ = app.emit("activity", "Test activity log entry");
}

/// Raw JSON from macOS MediaRemote (debug). Returns `null` when unavailable or empty.
#[tauri::command]
fn debug_media_remote_now_playing() -> Option<String> {
    nowplaying::raw_media_remote_json()
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" {
        return Err("only https URLs are allowed".into());
    }
    match parsed.host_str() {
        Some("www.last.fm") | Some("last.fm") => {}
        Some(h) => return Err(format!("unexpected host: {h}")),
        None => return Err("missing host".into()),
    }
    let url_clone = url.clone();
    std::thread::spawn(move || {
        let _ = open::that(&url_clone);
    });
    Ok(())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn send_notification(app: &AppHandle, title: &str, body: &str, deep_link: Option<&str>) {
    // Store deep link so RunEvent::Reopen (notification click) and on_focus
    // (tray re-open) can deliver it once the user surfaces the window.
    if let Some(item_id) = deep_link {
        if let Ok(mut dl) = app.state::<PendingDeepLink>().0.lock() {
            *dl = Some(item_id.to_string());
        }
    }

    let title = title.to_string();
    let body = body.to_string();

    // Fire-and-forget. The previous implementation used wait_for_click(true),
    // which inside mac-notification-sys spins an NSRunLoop until the user
    // clicks — pegging a core at ~100% per pending notification. Click routing
    // is now handled via RunEvent::Reopen in run().
    std::thread::spawn(move || {
        let mut n = mac_notification_sys::Notification::default();
        n.title(&title).message(&body);
        let _ = n.send();
    });
}

async fn sync_loop(app: AppHandle) {
    let client = Client::new();

    loop {
        // 5s when the window is visible — keeps pending trade invites and
        // server state reasonably fresh without the old 10s+ perceived lag.
        // 60s when hidden (still flushes listening minutes; avoids idle cost).
        let delay = if tray::is_window_visible() { 5 } else { 60 };
        tokio::time::sleep(Duration::from_secs(delay)).await;

        if let Err(e) = sync_tick(&app, &client).await {
            log::warn!("Sync error: {}", e);
        }
    }
}

async fn sync_tick(app: &AppHandle, client: &Client) -> Result<(), String> {
    let state = app.state::<SharedState>();

    let (has_herzie, is_logged_in, minutes_to_sync, np_payload, genres) = {
        let s = state.lock().unwrap();
        let has = s.herzie.is_some();
        let logged = api::is_logged_in();
        let mins = s.pending_minutes.min(10.0);
        let np = s.current_now_playing.as_ref().map(|np| {
            let genre = if s.current_genres.is_empty() {
                None
            } else {
                game::classify_genre(&s.current_genres).into_iter().next()
            };
            NowPlayingPayload {
                title: np.title.clone(),
                artist: np.artist.clone(),
                genre,
            }
        });
        let g = s.current_genres.clone();
        (has, logged, mins, np, g)
    };

    if !has_herzie || !is_logged_in {
        // Not signed in or no herzie yet — no server call needed, and we can't
        // distinguish "offline" from "logged out" without one, so assume the
        // server is reachable. The tray title already defaults to <3.
        tray::set_connected(app, is_logged_in);
        let mut s = state.lock().unwrap();
        s.last_sync_ok = is_logged_in;
        let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
        drop(s);
        let _ = app.emit("state-update", &app_state);
        return Ok(());
    }

    let result = api::api_sync(client, np_payload, minutes_to_sync, genres).await;
    // /sync can fail for non-network reasons (5xx, schema mismatch, etc.) while
    // the rest of the app keeps working. The tray title (and the frontend
    // indicator, via state.to_app_state) treats us as connected whenever
    // we've gotten *any* HTTP response from the server in the grace window,
    // so a single failing sync doesn't flip the UI to "offline" while
    // inventory/chat/friends are clearly fine.
    let sync_ok = result.is_some();
    let connected = sync_ok || api::ms_since_reachable() < api::REACHABLE_GRACE_MS;
    tray::set_connected(app, connected);

    if let Some(sync_resp) = result {
        let mut s = state.lock().unwrap();
        s.last_sync_ok = sync_ok;
        s.pending_minutes = (s.pending_minutes - minutes_to_sync).max(0.0);

        let friend_codes_changed = if let Some(ref mut herzie) = s.herzie {
            let server = &sync_resp.herzie;
            let changed = herzie.friend_codes != server.friend_codes;
            herzie.xp = server.xp;
            herzie.level = server.level;
            herzie.stage = server.stage;
            herzie.total_minutes_listened = server.total_minutes_listened;
            herzie.genre_minutes = server.genre_minutes.clone();
            herzie.friend_codes = server.friend_codes.clone();
            herzie.streak_days = server.streak_days;
            herzie.streak_last_date = server.streak_last_date.clone();
            herzie.currency = server.currency;
            storage::save_herzie(herzie);
            changed
        } else {
            false
        };

        storage::save_multipliers(&sync_resp.multipliers);

        s.pending_trade_request = sync_resp.pending_trade_request.clone();

        let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
        drop(s);
        let _ = app.emit("state-update", &app_state);

        if friend_codes_changed {
            let app_clone = app.clone();
            let client = client.clone();
            tauri::async_runtime::spawn(async move {
                refresh_friends_cache(&app_clone, &client).await;
            });
        }

        // Show notification for incoming trade requests — dedupe by trade ID
        // so we don't re-notify on every sync tick while the trade is pending.
        if let Some(trade_req) = &sync_resp.pending_trade_request {
            let should_notify = {
                let state = app.state::<LastTradeNotified>();
                let mut last = state.0.lock().unwrap();
                if last.as_deref() == Some(trade_req.trade_id.as_str()) {
                    false
                } else {
                    *last = Some(trade_req.trade_id.clone());
                    true
                }
            };
            if should_notify {
                let msg = format!("{} wants to trade with you!", trade_req.from_name);
                let deep_link = format!("trade:{}", trade_req.trade_id);
                send_notification(app, "Trade Request", &msg, Some(&deep_link));
                let _ = app.emit("activity", format!("Trade Request: {}", msg));
            }
        } else {
            // Pending trade is gone (joined, cancelled, or expired) — reset
            // so a future request from the same partner re-notifies.
            if let Ok(mut last) = app.state::<LastTradeNotified>().0.lock() {
                *last = None;
            }
        }

        // Show server-sent notifications (item drops, etc.)
        for notif in &sync_resp.notifications {
            if notif.log_only.unwrap_or(false) {
                let _ = app.emit("activity", &notif.message);
            } else {
                send_notification(app, &notif.title, &notif.message, notif.item_id.as_deref());
                let _ = app.emit("activity", format!("{}: {}", notif.title, notif.message));
            }
        }

        if notifications_include_item_grants(&sync_resp.notifications) {
            let app_clone = app.clone();
            let client = client.clone();
            tauri::async_runtime::spawn(async move {
                refresh_inventory_cache(&app_clone, &client).await;
            });
        }
    } else {
        let mut s = state.lock().unwrap();
        s.last_sync_ok = sync_ok;
        let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
        drop(s);
        let _ = app.emit("state-update", &app_state);
    }

    Ok(())
}

/// Decide whether the on-disk herzie belongs to the current session and
/// should be loaded into memory. Wipes orphaned data so the onboarding
/// screen can take over.
///
/// - Owner matches current session → adopt.
/// - Legacy file (no owner) + active session → migrate by claiming for current user.
/// - Owner mismatch, or no session → wipe the local file and start clean.
pub(crate) fn adopt_local_herzie() -> Option<Herzie> {
    let loaded = storage::load_herzie()?;
    let session = storage::load_session();

    match (loaded.owner, session) {
        (Some(owner), Some(s)) if owner == s.user_id => Some(loaded.herzie),
        (None, Some(s)) => {
            storage::save_herzie_with_owner(&loaded.herzie, &s.user_id);
            Some(loaded.herzie)
        }
        _ => {
            storage::clear_herzie();
            None
        }
    }
}

// --- Tauri setup ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    lastfm::load_env();
    let lastfm_service = LastFmService::from_env();
    lastfm_service.log_missing_key_once();

    let herzie = adopt_local_herzie();
    log::info!(
        "Loaded herzie: {}",
        herzie.as_ref().map(|h| h.name.as_str()).unwrap_or("null")
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Show window when second instance tries to launch
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(Mutex::new(ManagedState::new(herzie)) as SharedState)
        .manage(lastfm_service)
        .manage(PendingDeepLink(Mutex::new(None)))
        .manage(LastTradeNotified(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_state,
            login,
            logout,
            register_herzie,
            friend_add,
            friend_remove,
            friend_lookup,
            fetch_inventory,
            sell_item,
            equip_item,
            trade_create,
            trade_join,
            trade_offer,
            trade_lock,
            trade_accept,
            trade_cancel,
            trade_poll,
            fetch_active_events,
            fetch_previous_hunt,
            get_auth_config,
            chat_fetch,
            chat_send,
            test_notification,
            test_activity,
            debug_media_remote_now_playing,
            quit,
            open_external_url,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use std::path::PathBuf;
                use tauri::path::BaseDirectory;

                let bundled = app
                    .path()
                    .resolve("mediaremote", BaseDirectory::Resource)
                    .ok()
                    .filter(|p| p.join("mediaremote-adapter.pl").is_file());
                let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mediaremote");
                let dir = bundled.unwrap_or(dev);
                if dir.join("mediaremote-adapter.pl").is_file() {
                    media_remote_adapter::init(dir);
                    log::info!("MediaRemote adapter: {:?}", media_remote_adapter::is_configured());
                } else {
                    log::warn!(
                        "MediaRemote adapter files missing; now playing falls back to AppleScript"
                    );
                }
            }

            // Set notification bundle ID so clicks activate this app
            let bundle_id = if tauri::is_dev() {
                "com.apple.Terminal"
            } else {
                &app.config().identifier
            };
            let _ = mac_notification_sys::set_application(bundle_id);

            // Hide dock icon (menu bar only)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Set up tray icon
            tray::setup_tray(app.handle())?;

            // Set up window hide-on-blur (production only)
            if !tauri::is_dev() {
                if let Some(window) = app.get_webview_window("main") {
                    let app_handle = app.handle().clone();
                    window.on_window_event(move |event| match event {
                        tauri::WindowEvent::Focused(false) => {
                            tray::on_blur(&app_handle);
                        }
                        tauri::WindowEvent::Focused(true) => {
                            tray::on_focus(&app_handle);
                        }
                        _ => {}
                    });
                }
            } else {
                // In dev, show window immediately
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.center();
                    let _ = window.show();
                    tray::on_focus(app.handle());
                }
            }

            // Enable autostart
            {
                use tauri_plugin_autostart::ManagerExt;
                let autostart = app.autolaunch();
                let _ = autostart.enable();
            }

            // Start background loops
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(poll_loop(app_handle));

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(sync_loop(app_handle));

            // Initial poll + sync + home cache (equipped + chat)
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let client = Client::new();
                // Initial tick credits no listening minutes (no prior interval).
                let _ = poll_tick(&app_handle, &client, 0).await;
                let _ = sync_tick(&app_handle, &client).await;
                refresh_app_cache(&app_handle, &client).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS sends Reopen when the app is re-activated — including via
            // a notification click. Surfacing the window here triggers the
            // existing on_focus chain which emits any pending deep link.
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                tray::ensure_visible(app_handle);
            }
        });
}
