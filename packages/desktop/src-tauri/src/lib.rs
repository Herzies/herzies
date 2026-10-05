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

use lastfm::{LastFmService, TrackEnrichment, ENRICHMENT_RETRY, ENRICHMENT_TIMEOUT};
use reqwest::Client;
use state::{ManagedState, SharedState};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use types::*;

const MAX_FRIENDS: usize = 50;

// Wrapped in newtype structs so Tauri's type-keyed state manager can
// distinguish them — a plain `type` alias resolves to the same Rust type
// and would collide on the second `.manage()` call.
pub struct PendingDeepLink(pub Mutex<Option<String>>);
pub struct LastTradeNotified(pub Mutex<Option<String>>);
pub struct LastFriendNotified(pub Mutex<Option<String>>);
/// Cancels the in-flight browser login, if any.
pub struct LoginAttempt(pub Mutex<Option<tokio::sync::oneshot::Sender<()>>>);
/// Whether the last sync tick found a pick-up accessory (spirit-orb) unable to
/// collect a drop because the bank was full. A bool, not an id: unlike a trade
/// or friend request there's no single thing to dedupe by, just a condition
/// that can flip back and forth as slots free up and fill again.
pub struct LastInventoryFullNotified(pub Mutex<bool>);
/// Hands `sync_loop` a track that just ended, so it's synced right away under
/// its own now-playing and genres — see `OutgoingTrack`.
pub struct SyncNudge(pub tokio::sync::mpsc::UnboundedSender<OutgoingTrack>);

/// A track that just stopped being current (the next one started, or playback
/// stopped), captured by `poll_tick` before it overwrites the state.
///
/// While hidden, the regular sync only runs every 60s, and a sync is the only
/// moment the server sees what's playing: song-hunt detection and the
/// `listen_log` row both key off a sync's `nowPlaying`, and the minutes it
/// bills are credited to its `genres` (genre XP, boss damage). On a timer
/// alone, a song shorter than the interval could play start to finish between
/// syncs and never be seen, and minutes from one track were billed to
/// whichever track happened to be playing when the timer fired. Flushing each
/// track as it ends fixes both — it sees every track, and bills its minutes to
/// its own genres.
pub struct OutgoingTrack {
    pub now_playing: NowPlayingPayload,
    pub genres: Vec<String>,
}

/// A track has to have played this long to be flushed when it ends, so
/// skipping through a playlist doesn't fire a sync per skipped track.
const MIN_FLUSH_PLAY: Duration = Duration::from_secs(15);

/// Minimum gap between syncs when a flush comes in right after another sync.
/// Just above the server's 8s billing cooldown, so a flush's minutes are
/// actually billed rather than deferred.
const MIN_SYNC_SPACING: Duration = Duration::from_secs(10);

/// What `/sync` should report as now playing, from the current state.
///
/// `current_now_playing` is only ever populated once `poll_tick` has confirmed
/// the play (see `is_confirmed_listen` there) — an unconfirmed browser/YouTube
/// play never lands here, so nothing further to gate: syncing it as-is means
/// the server never sees it either (no now-playing status, no listen_log row
/// to pollute "listening now", "last played", or "top artists" on the
/// profile).
fn now_playing_payload(s: &ManagedState) -> Option<NowPlayingPayload> {
    s.current_now_playing.as_ref().map(|np| {
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
            // (which prefers the local system artwork data: URL) — that blob
            // is fine for this device's own widget but too large, macOS-only,
            // and not durable enough to store/serve to friends.
            album_art_url: s.enrichment.as_ref().and_then(|e| e.album_art_url.clone()),
        }
    })
}

/// The current track as an `OutgoingTrack`, if it should be flushed now that
/// it's ending. Never in ghost mode: switching ghost mode on also ends the
/// track, and that must not report it.
fn outgoing_track(s: &ManagedState) -> Option<OutgoingTrack> {
    if tray::is_ghost_mode() || s.track_started_at?.elapsed() < MIN_FLUSH_PLAY {
        return None;
    }
    Some(OutgoingTrack {
        now_playing: now_playing_payload(s)?,
        genres: s.current_genres.clone(),
    })
}

// --- Tauri commands ---

#[tauri::command]
fn get_state(state: tauri::State<SharedState>) -> AppState {
    let s = state.lock().unwrap();
    s.to_app_state(env!("CARGO_PKG_VERSION"))
}

#[tauri::command]
async fn login(app: AppHandle, attempt: tauri::State<'_, LoginAttempt>) -> Result<(), String> {
    // Replacing the sender drops (and so cancels) any attempt still in flight.
    let (tx, rx) = tokio::sync::oneshot::channel();
    attempt.0.lock().unwrap().replace(tx);
    auth::login(&app, rx)
        .await
        .map_err(|e| e.code().to_string())
}

