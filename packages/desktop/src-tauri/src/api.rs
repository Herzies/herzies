use crate::storage;
use crate::types::*;
use reqwest::Client;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

fn api_base() -> String {
    std::env::var("HERZIES_API_URL").unwrap_or_else(|_| "https://www.herzies.app/api".to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Milliseconds since UNIX epoch of the last HTTP response we got from the
/// server (any status — receiving a response proves network connectivity).
/// Used by `sync_tick` so that a single failing /sync POST doesn't flip the
/// UI to "offline" while other endpoints are clearly still working.
static LAST_REACHABLE_MS: AtomicU64 = AtomicU64::new(0);

/// How recently we must have heard *any* HTTP response from the server before
/// we consider ourselves disconnected. Wide enough to absorb a single failed
/// `/sync` between successful chat/inventory calls.
pub const REACHABLE_GRACE_MS: u64 = 90_000;

fn mark_reachable() {
    LAST_REACHABLE_MS.store(now_ms(), Ordering::Relaxed);
}

/// Milliseconds since the last successful HTTP response. Returns `u64::MAX`
/// if we've never reached the server.
pub fn ms_since_reachable() -> u64 {
    let last = LAST_REACHABLE_MS.load(Ordering::Relaxed);
    if last == 0 {
        return u64::MAX;
    }
    now_ms().saturating_sub(last)
}

#[cfg(test)]
pub fn reset_reachable_for_test() {
    LAST_REACHABLE_MS.store(0, Ordering::Relaxed);
}

#[cfg(test)]
pub fn mark_reachable_for_test() {
    mark_reachable();
}

async fn ensure_fresh_token(client: &Client) {
    let session = match storage::load_session() {
        Some(s) => s,
        None => return,
    };
    if session.refresh_token.is_empty() {
        return;
    }
    // Refresh if within 10 minutes of expiry
    if session.expires_at > now_ms() + 10 * 60 * 1000 {
        return;
    }

    let res = client
        .post(format!("{}/auth/refresh", api_base()))
        .json(&serde_json::json!({ "refreshToken": session.refresh_token }))
        .send()
        .await;

    match res {
        Ok(resp) if resp.status().is_success() => {
            mark_reachable();
            if let Ok(data) = resp.json::<serde_json::Value>().await {
                let access_token = data["accessToken"].as_str().unwrap_or_default().to_string();
                let refresh_token = data["refreshToken"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                let expires_in = data["expiresIn"].as_u64().unwrap_or(3600);
                storage::save_session(&SessionData {
                    access_token,
                    refresh_token,
                    expires_at: now_ms() + expires_in * 1000,
                    user_id: session.user_id,
                });
            }
        }
        Ok(resp) => {
            mark_reachable();
            // Server rejected the refresh token (401, 403, etc.) — session is dead
            log::warn!(
                "Token refresh failed with status {}, logging out",
                resp.status()
            );
            storage::clear_session();
        }
        Err(e) => {
            // Network error — don't clear session, might be temporary
            log::warn!("Token refresh network error: {}", e);
        }
    }
}

async fn get_token(client: &Client) -> Option<String> {
    ensure_fresh_token(client).await;
    storage::load_session().map(|s| s.access_token)
}

/// Public wrapper for get_token, used by Tauri commands that need the access token directly.
pub async fn get_token_public(client: &Client) -> Option<String> {
    get_token(client).await
}

async fn api_fetch(
    client: &Client,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Option<reqwest::Response> {
    let token = get_token(client).await?;
    let url = format!("{}{}", api_base(), path);

    let mut req = client.request(method, &url).bearer_auth(token);

    if let Some(b) = body {
        req = req.json(&b);
    }

    let resp = req.send().await.ok()?;
    // Any HTTP response (success or error) proves we reached the server.
    mark_reachable();

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        log::warn!("Got 401 on {}, clearing session", path);
        storage::clear_session();
        return None;
    }

    Some(resp)
}

pub fn is_logged_in() -> bool {
    storage::load_session().is_some()
}

pub async fn api_sync(
    client: &Client,
    now_playing: Option<NowPlayingPayload>,
    minutes_listened: f64,
    genres: Vec<String>,
) -> Option<SyncResponse> {
    let body = serde_json::json!({
        "nowPlaying": now_playing,
        "minutesListened": minutes_listened,
        "genres": genres,
    });
    let resp = api_fetch(client, reqwest::Method::POST, "/sync", Some(body)).await?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

pub async fn api_get_me(client: &Client) -> Option<Herzie> {
    let resp = api_fetch(client, reqwest::Method::GET, "/me", None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    serde_json::from_value(data["herzie"].clone()).ok()
}

pub enum RegisterError {
    NameTaken,
    FriendCodeCollision,
    Network,
    Server(String),
}

pub async fn api_register_herzie(
    client: &Client,
    herzie: &Herzie,
) -> Result<Herzie, RegisterError> {
    let body = serde_json::json!({
        "name": herzie.name,
        "appearance": herzie.appearance,
        "friendCode": herzie.friend_code,
    });
    let resp = api_fetch(client, reqwest::Method::POST, "/herzie", Some(body))
        .await
        .ok_or(RegisterError::Network)?;
    let status = resp.status();
    let data: serde_json::Value = resp.json().await.map_err(|_| RegisterError::Network)?;

    if status.is_success() {
        return serde_json::from_value(data["herzie"].clone())
            .map_err(|e| RegisterError::Server(e.to_string()));
    }

    let msg = data["error"].as_str().unwrap_or("").to_string();
    if status == reqwest::StatusCode::CONFLICT {
        if msg.contains("Friend code") {
            return Err(RegisterError::FriendCodeCollision);
        }
        return Err(RegisterError::NameTaken);
    }
    Err(RegisterError::Server(if msg.is_empty() {
        format!("Server returned {}", status)
    } else {
        msg
    }))
}

pub async fn api_add_friend(client: &Client, my_code: &str, their_code: &str) -> bool {
    let body = serde_json::json!({ "myCode": my_code, "theirCode": their_code });
    match api_fetch(client, reqwest::Method::POST, "/friends/add", Some(body)).await {
        Some(r) => r.status().is_success(),
        None => false,
    }
}

pub async fn api_remove_friend(client: &Client, my_code: &str, their_code: &str) -> bool {
    let body = serde_json::json!({ "myCode": my_code, "theirCode": their_code });
    match api_fetch(client, reqwest::Method::POST, "/friends/remove", Some(body)).await {
        Some(r) => r.status().is_success(),
        None => false,
    }
}

pub async fn api_lookup_herzies(
    client: &Client,
    codes: &[String],
) -> HashMap<String, HerzieProfile> {
    let mut result = HashMap::new();
    if codes.is_empty() {
        return result;
    }
    let codes_str = codes.join(",");
    let url = format!(
        "{}/lookup?codes={}",
        api_base(),
        urlencoding::encode(&codes_str)
    );
    if let Ok(resp) = client.get(&url).send().await {
        mark_reachable();
        if let Ok(data) = resp.json::<serde_json::Value>().await {
            if let Some(herzies) = data["herzies"].as_array() {
                for h in herzies {
                    if let Ok(profile) = serde_json::from_value::<HerzieProfile>(h.clone()) {
                        result.insert(profile.friend_code.clone(), profile);
                    }
                }
            }
        }
    }
    result
}

pub async fn api_fetch_inventory(client: &Client) -> Option<(Inventory, u32, Vec<String>)> {
    let resp = api_fetch(client, reqwest::Method::GET, "/inventory", None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    let inventory: Inventory = serde_json::from_value(data["inventory"].clone()).ok()?;
    let currency = data["currency"].as_u64().unwrap_or(0) as u32;
    let equipped: Vec<String> =
        serde_json::from_value(data["equipped"].clone()).unwrap_or_default();
    Some((inventory, currency, equipped))
}

pub async fn api_equip_item(
    client: &Client,
    item_id: &str,
    action: &str,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "itemId": item_id, "action": action });
    let resp = api_fetch(
        client,
        reqwest::Method::POST,
        "/inventory/equip",
        Some(body),
    )
    .await
    .ok_or_else(|| "Network error".to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Read error: {e}"))?;
    let data: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| format!("Server returned {status}"))?;
    if !status.is_success() {
        let msg = data["error"].as_str().unwrap_or("Unknown error");
        return Err(msg.to_string());
    }
    Ok(data)
}

pub async fn api_sell_item(
    client: &Client,
    item_id: &str,
    quantity: u32,
) -> Option<serde_json::Value> {
    let body = serde_json::json!({ "itemId": item_id, "quantity": quantity });
    let resp = api_fetch(client, reqwest::Method::POST, "/inventory/sell", Some(body)).await?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

pub async fn api_create_trade(
    client: &Client,
    target_friend_code: &str,
) -> Option<serde_json::Value> {
    let body = serde_json::json!({ "targetFriendCode": target_friend_code });
    let resp = api_fetch(client, reqwest::Method::POST, "/trade/create", Some(body)).await?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

pub async fn api_join_trade(client: &Client, trade_id: &str) -> bool {
    let body = serde_json::json!({ "tradeId": trade_id });
    match api_fetch(client, reqwest::Method::POST, "/trade/join", Some(body)).await {
        Some(r) => r.status().is_success(),
        None => false,
    }
}

pub async fn api_update_trade_offer(client: &Client, trade_id: &str, offer: &TradeOffer) -> bool {
    let body = serde_json::json!({ "tradeId": trade_id, "offer": offer });
    match api_fetch(client, reqwest::Method::POST, "/trade/offer", Some(body)).await {
        Some(r) => r.status().is_success(),
        None => false,
    }
}

pub async fn api_lock_trade(client: &Client, trade_id: &str) -> bool {
    let body = serde_json::json!({ "tradeId": trade_id });
    match api_fetch(client, reqwest::Method::POST, "/trade/lock", Some(body)).await {
        Some(r) => r.status().is_success(),
        None => false,
    }
}

pub async fn api_accept_trade(client: &Client, trade_id: &str) -> Option<serde_json::Value> {
    let body = serde_json::json!({ "tradeId": trade_id });
    let resp = api_fetch(client, reqwest::Method::POST, "/trade/accept", Some(body)).await?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

pub async fn api_cancel_trade(client: &Client, trade_id: &str) -> bool {
    let body = serde_json::json!({ "tradeId": trade_id });
    match api_fetch(client, reqwest::Method::POST, "/trade/cancel", Some(body)).await {
        Some(r) => r.status().is_success(),
        None => false,
    }
}

pub async fn api_fetch_active_events(client: &Client) -> Option<Vec<GameEvent>> {
    let resp = api_fetch(client, reqwest::Method::GET, "/events/active", None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: ActiveEventsResponse = resp.json().await.ok()?;
    Some(data.events)
}

pub async fn api_poll_trade(client: &Client, trade_id: &str) -> Option<Trade> {
    let path = format!("/trade/status?tradeId={}", urlencoding::encode(trade_id));
    let resp = api_fetch(client, reqwest::Method::GET, &path, None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    serde_json::from_value(data["trade"].clone()).ok()
}

pub async fn api_chat_fetch(client: &Client) -> Option<ChatFetchResponse> {
    let resp = api_fetch(client, reqwest::Method::GET, "/chat?limit=50", None).await?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

pub async fn api_chat_send(
    client: &Client,
    content: &str,
    item_refs: &[String],
) -> Option<ChatMessage> {
    let body = serde_json::json!({ "content": content, "itemRefs": item_refs });
    let resp = api_fetch(client, reqwest::Method::POST, "/chat", Some(body)).await?;
    if !resp.status().is_success() {
        return None;
    }
    let result: ChatSendResponse = resp.json().await.ok()?;
    Some(result.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test because the helpers mutate a single process-global atomic;
    // splitting would race under cargo's parallel test runner.
    #[test]
    fn reachable_lifecycle() {
        reset_reachable_for_test();
        assert_eq!(ms_since_reachable(), u64::MAX);
        mark_reachable_for_test();
        assert!(ms_since_reachable() < 1_000);
    }
}
