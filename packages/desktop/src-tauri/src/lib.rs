mod api;
mod auth;
mod game;
mod hatch;
mod lastfm;
#[cfg(target_os = "macos")]
mod media_remote_adapter;
mod nowplaying;
#[cfg(windows)]
mod smtc_adapter;
mod state;
mod storage;
mod tray;
mod types;

use lastfm::{LastFmService, TrackEnrichment, ENRICHMENT_TIMEOUT};
use reqwest::Client;
use state::{ManagedState, SharedState};
use std::collections::{HashMap, HashSet};
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
pub struct LastFriendNotified(pub Mutex<Option<String>>);

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
    match api::api_send_friend_request(&client, &friend_code, &code).await {
        Ok(accepted) => {
            if accepted {
                // They had already requested us, so the friendship is live now.
                add_friend_locally(&app, &state, &code);
                Ok(FriendResult {
                    success: true,
                    message: "Friend added!".into(),
                })
            } else {
                let _ = app.emit("activity", format!("Friend request sent to {}", code));
                Ok(FriendResult {
                    success: true,
                    message: "Friend request sent!".into(),
                })
            }
        }
        Err(message) => Ok(FriendResult {
            success: false,
            message,
        }),
    }
}

/// Push a newly-confirmed friend code into local state, persist, emit, and
/// refresh the cached profiles. Shared by send (auto-accept) and accept paths.
fn add_friend_locally(app: &AppHandle, state: &tauri::State<'_, SharedState>, code: &str) {
    {
        let mut s = state.lock().unwrap();
        if let Some(ref mut herzie) = s.herzie {
            if !herzie.friend_codes.contains(&code.to_string()) {
                herzie.friend_codes.push(code.to_string());
                storage::save_herzie(herzie);
            }
        }
        s.bump_friend_epoch();
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
}

#[tauri::command]
async fn friend_request_accept(
    request_id: String,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<FriendResult, String> {
    // Resolve the friend code for this request so we can update local state.
    let code = {
        let s = state.lock().unwrap();
        s.incoming_friend_requests
            .iter()
            .find(|r| r.request_id == request_id)
            .map(|r| r.friend_code.clone())
    };

    let client = Client::new();
    match api::api_accept_friend_request(&client, &request_id).await {
        Ok(()) => {
            {
                let mut s = state.lock().unwrap();
                s.incoming_friend_requests
                    .retain(|r| r.request_id != request_id);
                if s.pending_friend_request.as_ref().map(|p| &p.request_id) == Some(&request_id) {
                    s.pending_friend_request = None;
                }
                s.bump_friend_epoch();
            }
            if let Some(code) = code {
                add_friend_locally(&app, &state, &code);
            } else {
                emit_state_update(&app);
            }
            Ok(FriendResult {
                success: true,
                message: "Friend added!".into(),
            })
        }
        Err(message) => Ok(FriendResult {
            success: false,
            message,
        }),
    }
}

#[tauri::command]
async fn friend_request_decline(
    request_id: String,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<FriendResult, String> {
    let client = Client::new();
    match api::api_decline_friend_request(&client, &request_id).await {
        Ok(()) => {
            {
                let mut s = state.lock().unwrap();
                s.incoming_friend_requests
                    .retain(|r| r.request_id != request_id);
                if s.pending_friend_request.as_ref().map(|p| &p.request_id) == Some(&request_id) {
                    s.pending_friend_request = None;
                }
                s.bump_friend_epoch();
            }
            emit_state_update(&app);
            Ok(FriendResult {
                success: true,
                message: "Request declined".into(),
            })
        }
        Err(message) => Ok(FriendResult {
            success: false,
            message,
        }),
    }
}

#[tauri::command]
async fn friend_request_cancel(
    request_id: String,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<FriendResult, String> {
    let client = Client::new();
    match api::api_cancel_friend_request(&client, &request_id).await {
        Ok(()) => {
            {
                let mut s = state.lock().unwrap();
                s.outgoing_friend_requests
                    .retain(|r| r.request_id != request_id);
                s.bump_friend_epoch();
            }
            emit_state_update(&app);
            Ok(FriendResult {
                success: true,
                message: "Request cancelled".into(),
            })
        }
        Err(message) => Ok(FriendResult {
            success: false,
            message,
        }),
    }
}

#[tauri::command]
async fn friend_search(query: String) -> Result<Vec<FriendSearchResult>, String> {
    let client = Client::new();
    api::api_search_friends(&client, &query).await
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
        s.bump_friend_epoch();
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
    let epoch_before = { state.lock().unwrap().equip_epoch };
    match api::api_fetch_inventory(&client).await {
        Some((inventory, currency, equipped)) => {
            let mut s = state.lock().unwrap();
            apply_inventory(
                &mut s,
                inventory.clone(),
                currency,
                equipped.clone(),
                Some(epoch_before),
            );
            // Hand back whatever `equipped` actually won, so a caller that
            // raced an equip doesn't render the stale snapshot we just skipped.
            let equipped = s.equipped.clone();
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
            // Selling the last copy of an equipped item unequips it
            // server-side too — apply whatever the response says rather than
            // the stale local equip state, so the two never drift apart.
            let equipped = serde_json::from_value::<
                std::collections::HashMap<String, serde_json::Value>,
            >(data["equipped"].clone())
            .unwrap_or_else(|_| s.equipped.clone());
            apply_inventory(&mut s, inventory, currency, equipped, None);
            // Selling can unequip server-side, so this is a local `equipped`
            // mutation — any `/inventory` fetch in flight must not undo it.
            s.bump_equip_epoch();
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
    side: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let client = Client::new();
    let result = api::api_equip_item(&client, &item_id, &action, side.as_deref()).await?;
    if let Ok(equipped) = serde_json::from_value::<
        std::collections::HashMap<String, serde_json::Value>,
    >(result["equipped"].clone())
    {
        let mut s = state.lock().unwrap();
        s.equipped = equipped;
        // Any `/inventory` fetch already in flight was issued before this
        // change and would otherwise clobber it back — see apply_inventory.
        s.bump_equip_epoch();
        storage::save_equipped(&s.equipped);
        drop(s);
        emit_state_update(&app);
    }
    Ok(result)
}

#[tauri::command]
async fn buy_item(
    item_id: String,
    quantity: u32,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let client = Client::new();
    let data = api::api_buy_item(&client, &item_id, quantity).await?;

    let mut s = state.lock().unwrap();
    let mut changed = false;
    if let Ok(inventory) = serde_json::from_value::<Inventory>(data["inventory"].clone()) {
        let currency = data["newCurrency"].as_u64().unwrap_or(0) as u32;
        let equipped = s.equipped.clone();
        apply_inventory(&mut s, inventory, currency, equipped, None);
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
    Ok(data)
}

#[tauri::command]
async fn collect_drop(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
    drop_id: String,
) -> Result<bool, String> {
    let client = Client::new();

    // Optimistic: remove the drop and credit the item to inventory locally
    // right away, before the round trip even starts, so the card
    // disappears and the count bumps instantly instead of after a couple
    // hundred ms of network latency. Reverted below if the server says
    // otherwise — already gone (e.g. a racing Spirit Orb auto-collect) or
    // a request failure.
    let removed_drop = {
        let mut s = state.lock().unwrap();
        let removed = s
            .pending_drops
            .iter()
            .position(|d| d.id == drop_id)
            .map(|i| s.pending_drops.remove(i));
        if let Some(ref drop) = removed {
            if let Some(inv) = s.inventory.as_mut() {
                *inv.entry(drop.item_id.clone()).or_insert(0) += 1;
            }
            s.bump_drop_epoch();
            s.bump_inventory_epoch();
        }
        removed
    };
    if removed_drop.is_some() {
        emit_state_update(&app);
    }

    let result = api::api_collect_drop(&client, &drop_id).await;

    match result {
        Ok(Some((_item_id, name))) => {
            // Log as soon as the collect is confirmed. This used to sit behind
            // the reconcile below, so the "You received" line waited on two
            // sequential round trips — the second to Vercel `/api/inventory` —
            // and lagged visibly behind the item vanishing from the ground.
            //
            // Same "You received: Nx <name>" convention as server-driven
            // item_granted notifications (see game-server.ts) — this path has
            // no SyncResponse to ride along on, so log it directly.
            let _ = app.emit("activity", format!("You received: 1x {name}"));

            // No /inventory re-fetch here. `collect_pending_drop` does exactly
            // one thing — delete the drop row and credit inventory_v2 by one —
            // which the optimistic update above already mirrors exactly, so a
            // refresh could only confirm what we know. Picking up several drops
            // in quick succession used to fire one slow Vercel request each.
            // /sync carries the authoritative inventory within a few seconds
            // regardless, which covers any genuine drift.
            Ok(true)
        }
        Ok(None) => {
            if let Some(drop) = removed_drop {
                revert_optimistic_collect(&state, drop);
                emit_state_update(&app);
            }
            Ok(false)
        }
        Err(e) => {
            if let Some(drop) = removed_drop {
                revert_optimistic_collect(&state, drop);
                emit_state_update(&app);
            }
            Err(e)
        }
    }
}

/// Undoes the optimistic local removal/inventory-credit in `collect_drop`
/// once the server reports the collect didn't actually happen.
fn revert_optimistic_collect(state: &tauri::State<'_, SharedState>, drop: PendingDrop) {
    let mut s = state.lock().unwrap();
    if let Some(inv) = s.inventory.as_mut() {
        if let Some(qty) = inv.get_mut(&drop.item_id) {
            *qty = qty.saturating_sub(1);
        }
    }
    s.pending_drops.push(drop);
    s.bump_drop_epoch();
    s.bump_inventory_epoch();
}

/// Dev-only: powers the "Spawn Item Drop" debug button in Settings. Adds the
/// server-spawned drop straight into local state so it appears on the ground
/// immediately, instead of waiting for the next sync tick to pick it up.
#[tauri::command]
async fn spawn_debug_drop(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    let client = Client::new();
    let drop = api::api_spawn_debug_drop(&client).await?;
    {
        let mut s = state.lock().unwrap();
        s.pending_drops.push(drop);
        s.bump_drop_epoch();
    }
    emit_state_update(&app);
    Ok(())
}

#[tauri::command]
async fn fetch_store_products() -> Result<Vec<StoreProduct>, String> {
    let client = Client::new();
    Ok(api::api_fetch_store_products(&client)
        .await
        .unwrap_or_default())
}

/// Creates a Stripe Checkout Session for `product_id` and opens it in the
/// system browser. Currency is credited only once Stripe's webhook confirms
/// payment server-side — this command never touches local/AppState currency
/// itself in that path.
///
/// Returns `true` if a browser checkout was opened, `false` if the server's
/// Stripe-less test-mode bypass fulfilled the order immediately (in which
/// case AppState is refreshed here so the new balance shows up right away).
#[tauri::command]
async fn start_purchase(
    product_id: String,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<bool, String> {
    let client = Client::new();
    match api::api_create_checkout(&client, &product_id).await? {
        Some(url) => {
            let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
            if parsed.scheme() != "https" || parsed.host_str() != Some("checkout.stripe.com") {
                return Err("Unexpected checkout URL".to_string());
            }
            std::thread::spawn(move || {
                let _ = open::that(&url);
            });
            Ok(true)
        }
        None => {
            let epoch_before = { state.lock().unwrap().equip_epoch };
            if let Some((inventory, currency, equipped)) = api::api_fetch_inventory(&client).await {
                let mut s = state.lock().unwrap();
                apply_inventory(&mut s, inventory, currency, equipped, Some(epoch_before));
                drop(s);
                emit_state_update(&app);
            }
            Ok(false)
        }
    }
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
async fn fetch_ongoing_trades() -> Result<serde_json::Value, String> {
    let client = Client::new();
    match api::api_fetch_ongoing_trades(&client).await {
        Some(trades) => Ok(serde_json::json!({ "trades": trades })),
        None => Ok(serde_json::json!({ "trades": [] })),
    }
}

#[tauri::command]
fn set_window_pinned(pinned: bool) {
    tray::set_pinned(pinned);
    storage::save_pin_window(pinned);
}

#[tauri::command]
fn get_window_pinned() -> bool {
    tray::is_pinned()
}

#[tauri::command]
fn set_ghost_mode(enabled: bool) {
    tray::set_ghost_mode(enabled);
}

#[tauri::command]
fn get_ghost_mode() -> bool {
    tray::is_ghost_mode()
}

#[tauri::command]
async fn fetch_leaderboard(board: Option<String>) -> Result<serde_json::Value, String> {
    let client = Client::new();
    match api::api_fetch_leaderboard(&client, board.as_deref()).await {
        Some(entries) => Ok(serde_json::json!({ "entries": entries })),
        None => Ok(serde_json::json!({ "entries": [] })),
    }
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
        Some((events, next)) => Ok(serde_json::json!({ "events": events, "next": next })),
        None => Ok(serde_json::json!({ "events": [], "next": null })),
    }
}

#[tauri::command]
async fn play_hint_audio(event_id: String, hint_index: u32) -> Result<serde_json::Value, String> {
    let client = Client::new();
    api::api_play_hint_audio(&client, &event_id, hint_index).await
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

/// Ingest a single chat message pushed over Supabase Realtime Broadcast. The
/// broadcast payload already carries the fully-formed message (enriched with the
/// sender's name/friend code by the DB trigger), so we append it directly to the
/// shared state instead of doing a GET round-trip per message. Deduped by id and
/// capped to the same window the GET returns; the periodic reconcile keeps the
/// canonical list authoritative.
#[tauri::command]
fn chat_ingest(
    message: ChatMessage,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    const MAX_MESSAGES: usize = 50;
    let mut s = state.lock().unwrap();
    if s.chat_messages.iter().any(|m| m.id == message.id) {
        return Ok(());
    }
    s.chat_messages.push(message);
    let len = s.chat_messages.len();
    if len > MAX_MESSAGES {
        s.chat_messages.drain(0..len - MAX_MESSAGES);
    }
    let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
    drop(s);
    let _ = app.emit("state-update", &app_state);
    Ok(())
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
    equipped: std::collections::HashMap<String, serde_json::Value>,
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

/// Apply an inventory payload to shared state.
///
/// `equip_epoch_before` distinguishes the two kinds of caller:
///
/// - `Some(epoch)` — the `equipped` came from a *snapshot* read (`/inventory`),
///   and `epoch` is the value captured before the network call. If it has moved
///   since, an equip/unequip landed while the fetch was in flight, so the
///   snapshot predates it and its `equipped` is skipped; applying it would undo
///   the change and make the item visibly pop back off in the UI.
/// - `None` — the `equipped` came from a *mutation* response (or is the current
///   in-memory value), so it is at least as new as anything local and always
///   applies.
///
/// `inventory`/`currency` are applied either way — they have their own writers
/// and aren't what this guards.
fn apply_inventory(
    s: &mut ManagedState,
    inventory: Inventory,
    currency: u32,
    equipped: std::collections::HashMap<String, serde_json::Value>,
    equip_epoch_before: Option<u64>,
) {
    s.inventory = Some(inventory.clone());
    s.inventory_currency = currency;
    // Any `/sync` already in flight predates this and must not reinstate the
    // old contents — see `inventory_epoch` and sync_tick.
    s.bump_inventory_epoch();
    storage::save_inventory_cache(&inventory, currency);
    let equipped_is_current = equip_epoch_before.is_none_or(|before| s.equip_epoch == before);
    if equipped_is_current {
        s.equipped = equipped;
        storage::save_equipped(&s.equipped);
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

    let equip_epoch_before = { shared.lock().unwrap().equip_epoch };

    let (inv_result, chat_result, friends_result) = tokio::join!(
        api::api_fetch_inventory(client),
        api::api_chat_fetch(client),
        friends_fut,
    );

    let mut changed = false;
    {
        let mut s = shared.lock().unwrap();
        if let Some((inventory, currency, equipped)) = inv_result {
            apply_inventory(
                &mut s,
                inventory,
                currency,
                equipped,
                Some(equip_epoch_before),
            );
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
    artist_image_url: Option<&str>,
    enrichment: Option<&TrackEnrichment>,
    local_genre: Option<&str>,
    current_genres: &[String],
) -> NowPlayingDisplay {
    NowPlayingDisplay {
        title: title.to_string(),
        artist: artist.to_string(),
        album_art_url: resolve_album_art_url(system_art, enrichment),
        artist_image_url: artist_image_url.map(str::to_string),
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
        let album_art_url =
            resolve_album_art_url(s.system_album_art_url.as_deref(), s.enrichment.as_ref());
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
fn fetch_system_artwork_url() -> Option<String> {
    media_remote_adapter::fetch_system_artwork_url()
}

#[cfg(windows)]
fn fetch_system_artwork_url() -> Option<String> {
    smtc_adapter::fetch_system_artwork_url()
}

#[cfg(any(target_os = "macos", windows))]
fn spawn_system_artwork_fetch(app: &AppHandle, track_key: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let artwork = tokio::task::spawn_blocking(fetch_system_artwork_url)
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
            let album_art_url =
                resolve_album_art_url(s.system_album_art_url.as_deref(), s.enrichment.as_ref());
            if let Some(ref mut np) = s.current_now_playing {
                np.album_art_url = album_art_url;
            }
            s.to_app_state(env!("CARGO_PKG_VERSION"))
        };
        let _ = app.emit("state-update", &app_state);
    });
}

#[cfg(not(any(target_os = "macos", windows)))]
fn spawn_system_artwork_fetch(_app: &AppHandle, _track_key: String) {}

/// Fetches the artist's portrait photo via our backend (Spotify search,
/// server-side so the Spotify client secret never ships in the app). Applied
/// only if the artist is still current when it resolves — a rapid artist
/// change shouldn't let a stale response clobber the new one.
fn spawn_artist_image_fetch(app: &AppHandle, artist: String, track_key: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let client = Client::new();
        let Some(image_url) = api::api_fetch_artist_image(&client, &artist).await else {
            return;
        };

        let state = app.state::<SharedState>();
        let app_state = {
            let mut s = state.lock().unwrap();
            if s.last_track_key.as_deref() != Some(track_key.as_str()) {
                return;
            }
            s.artist_image_url = Some(image_url.clone());
            if let Some(ref mut np) = s.current_now_playing {
                np.artist_image_url = Some(image_url);
            }
            s.to_app_state(env!("CARGO_PKG_VERSION"))
        };
        let _ = app.emit("state-update", &app_state);
    });
}

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

    // Collect side-effect info to act on after releasing the lock
    let mut spawn_enrichment: Option<(String, String, String)> = None;
    let mut spawn_artwork: Option<String> = None;
    let mut spawn_artist_image: Option<(String, String)> = None;

    {
        let mut s = state.lock().unwrap();
        if s.herzie.is_none() {
            return Ok(());
        }

        match np {
            // Skip tracking entirely in ghost mode, and never track a song that
            // is missing an artist name or a track title.
            Some(ref info)
                if info.is_playing
                    && !tray::is_ghost_mode()
                    && !info.title.trim().is_empty()
                    && !info.artist.trim().is_empty()
                    && info.volume > 0 =>
            {
                let key = lastfm::track_key(&info.artist, &info.title);
                let track_changed = s.last_track_key.as_deref() != Some(key.as_str());
                s.source_verified = info.verified;

                if track_changed {
                    // Distinct from track_changed: an artist photo only needs
                    // re-fetching when the artist itself changes, so back-to-back
                    // tracks off the same album keep their background image
                    // instead of flickering it out and back in.
                    let artist_changed = s
                        .current_now_playing
                        .as_ref()
                        .is_none_or(|np| np.artist != info.artist);

                    s.last_track_key = Some(key.clone());
                    s.enrichment = None;
                    s.system_album_art_url = None;
                    s.enrichment_requested_at = Some(Instant::now());
                    s.enrichment_in_flight = false;
                    #[cfg(target_os = "macos")]
                    let artwork_available = media_remote_adapter::is_configured();
                    #[cfg(windows)]
                    let artwork_available = true;
                    #[cfg(not(any(target_os = "macos", windows)))]
                    let artwork_available = false;
                    if artwork_available {
                        spawn_artwork = Some(key.clone());
                    }
                    if artist_changed {
                        s.artist_image_url = None;
                        spawn_artist_image = Some((info.artist.clone(), key.clone()));
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

                // Unverified sources (mainly browser web players, including
                // YouTube) can carry title+channel-name metadata for
                // non-music video too — only credit them, and only show them
                // as "now playing" (even locally), once Last.fm confirms the
                // track is real. See `is_confirmed_listen`.
                let confirmed = lastfm::is_confirmed_listen(
                    info.verified,
                    s.enrichment.as_ref(),
                    s.enrichment_in_flight,
                    timed_out,
                );

                let minutes = elapsed_secs as f64 / 60.0;
                if minutes > 0.01 && confirmed {
                    // Only accumulated here — never applied to herzie.xp/level
                    // locally. The server is the sole authority on XP; this
                    // just tracks unsynced listening time so sync_tick can bill
                    // it, and to_app_state can show an optimistic display-only
                    // estimate in the meantime (see ManagedState::display_herzie).
                    // Persisted so a relaunch (e.g. an app update) doesn't drop
                    // it before it reaches the server.
                    s.pending_minutes += minutes;
                    storage::save_pending_minutes(s.pending_minutes);
                }

                if let Some(ref genres) = genre_list {
                    s.current_genres = genres.clone();
                }

                s.current_now_playing = if confirmed {
                    Some(build_now_playing_display(
                        &info.title,
                        &info.artist,
                        s.system_album_art_url.as_deref(),
                        s.artist_image_url.as_deref(),
                        s.enrichment.as_ref(),
                        s.current_local_genre.as_deref(),
                        &s.current_genres,
                    ))
                } else {
                    None
                };
            }
            _ => {
                s.current_now_playing = None;
                s.current_genres.clear();
                s.current_local_genre = None;
                s.source_verified = false;
                s.last_track_key = None;
                s.system_album_art_url = None;
                s.artist_image_url = None;
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
    if let Some((artist, key)) = spawn_artist_image {
        spawn_artist_image_fetch(app, artist, key);
    }

    // Level-up/evolution notifications are sent from sync_tick, once the
    // server confirms the crossing — poll_tick no longer applies XP locally.
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

/// Best-effort flush of unsynced listening time, used before a relaunch (app
/// update) or quit so pending_minutes reaches the server sooner. Safe to
/// ignore failures — pending_minutes is persisted to disk (see
/// storage::save_pending_minutes), so a failed or timed-out flush just means
/// it's picked up on the next launch instead of being lost.
async fn flush_pending_sync(app: &AppHandle) {
    let client = Client::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), sync_tick(app, &client)).await;
}

#[tauri::command]
async fn quit(app: AppHandle) {
    flush_pending_sync(&app).await;
    app.exit(0);
}

/// Called by the frontend right before `relaunch()` during an app update, so
/// listening time accrued since the last sync is billed before the process
/// restarts instead of only being picked up on the next sync tick after
/// relaunch.
#[tauri::command]
async fn flush_before_relaunch(app: AppHandle) {
    flush_pending_sync(&app).await;
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

    #[cfg(target_os = "macos")]
    {
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

    #[cfg(windows)]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show();
    }
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

/// Show a system notification for an incoming trade invite — deduped by trade
/// ID so we don't re-notify on every poll while the trade is pending. Shared
/// by sync_tick and trade_watch_loop.
fn notify_pending_trade(app: &AppHandle, pending: Option<&PendingTradeRequest>) {
    if let Some(trade_req) = pending {
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
}

/// Lightweight poll for incoming trade invites. When the window is hidden the
/// full /sync only runs every 60s, which made trade requests feel slow — this
/// hits the cheap /trade/pending endpoint every 5s instead so the invite
/// notification arrives quickly. While visible, sync_loop already covers the
/// same data at a 5s cadence, so this loop skips its request.
async fn trade_watch_loop(app: AppHandle) {
    let client = Client::new();

    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;

        if tray::is_window_visible() {
            continue;
        }
        if !api::is_logged_in() {
            continue;
        }

        let Some(pending) = api::api_check_pending_trade(&client).await else {
            continue;
        };

        let state = app.state::<SharedState>();
        let app_state = {
            let mut s = state.lock().unwrap();
            if s.herzie.is_none() {
                continue;
            }
            s.pending_trade_request = pending.clone();
            s.to_app_state(env!("CARGO_PKG_VERSION"))
        };
        let _ = app.emit("state-update", &app_state);

        notify_pending_trade(&app, pending.as_ref());
    }
}

/// How often to check for newly-started events. `/events/active` only returns
/// events whose `starts_at <= now <= ends_at`, so polling it and watching for
/// IDs we haven't seen before tells us exactly when an event has started.
const EVENTS_WATCH_SECS: u64 = 30;

/// Watches for events that have just started and fires a native notification
/// for each one — even while the menu-bar window is hidden, which is the whole
/// point (the frontend event polling pauses when unfocused/hidden).
///
/// The set of known event IDs lives in this loop's own scope; no shared state
/// is needed since this is the only place that notifies for event starts. On
/// the first successful fetch we seed the set without notifying so we don't
/// fire a burst of notifications for events that were already running when the
/// app launched.
async fn events_watch_loop(app: AppHandle) {
    let client = Client::new();
    let mut known: HashSet<String> = HashSet::new();
    let mut seeded = false;

    loop {
        tokio::time::sleep(Duration::from_secs(EVENTS_WATCH_SECS)).await;

        if !api::is_logged_in() {
            continue;
        }

        let Some(events) = api::api_fetch_active_events(&client).await else {
            continue;
        };

        let active_now: HashSet<String> = events.iter().map(|e| e.id.clone()).collect();

        if !seeded {
            // First fetch: everything currently running counts as already-known
            // so launching the app mid-event doesn't spam notifications.
            known = active_now;
            seeded = true;
            continue;
        }

        for event in &events {
            if !known.insert(event.id.clone()) {
                continue;
            }
            let title = if event.title.trim().is_empty() {
                "A new event is starting!".to_string()
            } else {
                format!("{} is starting!", event.title)
            };
            let body = event
                .description
                .as_deref()
                .map(|d| d.trim())
                .filter(|d| !d.is_empty())
                .unwrap_or("A new event is live in Herzies.");
            send_notification(&app, &title, body, Some("events"));
            let _ = app.emit("activity", format!("{}: {}", title, body));
        }

        // Forget events that have ended so the set stays bounded (and a future
        // event reusing an ID could re-notify).
        known.retain(|id| active_now.contains(id));
    }
}

async fn sync_tick(app: &AppHandle, client: &Client) -> Result<(), String> {
    let state = app.state::<SharedState>();

    let (
        has_herzie,
        is_logged_in,
        minutes_to_sync,
        np_payload,
        genres,
        friend_epoch_before,
        drop_epoch_before,
        equip_epoch_before,
        inventory_epoch_before,
    ) = {
        let s = state.lock().unwrap();
        let has = s.herzie.is_some();
        let logged = api::is_logged_in();
        let mins = s.pending_minutes.min(10.0);
        // `current_now_playing` is only ever populated once `poll_tick` has
        // confirmed the play (see `is_confirmed_listen` there) — an
        // unconfirmed browser/YouTube play never lands here, so nothing
        // further to gate: syncing it as-is means the server never sees it
        // either (no now-playing status, no listen_log row to pollute
        // "listening now", "last played", or "top artists" on the profile).
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
                // Sync only Last.fm's remote artwork, not `np.album_art_url`
                // (which prefers the local system artwork data: URL) — that
                // blob is fine for this device's own widget but too large,
                // macOS-only, and not durable enough to store/serve to friends.
                album_art_url: s.enrichment.as_ref().and_then(|e| e.album_art_url.clone()),
            }
        });
        let g = s.current_genres.clone();
        (
            has,
            logged,
            mins,
            np,
            g,
            s.friend_epoch,
            s.drop_epoch,
            s.equip_epoch,
            s.inventory_epoch,
        )
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

        // The server can credit less than minutes_to_sync (its own elapsed-
        // wall-clock cap, or the per-sync cooldown, can reduce this to zero —
        // easy to hit here since this loop's 5s cadence is shorter than the
        // server's 8s cooldown between billable syncs). Only consume what was
        // actually billed, derived from the real total_minutes_listened delta
        // it returns; blindly subtracting minutes_to_sync discarded the
        // shortfall forever instead of retrying it on the next tick, which is
        // what produced the "XP rises then drops back" flicker.
        let credited_minutes = s
            .herzie
            .as_ref()
            .map(|h| {
                game::minutes_credited(
                    h.total_minutes_listened,
                    sync_resp.herzie.total_minutes_listened,
                )
            })
            .unwrap_or(minutes_to_sync);
        s.pending_minutes = (s.pending_minutes - credited_minutes).max(0.0);
        // Persist the decrement too — otherwise a relaunch right after a
        // successful sync would reload the pre-decrement value from disk and
        // re-bill minutes that were already confirmed.
        storage::save_pending_minutes(s.pending_minutes);

        // A friend relationship changed locally (accept/decline/cancel/add/
        // remove) while this /sync was in flight, so its server snapshot of
        // friends + requests is stale. Skip applying those fields so it can't
        // clobber the local set (e.g. briefly emptying the just-accepted friend
        // or re-showing an accepted request). The next sync reconciles.
        let friend_state_stale = s.friend_epoch != friend_epoch_before;
        let friend_codes_changed = if let Some(ref mut herzie) = s.herzie {
            let server = &sync_resp.herzie;
            herzie.xp = server.xp;
            herzie.level = server.level;
            herzie.stage = server.stage;
            herzie.total_minutes_listened = server.total_minutes_listened;
            herzie.genre_minutes = server.genre_minutes.clone();
            herzie.streak_days = server.streak_days;
            herzie.streak_last_date = server.streak_last_date.clone();
            herzie.currency = server.currency;
            let changed = if friend_state_stale {
                false
            } else {
                let changed = herzie.friend_codes != server.friend_codes;
                herzie.friend_codes = server.friend_codes.clone();
                changed
            };
            storage::save_herzie(herzie);
            changed
        } else {
            false
        };

        storage::save_multipliers(&sync_resp.multipliers);

        s.pending_trade_request = sync_resp.pending_trade_request.clone();
        // A drop was collected (or a debug drop spawned) locally while this
        // /sync was in flight, so its server snapshot of pending_drops is
        // stale — applying it would reinstate a drop the user just picked
        // up (or drop one they just got). Skip it; the next sync reconciles.
        if s.drop_epoch == drop_epoch_before {
            s.pending_drops = sync_resp.pending_drops.clone();
        }

        // /sync now carries the authoritative inventory and equip state, which
        // is what lets mutations skip their own /inventory re-fetch. Guarded
        // like the fields above: a local equip/sell/collect that landed while
        // this request was in flight makes the response's copy stale, and
        // applying it would visibly undo the change. The next sync reconciles.
        if s.equip_epoch == equip_epoch_before {
            if let Some(ref equipped) = sync_resp.equipped {
                s.equipped = equipped.clone();
                storage::save_equipped(&s.equipped);
            }
        }
        // `inventory_currency` mirrors the same balance as `herzie.currency`
        // (applied above) but is what the inventory/store/trade views read. It
        // used to be refreshed only by /inventory, so it has to be kept in step
        // here or removing those fetches would leave the coin stale.
        s.inventory_currency = sync_resp.herzie.currency;

        // Guarded on its own epoch rather than drop_epoch/equip_epoch: buying
        // changes inventory without touching either of those, so overloading
        // them would let a sync issued before a purchase reinstate the old
        // contents.
        if s.inventory_epoch == inventory_epoch_before {
            if let Some(ref inventory) = sync_resp.inventory {
                s.inventory = Some(inventory.clone());
                storage::save_inventory_cache(inventory, s.inventory_currency);
            }
        }
        if !friend_state_stale {
            s.pending_friend_request = sync_resp.pending_friend_request.clone();
            s.incoming_friend_requests = sync_resp.incoming_friend_requests.clone();
            s.outgoing_friend_requests = sync_resp.outgoing_friend_requests.clone();
        }

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

        // Show notification for incoming trade requests.
        notify_pending_trade(app, sync_resp.pending_trade_request.as_ref());

        // Show notification for incoming friend requests — dedupe by request ID
        // so we don't re-notify on every sync tick while it's pending.
        if let Some(friend_req) = &sync_resp.pending_friend_request {
            let should_notify = {
                let state = app.state::<LastFriendNotified>();
                let mut last = state.0.lock().unwrap();
                if last.as_deref() == Some(friend_req.request_id.as_str()) {
                    false
                } else {
                    *last = Some(friend_req.request_id.clone());
                    true
                }
            };
            if should_notify {
                let msg = format!("{} wants to be your friend!", friend_req.from_name);
                send_notification(app, "Friend Request", &msg, Some("friends:requests"));
                let _ = app.emit("activity", format!("Friend Request: {}", msg));
            }
        } else if let Ok(mut last) = app.state::<LastFriendNotified>().0.lock() {
            *last = None;
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

        // A grant used to need its own /inventory fetch to become visible; the
        // response that announced it now carries the resulting inventory too.
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
            log::warn!(
                "adopt_local_herzie: owner mismatch or missing session — clearing local herzie file"
            );
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
            // Passed only when macOS launches us at login, so a cold start can
            // tell "user opened the app" (show the window) apart from "launched
            // at login" (stay hidden in the menu bar).
            Some(vec!["--autostart"]),
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
        .manage(LastFriendNotified(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_state,
            login,
            logout,
            register_herzie,
            friend_add,
            friend_remove,
            friend_lookup,
            friend_request_accept,
            friend_request_decline,
            friend_request_cancel,
            friend_search,
            fetch_inventory,
            sell_item,
            buy_item,
            collect_drop,
            spawn_debug_drop,
            equip_item,
            fetch_store_products,
            start_purchase,
            trade_create,
            trade_join,
            trade_offer,
            trade_lock,
            trade_accept,
            trade_cancel,
            trade_poll,
            fetch_ongoing_trades,
            set_window_pinned,
            get_window_pinned,
            set_ghost_mode,
            get_ghost_mode,
            fetch_active_events,
            fetch_previous_hunt,
            play_hint_audio,
            fetch_leaderboard,
            get_auth_config,
            chat_fetch,
            chat_send,
            chat_ingest,
            test_notification,
            test_activity,
            debug_media_remote_now_playing,
            quit,
            flush_before_relaunch,
            open_external_url,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use std::path::PathBuf;
                use tauri::path::BaseDirectory;

                let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mediaremote");
                let script = app
                    .path()
                    .resolve(
                        "mediaremote/mediaremote-adapter.pl",
                        BaseDirectory::Resource,
                    )
                    .ok()
                    .filter(|p| p.is_file())
                    .unwrap_or_else(|| dev.join("mediaremote-adapter.pl"));
                let framework = std::env::current_exe()
                    .ok()
                    .and_then(|exe| {
                        let contents = exe.parent()?.parent()?;
                        let fw = contents.join("Frameworks/MediaRemoteAdapter.framework");
                        fw.is_dir().then_some(fw)
                    })
                    .unwrap_or_else(|| dev.join("MediaRemoteAdapter.framework"));
                if script.is_file() && framework.is_dir() {
                    media_remote_adapter::init(script, framework);
                    log::info!(
                        "MediaRemote adapter: {:?}",
                        media_remote_adapter::is_configured()
                    );
                } else {
                    log::warn!(
                        "MediaRemote adapter files missing; now playing falls back to AppleScript"
                    );
                }
            }

            // Set notification bundle ID so clicks activate this app (macOS only —
            // mac-notification-sys is the send mechanism there; Windows sends via
            // tauri-plugin-notification instead, see `send_notification`).
            #[cfg(target_os = "macos")]
            {
                let bundle_id = if tauri::is_dev() {
                    "com.apple.Terminal"
                } else {
                    &app.config().identifier
                };
                let _ = mac_notification_sys::set_application(bundle_id);
            }

            // Hide dock icon (menu bar only)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Set up tray icon
            tray::setup_tray(app.handle())?;

            // Restore the "pin window" preference (keep window open on blur)
            tray::set_pinned(storage::load_pin_window());

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

                // Cold start: if the user opened the app themselves (rather than
                // it being launched at login), surface the window. Without this,
                // quitting and reopening the app only re-shows the tray icon and
                // nothing visibly happens.
                let launched_at_login = std::env::args().any(|arg| arg == "--autostart");
                if !launched_at_login {
                    tray::ensure_visible(app.handle());
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

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(trade_watch_loop(app_handle));

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(events_watch_loop(app_handle));

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
        .run(|_app_handle, _event| {
            // macOS sends Reopen when the app is re-activated — including via
            // a notification click. Surfacing the window here triggers the
            // existing on_focus chain which emits any pending deep link.
            #[cfg(target_os = "macos")]
            if matches!(_event, tauri::RunEvent::Reopen { .. }) {
                tray::ensure_visible(_app_handle);
            }
        });
}