#[tauri::command]
fn cancel_login(attempt: tauri::State<LoginAttempt>) {
    if let Some(tx) = attempt.0.lock().unwrap().take() {
        let _ = tx.send(());
    }
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

    let client = api::http();

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
                    let client = api::http();
                    refresh_app_cache(&app_clone, &client, true).await;
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
    // Mirrors MAX_FRIENDS in packages/web/src/lib/friends.ts — the server
    // enforces it; this just answers without a round trip.
    if friend_codes_len >= MAX_FRIENDS {
        return Ok(FriendResult {
            success: false,
            message: format!("Friend list full (max {MAX_FRIENDS})"),
        });
    }

    let client = api::http();
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
        let client = api::http();
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

    let client = api::http();
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
    let client = api::http();
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
    let client = api::http();
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
async fn set_share_listening(
    share: bool,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    let client = api::http();
    let server = api::api_set_share_listening(&client, share).await?;
    let mut s = state.lock().unwrap();
    if let Some(ref mut herzie) = s.herzie {
        herzie.share_listening = server.share_listening;
        storage::save_herzie(herzie);
    }
    drop(s);
    emit_state_update(&app);
    Ok(())
}

#[tauri::command]
async fn friend_search(query: String) -> Result<Vec<FriendSearchResult>, String> {
    let client = api::http();
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

    let client = api::http();
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
    let client = api::http();
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
    let client = api::http();
    let epoch_before = { state.lock().unwrap().equip_epoch };
    match api::api_fetch_inventory(&client).await {
        Some(snapshot) => {
            let mut s = state.lock().unwrap();
            let inventory = snapshot.inventory.clone();
            let currency = snapshot.currency;
            let item_upgrades = snapshot.item_upgrades.clone();
            apply_inventory(&mut s, snapshot, Some(epoch_before));
            // Hand back whatever `equipped`/`units` actually won, so a caller
            // that raced an equip doesn't render the stale snapshot we just
            // skipped.
            let equipped = s.equipped.clone();
            let units = s.units.clone();
            drop(s);
            emit_state_update(&app);
            Ok(Some(InventoryResult {
                inventory,
                currency,
                equipped,
                item_upgrades,
                units,
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn sell_item(
    unit_ids: Vec<String>,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<Option<serde_json::Value>, String> {
    let client = api::http();
    let result = api::api_sell_units(&client, &unit_ids).await;
    if let Some(ref data) = result {
        let mut s = state.lock().unwrap();
        let mut changed = false;
        // Selling a worn copy unequips it server-side too (it simply stops
        // existing) — apply whatever the response says rather than the stale
        // local equip state, so the two never drift apart.
        if let Some(snapshot) = snapshot_from_response(data, &s) {
            apply_inventory(&mut s, snapshot, None);
            // Selling can unequip server-side, so this is a local `equipped`
            // mutation — any `/inventory` fetch in flight must not undo it.
            s.bump_equip_epoch();
            changed = true;
        } else if let Some(new_currency) = data["newCurrency"].as_u64() {
            s.inventory_currency = new_currency as u32;
            if let Some(ref inv) = s.inventory {
                storage::save_inventory_cache(
                    inv,
                    s.inventory_currency,
                    &s.item_upgrades,
                    &s.units,
                    s.bank_expansions,
                );
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

/// Rolls one dice item onto ONE specific card (see DICE_TIERS in
/// @herzies/shared) — its twin, a second copy of the same card, is untouched.
/// The server rolls; the response says how it landed and carries the
/// authoritative item state, applied the same way a sell's does (a destroyed
/// card simply isn't in it any more).
#[tauri::command]
async fn apply_dice_upgrade(
    dice_item_id: String,
    target_unit_id: String,
    protection_item_id: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let client = api::http();
    let data = api::api_apply_dice_upgrade(
        &client,
        &dice_item_id,
        &target_unit_id,
        protection_item_id.as_deref(),
    )
    .await?;

    let mut s = state.lock().unwrap();
    if let Some(snapshot) = snapshot_from_response(&data, &s) {
        apply_inventory(&mut s, snapshot, None);
        drop(s);
        emit_state_update(&app);
    }
    Ok(data)
}

#[tauri::command]
async fn equip_item(
    unit_id: String,
    action: String,
    side: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let client = api::http();
    let result = api::api_equip_unit(&client, &unit_id, &action, side.as_deref()).await?;
    let mut s = state.lock().unwrap();
    if let Some(snapshot) = snapshot_from_response(&result, &s) {
        apply_inventory(&mut s, snapshot, None);
        // Any `/inventory` fetch already in flight was issued before this
        // change and would otherwise clobber it back — see apply_inventory.
        s.bump_equip_epoch();
        drop(s);
        emit_state_update(&app);
    }
    Ok(result)
}

/// Buys from Good ol' George (a live `merchant` event) — the only way coins
/// buy items. Applies the returned item state and the new coin balance.
#[tauri::command]
async fn buy_from_merchant(
    event_id: String,
    item_id: String,
    quantity: u32,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let client = api::http();
    let data = api::api_buy_from_merchant(&client, &event_id, &item_id, quantity).await?;

    let mut s = state.lock().unwrap();
    let mut changed = false;
    if let Some(snapshot) = snapshot_from_response(&data, &s) {
        apply_inventory(&mut s, snapshot, None);
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
    let client = api::http();

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
            // The server mints the copy under the drop's own id
            // (collect_pending_drop), so this placeholder IS the real copy —
            // there's no temporary id to reconcile once the call confirms.
            s.units.push(ItemUnit {
                id: drop.id.clone(),
                item_id: drop.item_id.clone(),
                upgrade_level: 0,
                equipped_slot: None,
            });
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
            // the reconcile below, so the pickup line waited on two
            // sequential round trips — the second to Vercel `/api/inventory` —
            // and lagged visibly behind the item vanishing from the ground.
            //
            // Same `Picked up "<name>"` wording as the Greedy Spirit's
            // server-side auto-collect (see game-server.ts) — this path has
            // no SyncResponse to ride along on, so log it directly.
            let _ = app.emit("activity", format!("Picked up \"{name}\""));

            // No /inventory re-fetch here. `collect_pending_drop` does exactly
            // one thing — delete the drop row and mint a copy under its id —
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
    s.units.retain(|u| u.id != drop.id);
    s.pending_drops.push(drop);
    s.bump_drop_epoch();
    s.bump_inventory_epoch();
}

/// Dev-only: powers the "Spawn Item Drop"/"Spawn Dice Drop" debug buttons in
/// Settings. Adds the server-spawned drop straight into local state so it
/// appears on the ground immediately, instead of waiting for the next sync
/// tick to pick it up.
#[tauri::command]
async fn spawn_debug_drop(
    dice_only: bool,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    let client = api::http();
    let drop = api::api_spawn_debug_drop(&client, dice_only).await?;
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
    let client = api::http();
    Ok(api::api_fetch_store_products(&client)
        .await
        .unwrap_or_default())
}

#[tauri::command]
async fn fetch_premium_items() -> Result<Vec<PremiumItem>, String> {
    let client = api::http();
    Ok(api::api_fetch_premium_items(&client)
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
    let client = api::http();
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
            if let Some(snapshot) = api::api_fetch_inventory(&client).await {
                let mut s = state.lock().unwrap();
                apply_inventory(&mut s, snapshot, Some(epoch_before));
                drop(s);
                emit_state_update(&app);
            }
            Ok(false)
        }
    }
}

#[tauri::command]
async fn trade_create(target_code: String) -> Result<Option<serde_json::Value>, String> {
    let client = api::http();
    Ok(api::api_create_trade(&client, &target_code).await)
}

#[tauri::command]
async fn trade_join(trade_id: String) -> Result<bool, String> {
    let client = api::http();
    Ok(api::api_join_trade(&client, &trade_id).await)
}

#[tauri::command]
async fn trade_offer(trade_id: String, offer: TradeOfferRequest) -> Result<bool, String> {
    let client = api::http();
    Ok(api::api_update_trade_offer(&client, &trade_id, &offer).await)
}

#[tauri::command]
async fn trade_lock(trade_id: String) -> Result<bool, String> {
    let client = api::http();
    Ok(api::api_lock_trade(&client, &trade_id).await)
}

#[tauri::command]
async fn trade_accept(trade_id: String) -> Result<Option<serde_json::Value>, String> {
    let client = api::http();
    Ok(api::api_accept_trade(&client, &trade_id).await)
}

#[tauri::command]
async fn trade_cancel(trade_id: String) -> Result<bool, String> {
    let client = api::http();
    Ok(api::api_cancel_trade(&client, &trade_id).await)
}

#[tauri::command]
async fn trade_poll(trade_id: String) -> Result<Option<Trade>, String> {
    let client = api::http();
    Ok(api::api_poll_trade(&client, &trade_id).await)
}

#[tauri::command]
async fn fetch_ongoing_trades() -> Result<serde_json::Value, String> {
    let client = api::http();
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
    let client = api::http();
    match api::api_fetch_leaderboard(&client, board.as_deref()).await {
        Some(entries) => Ok(serde_json::json!({ "entries": entries })),
        None => Ok(serde_json::json!({ "entries": [] })),
    }
}

#[tauri::command]
async fn fetch_active_events() -> Result<serde_json::Value, String> {
    let client = api::http();
    match api::api_fetch_active_events(&client).await {
        Some(data) => Ok(serde_json::json!({
            "events": data.events,
            "upcoming": data.upcoming,
        })),
        None => Ok(serde_json::json!({ "events": [] })),
    }
}

#[tauri::command]
async fn fetch_previous_hunt() -> Result<serde_json::Value, String> {
    let client = api::http();
    match api::api_fetch_previous_hunt(&client).await {
        Some((events, next)) => Ok(serde_json::json!({ "events": events, "next": next })),
        None => Ok(serde_json::json!({ "events": [], "next": null })),
    }
}

#[tauri::command]
async fn play_hint_audio(event_id: String, hint_index: u32) -> Result<serde_json::Value, String> {
    let client = api::http();
    api::api_play_hint_audio(&client, &event_id, hint_index).await
}

#[tauri::command]
async fn get_auth_config() -> Result<Option<AuthConfig>, String> {
    let client = api::http();
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
    let client = api::http();
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
    let client = api::http();
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

/// Ingest a trade request that arrived over the Realtime broadcast channel.
///
/// Counterpart to `chat_ingest`. This is the only fast path for invites: the
/// 5s hidden-window `/trade-pending` poll that backed it up is gone, leaving
/// `sync_tick` (at most 60s apart while hidden) as the fallback if the webview's
/// socket drops while the window sits in the tray. The DB trigger
/// (00058_trade_request_broadcast.sql) sends the initiator's name and friend
/// code with the payload, so this needs no round-trip to render.
///
/// Races with `sync_tick` are handled by
/// `trade_epoch`: a poll that was already in flight when this landed predates
/// the trade, and would otherwise hide the invite again (and reset the
/// notification dedupe, so the next poll re-notified).
#[tauri::command]
fn trade_request_ingest(
    request: PendingTradeRequest,
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    {
        let mut s = state.lock().unwrap();
        if s.herzie.is_none() {
            return Ok(());
        }
        // Don't clobber a trade the user is already dealing with.
        if s.pending_trade_request
            .as_ref()
            .is_some_and(|p| p.trade_id == request.trade_id)
        {
            return Ok(());
        }
        s.pending_trade_request = Some(request.clone());
        s.trade_epoch += 1;
        let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
        drop(s);
        let _ = app.emit("state-update", &app_state);
    }

    notify_pending_trade(&app, Some(&request));
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
#[serde(rename_all = "camelCase")]
struct InventoryResult {
    inventory: Inventory,
    currency: u32,
    equipped: std::collections::HashMap<String, serde_json::Value>,
    item_upgrades: ItemUpgrades,
    units: Vec<ItemUnit>,
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
fn apply_inventory(s: &mut ManagedState, snapshot: ItemSnapshot, equip_epoch_before: Option<u64>) {
    let ItemSnapshot {
        inventory,
        currency,
        equipped,
        item_upgrades,
        units,
    } = snapshot;
    s.inventory = Some(inventory.clone());
    s.inventory_currency = currency;
    s.item_upgrades = item_upgrades.clone();
    // Any `/sync` already in flight predates this and must not reinstate the
    // old contents — see `inventory_epoch` and sync_tick.
    s.bump_inventory_epoch();
    let equipped_is_current = equip_epoch_before.is_none_or(|before| s.equip_epoch == before);
    if equipped_is_current {
        s.equipped = equipped;
        storage::save_equipped(&s.equipped);
        // The copies carry worn state too, so they are exactly as stale as
        // `equipped` when an equip raced this snapshot. Left alone in that case
        // (a `None` from a server that predates copies leaves them alone too);
        // the next sync reconciles.
        if let Some(units) = units {
            s.units = units;
        }
    }
    storage::save_inventory_cache(
        &inventory,
        currency,
        &item_upgrades,
        &s.units,
        s.bank_expansions,
    );
}

/// Reads the item state out of an inventory-changing response (sell, buy,
/// equip, upgrade). Anything the response doesn't carry falls back to what we
/// already hold, so a call that changes only some of it (a buy never touches
/// levels) doesn't blank the rest. `None` when there's no `inventory` at all,
/// i.e. the response wasn't a success carrying state.
fn snapshot_from_response(data: &serde_json::Value, s: &ManagedState) -> Option<ItemSnapshot> {
    let inventory = serde_json::from_value::<Inventory>(data["inventory"].clone()).ok()?;
    let currency = data["newCurrency"]
        .as_u64()
        .map(|c| c as u32)
        .unwrap_or(s.inventory_currency);
    let equipped = serde_json::from_value::<std::collections::HashMap<String, serde_json::Value>>(
        data["equipped"].clone(),
    )
    .unwrap_or_else(|_| s.equipped.clone());
    let item_upgrades = serde_json::from_value::<ItemUpgrades>(data["itemUpgrades"].clone())
        .unwrap_or_else(|_| s.item_upgrades.clone());
    let units = serde_json::from_value::<Vec<ItemUnit>>(data["units"].clone()).ok();
    Some(ItemSnapshot {
        inventory,
        currency,
        equipped,
        item_upgrades,
        units,
    })
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
///
/// `include_inventory` is false at launch, where a `sync_tick` has just run and
/// `/sync` already carries the full inventory; after login or hatching no sync
/// has loaded it yet, so those callers still fetch it.
async fn refresh_app_cache(app: &AppHandle, client: &Client, include_inventory: bool) {
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

    let inventory_fut = async {
        if include_inventory {
            api::api_fetch_inventory(client).await
        } else {
            None
        }
    };

    let (inv_result, chat_result, friends_result) =
        tokio::join!(inventory_fut, api::api_chat_fetch(client), friends_fut,);

    let mut changed = false;
    {
        let mut s = shared.lock().unwrap();
        if let Some(snapshot) = inv_result {
            apply_inventory(&mut s, snapshot, Some(equip_epoch_before));
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
    let client = api::http();
    let mut last_tick = Instant::now();

    loop {
        // 3s while the window is open (tight feedback for the now-playing card),
        // 6s while hidden — XP/min is unchanged because poll_tick credits real
        // elapsed time, not a fixed slice. Real elapsed includes the previous
        // tick's own duration (the now-playing read can take seconds through
        // the AppleScript fallback), which crediting `delay` alone dropped.
        // Capped so a machine waking from sleep doesn't bill the whole nap to
        // whatever was playing when the lid closed.
        let delay = if tray::is_window_visible() { 3 } else { 6 };
        tokio::time::sleep(Duration::from_secs(delay)).await;

        let elapsed = last_tick.elapsed().as_secs_f64().min(2.0 * delay as f64);
        last_tick = Instant::now();
        if let Err(e) = poll_tick(&app, &client, elapsed).await {
            log::warn!("Poll error: {}", e);
        }
    }
}

/// How often `poll_tick` persists the growing `pending_minutes` (see
/// `ManagedState::pending_minutes_saved_at`). A crash loses at most this much
/// unsynced listening; a clean quit or relaunch loses none (`flush_pending_sync`).
const PENDING_MINUTES_SAVE_EVERY: Duration = Duration::from_secs(30);

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
async fn fetch_system_artwork_url() -> Option<String> {
    media_remote_adapter::fetch_system_artwork_url().await
}

#[cfg(windows)]
async fn fetch_system_artwork_url() -> Option<String> {
    tokio::task::spawn_blocking(smtc_adapter::fetch_system_artwork_url)
        .await
        .ok()
        .flatten()
}

#[cfg(any(target_os = "macos", windows))]
fn spawn_system_artwork_fetch(app: &AppHandle, track_key: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(artwork) = fetch_system_artwork_url().await else {
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
        let client = api::http();
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

async fn poll_tick(app: &AppHandle, _client: &Client, elapsed_secs: f64) -> Result<(), String> {
    let state = app.state::<SharedState>();
    let lastfm = app.state::<LastFmService>();

    let (has_herzie, np_before, minutes_before) = {
        let s = state.lock().unwrap();
        (
            s.herzie.is_some(),
            s.current_now_playing.clone(),
            s.pending_minutes,
        )
    };

    if !has_herzie {
        return Ok(());
    }

    let np = nowplaying::get_now_playing().await;

    // Collect side-effect info to act on after releasing the lock
    let mut spawn_enrichment: Option<(String, String, String)> = None;
    let mut spawn_artwork: Option<String> = None;
    let mut spawn_artist_image: Option<(String, String)> = None;
    let mut outgoing: Option<OutgoingTrack> = None;

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
                    outgoing = outgoing_track(&s);
                    s.track_started_at = Some(Instant::now());
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
                } else if !info.verified
                    && s.enrichment.is_none()
                    && !s.enrichment_in_flight
                    && lastfm.has_api_key()
                    && s.enrichment_requested_at
                        .is_none_or(|t| t.elapsed() > ENRICHMENT_RETRY)
                {
                    // An unverified source only counts once Last.fm confirms
                    // it (see `is_confirmed_listen`), so a failed lookup
                    // (network error, rate-limit backoff) would otherwise
                    // block the whole track. Retry, throttled.
                    s.enrichment_requested_at = Some(Instant::now());
                    s.enrichment_in_flight = true;
                    spawn_enrichment = Some((info.artist.clone(), info.title.clone(), key.clone()));
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
                let confirmed = lastfm::is_confirmed_listen(info.verified, s.enrichment.as_ref());

                let minutes = elapsed_secs / 60.0;
                if minutes > 0.01 && confirmed {
                    // Only accumulated here — never applied to herzie.xp/level
                    // locally. The server is the sole authority on XP; this
                    // just tracks unsynced listening time so sync_tick can bill
                    // it, and to_app_state can show an optimistic display-only
                    // estimate in the meantime (see ManagedState::display_herzie).
                    // Persisted so a relaunch (e.g. an app update) doesn't drop
                    // it before it reaches the server.
                    s.pending_minutes += minutes;
                    if s.pending_minutes_saved_at
                        .is_none_or(|t| t.elapsed() >= PENDING_MINUTES_SAVE_EVERY)
                    {
                        storage::save_pending_minutes(s.pending_minutes);
                        s.pending_minutes_saved_at = Some(Instant::now());
                    }
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
                if s.last_track_key.is_some() {
                    outgoing = outgoing_track(&s);
                }
                s.track_started_at = None;
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
    if let Some(track) = outgoing {
        if let Some(nudge) = app.try_state::<SyncNudge>() {
            let _ = nudge.0.send(track);
        }
    }

    // Level-up/evolution notifications are sent from sync_tick, once the
    // server confirms the crossing — poll_tick no longer applies XP locally.
    //
    // This runs every 3s and the push carries the whole AppState (inventory,
    // chat, friends…), so only send it when this tick changed something the
    // window shows — the now-playing card or the optimistic XP (which follows
    // pending_minutes) — and only while someone can see it: showing the
    // window pushes fresh state anyway (tray::on_focus / show_window).
    let app_state = {
        let s = state.lock().unwrap();
        let changed = s.current_now_playing != np_before || s.pending_minutes != minutes_before;
        if !changed || !tray::is_window_visible() {
            return Ok(());
        }
        s.to_app_state(env!("CARGO_PKG_VERSION"))
    };
    let _ = app.emit("state-update", &app_state);

    Ok(())
}

#[tauri::command]
fn test_notification(app: AppHandle) {
    send_notification(
        &app,
        "Nostalgic Token",
        "Picked up \"Nostalgic Token\"",
        Some("cd"),
    );
    let _ = app.emit("activity", "Picked up \"Nostalgic Token\"".to_string());
}

#[tauri::command]
fn test_activity(app: AppHandle) {
    let _ = app.emit("activity", "Test activity log entry");
}

/// Raw JSON from macOS MediaRemote (debug). Returns `null` when unavailable or empty.
#[tauri::command]
async fn debug_media_remote_now_playing() -> Option<String> {
    nowplaying::raw_media_remote_json().await
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
    let client = api::http();
    let _ = tokio::time::timeout(Duration::from_secs(3), sync_tick(app, &client)).await;
    // poll_tick only persists pending_minutes every PENDING_MINUTES_SAVE_EVERY,
    // so write whatever the sync didn't bill before the process goes away.
    let s = app.state::<SharedState>();
    let s = s.lock().unwrap();
    storage::save_pending_minutes(s.pending_minutes);
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
            if let Err(e) = n.send() {
                log::warn!("macOS notification delivery failed: {e}");
            }
        });
    }

    #[cfg(windows)]
    {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show()
        {
            log::warn!("Windows notification delivery failed: {e}");
        }
    }
}

async fn sync_loop(
    app: AppHandle,
    mut nudges: tokio::sync::mpsc::UnboundedReceiver<OutgoingTrack>,
) {
    let client = api::http();
    let mut last_sync: Option<Instant> = None;

    loop {
        // 10s while focused: the server only bills a sync every 8s (see the
        // cooldown note in sync_tick), so the old 5s cadence made every other
        // call a full-cost no-op. Trade invites and chat no longer depend on
        // this — they arrive over Realtime. 30s for a pinned window the user
        // has moved away from (still on screen, nobody interacting), 60s when
        // hidden. Every track that ends is also synced on its own via
        // `OutgoingTrack` (which restarts this timer), so short songs are
        // never missed between ticks.
        let delay = if tray::is_window_focused() {
            10
        } else if tray::is_window_visible() {
            30
        } else {
            60
        };
        let outgoing = tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(delay)) => None,
            Some(track) = nudges.recv() => Some(track),
        };
        if outgoing.is_some() {
            if let Some(since) = last_sync.map(|t| t.elapsed()) {
                if since < MIN_SYNC_SPACING {
                    tokio::time::sleep(MIN_SYNC_SPACING - since).await;
                }
            }
        }

        if let Err(e) = sync_tick_with(&app, &client, outgoing).await {
            log::warn!("Sync error: {}", e);
        }
        last_sync = Some(Instant::now());
    }
}

/// Show a system notification for an incoming trade invite — deduped by trade
/// ID so we don't re-notify on every poll while the trade is pending. Shared
/// by sync_tick and trade_request_ingest.
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

/// How often to check for newly-started events. `/events/active` only returns
/// events whose `starts_at <= now <= ends_at`, so polling it and watching for
/// IDs we haven't seen before tells us exactly when an event has started.
///
/// Scheduled events don't depend on this interval: the response also lists the
/// next `upcoming` start per type, and the loop wakes just after the soonest
/// one (see `next_events_wake`). The interval only bounds how late an event
/// created to start immediately (admin tools) can be noticed. It was 30s, which
/// made this the second-largest source of calls for an idle app.
const EVENTS_WATCH_SECS: u64 = 120;

/// Grace after an upcoming event's `starts_at` before checking for it, so the
/// fetch doesn't land a hair early (clock skew) and miss it.
const EVENTS_START_GRACE_SECS: u64 = 3;

/// Seconds since the UNIX epoch for an RFC 3339 timestamp as Postgres/PostgREST
/// emits them (`2026-10-05T18:00:00+00:00`, `...00.123Z`). `None` for anything
/// else — the caller then just falls back to the regular interval.
fn parse_rfc3339_secs(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    let num = |r: std::ops::Range<usize>| -> Option<i64> { ts.get(r)?.parse().ok() };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b' ') {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    // Skip fractional seconds, then read the offset.
    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        i += 1;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
    }
    let offset = match b.get(i) {
        Some(b'Z') | None => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh = num(i + 1..i + 3)?;
            let om = if b.get(i + 3) == Some(&b':') {
                num(i + 4..i + 6)?
            } else {
                num(i + 3..i + 5).unwrap_or(0)
            };
            let o = oh * 3600 + om * 60;
            if *sign == b'+' {
                o
            } else {
                -o
            }
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + sec - offset)
}

/// How long `events_watch_loop` should sleep: the regular interval, or less if
/// an upcoming event starts sooner than that.
fn next_events_wake(upcoming: &[GameEvent], now_secs: i64) -> Duration {
    let soonest = upcoming
        .iter()
        .filter_map(|e| parse_rfc3339_secs(&e.starts_at))
        .filter(|&t| t > now_secs)
        .min();
    let until = soonest.map_or(EVENTS_WATCH_SECS, |t| {
        ((t - now_secs) as u64 + EVENTS_START_GRACE_SECS).min(EVENTS_WATCH_SECS)
    });
    Duration::from_secs(until)
}

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
    let client = api::http();
    let mut known: HashSet<String> = HashSet::new();
    let mut seeded = false;
    // First fetch soon after launch: it seeds `known` without notifying, so
    // anything that starts before it lands is never announced — a full
    // interval here would silently swallow two minutes of event starts.
    let mut wake = Duration::from_secs(5);

    loop {
        tokio::time::sleep(wake).await;
        wake = Duration::from_secs(EVENTS_WATCH_SECS);

        if !api::is_logged_in() {
            continue;
        }

        let Some(data) = api::api_fetch_active_events(&client).await else {
            continue;
        };
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        wake = next_events_wake(&data.upcoming, now_secs);
        let events = data.events;

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
            // Every event is a visitor arriving in Town (see VISITORS in
            // @herzies/shared): George and bosses by their own names, a song
            // hunt as Orphiez.
            let title = match event.event_type.as_str() {
                "song_hunt" => "Orphiez is in town!".to_string(),
                _ if event.title.trim().is_empty() => "Someone's in town!".to_string(),
                _ => format!("{} is in town!", event.title),
            };
            let fallback_body = if event.event_type == "song_hunt" {
                "He's lost a song. Help him find it."
            } else {
                "Someone new has arrived in Town."
            };
            let body = event
                .description
                .as_deref()
                .map(|d| d.trim())
                .filter(|d| !d.is_empty())
                .unwrap_or(fallback_body);
            send_notification(&app, &title, body, Some("events"));
            let _ = app.emit("activity", format!("{}: {}", title, body));
        }

        // Forget events that have ended so the set stays bounded (and a future
        // event reusing an ID could re-notify).
        known.retain(|id| active_now.contains(id));
    }
}

async fn sync_tick(app: &AppHandle, client: &Client) -> Result<(), String> {
    sync_tick_with(app, client, None).await
}

/// `sync_tick`, optionally reporting a track that just ended (`outgoing`) in
/// place of the current one — see `OutgoingTrack`.
async fn sync_tick_with(
    app: &AppHandle,
    client: &Client,
    outgoing: Option<OutgoingTrack>,
) -> Result<(), String> {
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
        trade_epoch_before,
    ) = {
        let s = state.lock().unwrap();
        let has = s.herzie.is_some();
        let logged = api::is_logged_in();
        let mins = s.pending_minutes.min(10.0);
        let (np, g) = match outgoing {
            Some(track) => (Some(track.now_playing), track.genres),
            None => (now_playing_payload(&s), s.current_genres.clone()),
        };
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
            s.trade_epoch,
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
        // e.g. a flush_pending_sync landing right after a regular tick, inside
        // the server's 8s cooldown between billable syncs). Only consume what was
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
        s.multipliers = Some(sync_resp.multipliers.clone());

        // A trade invite arrived over Realtime while this /sync was in
        // flight, so its pending_trade_request may predate it; applying it
        // would hide the invite just shown. The next sync reconciles.
        let trade_state_stale = s.trade_epoch != trade_epoch_before;
        if !trade_state_stale {
            s.pending_trade_request = sync_resp.pending_trade_request.clone();
        }
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

        // Capacity is credited out-of-band by the Stripe webhook and only ever
        // grows, so unlike inventory it needs no epoch guard: a stale sync can
        // at worst report a count that is one poll behind.
        if let Some(expansions) = sync_resp.bank_expansions {
            s.bank_expansions = expansions;
        }

        // Guarded on its own epoch rather than drop_epoch/equip_epoch: buying
        // changes inventory without touching either of those, so overloading
        // them would let a sync issued before a purchase reinstate the old
        // contents.
        if s.inventory_epoch == inventory_epoch_before {
            if let Some(ref inventory) = sync_resp.inventory {
                s.inventory = Some(inventory.clone());
                if let Some(ref item_upgrades) = sync_resp.item_upgrades {
                    s.item_upgrades = item_upgrades.clone();
                }
                // The copies carry worn state too, so a local equip that landed
                // while this request was in flight makes them as stale as it
                // makes `equipped`. Skip them then; the next sync reconciles.
                if s.equip_epoch == equip_epoch_before {
                    if let Some(ref units) = sync_resp.units {
                        s.units = units.clone();
                    }
                }
                storage::save_inventory_cache(
                    inventory,
                    s.inventory_currency,
                    &s.item_upgrades,
                    &s.units,
                    s.bank_expansions,
                );
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
        if !trade_state_stale {
            notify_pending_trade(app, sync_resp.pending_trade_request.as_ref());
        }

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

        // A pick-up accessory (spirit-orb, "Greedy Spirit") auto-collects world
        // drops quietly — the whole point is not having to watch the ground.
        // That means a full bank blocks it silently too, unless we say
        // something: the server already leaves any drop it couldn't fit room
        // for in `pending_drops` (see hasSpiritOrbEquipped in game-server.ts),
        // so a non-empty list here with the accessory equipped means it's
        // stuck.
        let has_spirit_orb = app_state
            .equipped
            .get("ground_left")
            .and_then(|v| v.as_str())
            == Some("spirit-orb")
            || app_state
                .equipped
                .get("ground_right")
                .and_then(|v| v.as_str())
                == Some("spirit-orb");
        let pickup_blocked = has_spirit_orb && !app_state.pending_drops.is_empty();
        if let Ok(mut last) = app.state::<LastInventoryFullNotified>().0.lock() {
            if pickup_blocked {
                // While the window is open, the in-app "Inventory full" prompt
                // (HomeView) already covers this — a system notification would
                // just be noise on top of it. Deliberately leave `last` unset
                // in that case rather than marking it notified, so the alert
                // still fires the moment the user hides the window with the
                // block still unresolved, instead of being silently skipped
                // for the rest of this blocking episode.
                if !*last && !tray::is_window_visible() {
                    send_notification(
                        app,
                        "Inventory full",
                        "Your Greedy Spirit found something but there's no room for it. Free up a slot to keep collecting.",
                        None,
                    );
                    *last = true;
                }
            } else {
                *last = false;
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

    let (nudge_tx, nudge_rx) = tokio::sync::mpsc::unbounded_channel();

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            // Passed only when macOS launches us at login, so a cold start can
            // tell "user opened the app" (show the window) apart from "launched
            // at login" (stay hidden in the menu bar).
            Some(vec!["--autostart"]),
        ))
        .plugin(
            // Routes the `log` facade somewhere visible: stdout for the
            // terminal running `tauri dev`, and the webview console so the
            // same lines show up in devtools next to the frontend's own.
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                    // Persisted to ~/Library/Logs/<identifier>/ so issues
                    // that need a restart to clear still leave a trail.
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
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
        .manage(LastInventoryFullNotified(Mutex::new(false)))
        .manage(SyncNudge(nudge_tx))
        .manage(LoginAttempt(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_state,
            login,
            cancel_login,
            logout,
            register_herzie,
            friend_add,
            friend_remove,
            friend_lookup,
            friend_request_accept,
            friend_request_decline,
            friend_request_cancel,
            friend_search,
            set_share_listening,
            fetch_inventory,
            sell_item,
            apply_dice_upgrade,
            buy_from_merchant,
            collect_drop,
            spawn_debug_drop,
            equip_item,
            fetch_store_products,
            fetch_premium_items,
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
            trade_request_ingest,
            test_notification,
            test_activity,
            debug_media_remote_now_playing,
            quit,
            flush_before_relaunch,
            open_external_url,
        ])
        .setup(move |app| {
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
                if let Err(e) = mac_notification_sys::set_application(bundle_id) {
                    log::warn!("Failed to set notification bundle id {bundle_id:?}: {e}");
                }
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
            tauri::async_runtime::spawn(sync_loop(app_handle, nudge_rx));

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(events_watch_loop(app_handle));

            // Initial poll + sync + home cache (equipped + chat)
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let client = api::http();
                // Initial tick credits no listening minutes (no prior interval).
                let _ = poll_tick(&app_handle, &client, 0.0).await;
                let _ = sync_tick(&app_handle, &client).await;
                refresh_app_cache(&app_handle, &client, false).await;
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

#[cfg(test)]
mod item_state_tests {
    use super::*;

    // `ManagedState::new` only reads local caches, never writes them, so it is
    // safe to build here. `snapshot_from_response` is pure — it must not touch
    // disk — which is why it is what's tested rather than `apply_inventory`
    // (which writes the real ~/.config/herzies cache).
    fn state_with_currency(currency: u32) -> ManagedState {
        let mut s = ManagedState::new(None);
        s.inventory_currency = currency;
        s.equipped = std::collections::HashMap::from([(
            "head".to_string(),
            serde_json::json!("headphones"),
        )]);
        s.item_upgrades = ItemUpgrades::from([("boombox".to_string(), 2)]);
        s
    }

    #[test]
    fn reads_the_units_alongside_the_derived_views() {
        let s = state_with_currency(10);
        let snap = snapshot_from_response(
            &serde_json::json!({
                "ok": true,
                "newCurrency": 260,
                "inventory": { "boombox": 2 },
                "equipped": { "ground_left": "boombox" },
                "itemUpgrades": { "boombox": 3 },
                "units": [
                    { "id": "a", "itemId": "boombox", "upgradeLevel": 3, "equippedSlot": "ground_left" },
                    { "id": "b", "itemId": "boombox", "upgradeLevel": 0, "equippedSlot": null }
                ]
            }),
            &s,
        )
        .expect("a response with an inventory is a snapshot");

        assert_eq!(snap.currency, 260);
        assert_eq!(snap.inventory["boombox"], 2);
        assert_eq!(snap.item_upgrades["boombox"], 3);
        let units = snap.units.expect("units present");
        assert_eq!(units.len(), 2);
        assert_eq!(units[0].upgrade_level, 3);
        assert_eq!(units[0].equipped_slot.as_deref(), Some("ground_left"));
        assert_eq!(units[1].equipped_slot, None);
    }

    // An upgrade or an equip doesn't move money and a buy doesn't touch levels:
    // whatever the response doesn't carry must keep its local value rather than
    // being blanked.
    #[test]
    fn falls_back_to_what_we_hold_for_anything_missing() {
        let s = state_with_currency(77);
        let snap = snapshot_from_response(&serde_json::json!({ "inventory": { "cd": 1 } }), &s)
            .expect("inventory alone is enough");

        assert_eq!(snap.currency, 77);
        assert_eq!(snap.equipped["head"], "headphones");
        assert_eq!(snap.item_upgrades["boombox"], 2);
    }

    // A server that predates copies sends none; that must read as "unknown" and
    // leave the local copies alone, not as "the player owns nothing".
    #[test]
    fn a_server_without_units_yields_none_not_empty() {
        let s = state_with_currency(0);
        let snap = snapshot_from_response(&serde_json::json!({ "inventory": {} }), &s).unwrap();
        assert!(snap.units.is_none());
    }

    #[test]
    fn a_response_without_an_inventory_is_not_a_snapshot() {
        let s = state_with_currency(0);
        assert!(snapshot_from_response(&serde_json::json!({ "error": "nope" }), &s).is_none());
        assert!(snapshot_from_response(&serde_json::json!({ "newCurrency": 5 }), &s).is_none());
    }
}

#[cfg(test)]
mod events_watch_tests {
    use super::*;

    fn upcoming_at(starts_at: &str) -> GameEvent {
        GameEvent {
            id: "e".into(),
            event_type: "song_hunt".into(),
            title: String::new(),
            description: None,
            active: true,
            starts_at: starts_at.into(),
            ends_at: starts_at.into(),
            config: serde_json::Value::Null,
        }
    }

    #[test]
    fn parses_the_timestamp_shapes_postgres_emits() {
        // 2026-10-05T18:00:00Z
        let t = 1_791_223_200;
        assert_eq!(parse_rfc3339_secs("2026-10-05T18:00:00+00:00"), Some(t));
        assert_eq!(parse_rfc3339_secs("2026-10-05T18:00:00Z"), Some(t));
        assert_eq!(
            parse_rfc3339_secs("2026-10-05T18:00:00.123456+00:00"),
            Some(t)
        );
        assert_eq!(parse_rfc3339_secs("2026-10-05T20:00:00+02:00"), Some(t));
        assert_eq!(parse_rfc3339_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_secs("2024-02-29T00:00:00Z"),
            Some(1_709_164_800)
        );
        assert_eq!(parse_rfc3339_secs("not a date"), None);
    }

    #[test]
    fn wakes_just_after_an_upcoming_start_inside_the_interval() {
        let now = 1_791_223_200 - 40;
        let wake = next_events_wake(&[upcoming_at("2026-10-05T18:00:00+00:00")], now);
        assert_eq!(wake, Duration::from_secs(40 + EVENTS_START_GRACE_SECS));
    }

    #[test]
    fn falls_back_to_the_interval_for_far_past_or_unparseable_starts() {
        let now = 1_791_223_200;
        let full = Duration::from_secs(EVENTS_WATCH_SECS);
        assert_eq!(next_events_wake(&[], now), full);
        assert_eq!(
            next_events_wake(&[upcoming_at("2026-10-06T18:00:00Z")], now),
            full
        );
        assert_eq!(
            next_events_wake(&[upcoming_at("2026-10-04T18:00:00Z")], now),
            full
        );
        assert_eq!(next_events_wake(&[upcoming_at("garbage")], now), full);
    }
}
