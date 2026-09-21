use crate::storage;
use crate::types::*;
use reqwest::{Client, StatusCode};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

/// Serializes refresh attempts so concurrent callers can't all race the same
/// refresh_token against Supabase's 10s reuse window (which, on a miss, would
/// invalidate the entire refresh chain and silently log the user out).
static REFRESH_LOCK: Mutex<()> = Mutex::const_new(());

/// True if a refresh response means the refresh token itself is dead (vs. a
/// transient failure we should retry on the next tick). 429/5xx/etc. must NOT
/// clear the session — they're commonly returned by rate limiters and by cold
/// starts.
///
/// We talk to Supabase's GoTrue token endpoint directly (see `refresh_locked`),
/// and it reports a dead refresh token as **400**, not 401 — so status alone
/// can't classify the failure. Treating every 400 as transient would leave a
/// genuinely expired session retrying forever instead of falling through to the
/// login screen; treating every 400 as fatal would log users out over a
/// malformed request of our own. So we match the body.
///
/// Probed against this project's GoTrue (2026-09-12): an unknown token, an empty
/// token, and a missing `refresh_token` field all return exactly
/// `{"code":400,"error_code":"validation_failed","msg":"Refresh token is not
/// valid"}`. The `error_code` therefore carries no signal — the `msg` is the
/// discriminator. `refresh_locked` never sends an empty token (it returns early
/// on one), so that message reaching us means the token we hold is dead.
///
/// The `invalid_grant` / `refresh_token_*` arms cover the shapes other GoTrue
/// versions use, so a Supabase upgrade can't silently turn a dead session into
/// an infinite retry. 401/403 stay fatal because the old Vercel passthrough
/// reported a dead token that way — with one carve-out, below.
fn is_refresh_fatal(status: StatusCode, body: &serde_json::Value) -> bool {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        // Calling GoTrue directly means the request now carries our baked-in
        // anon key (see `supabase_anon_key`), and Supabase's API gateway
        // rejects a bad/rotated one with 401 before GoTrue ever sees the grant:
        // `{"message":"Invalid API key",...}` / `{"message":"No API key found
        // in request",...}` (probed 2026-09-12). That says nothing about the
        // user's refresh token, so clearing the session over it would brick
        // every shipped client on a key rotation — permanently, since
        // `clear_session` destroys the token that could have retried once the
        // key was fixed. Treat it as transient and let the user retry or
        // auto-update instead.
        let gateway_key_error = body["message"]
            .as_str()
            .map(|m| m.to_ascii_lowercase().contains("api key"))
            .unwrap_or(false);
        if gateway_key_error {
            return false;
        }
        return true;
    }
    if status != StatusCode::BAD_REQUEST {
        // 429 from a rate limiter, 5xx from a cold start — the token is fine.
        return false;
    }
    // Older GoTrue: {"error":"invalid_grant","error_description":...}
    if body["error"].as_str() == Some("invalid_grant") {
        return true;
    }
    // Some versions name the token in the code itself.
    if let Some(code) = body["error_code"].as_str() {
        if code.starts_with("refresh_token") {
            return true;
        }
    }
    // This project's version: generic `validation_failed`, with the only real
    // signal in the human-readable message.
    let mentions_refresh_token = |v: &serde_json::Value| {
        v.as_str()
            .map(|s| s.to_ascii_lowercase().contains("refresh token"))
            .unwrap_or(false)
    };
    mentions_refresh_token(&body["msg"]) || mentions_refresh_token(&body["error_description"])
}

fn api_base() -> String {
    std::env::var("HERZIES_API_URL").unwrap_or_else(|_| "https://www.herzies.app/api".to_string())
}

/// Supabase project URL. Mirrors the resolution used by `get_auth_config` in
/// lib.rs so the Edge Function and the rest of the app agree on the project.
fn supabase_url() -> String {
    std::env::var("NEXT_PUBLIC_SUPABASE_URL")
        .or_else(|_| std::env::var("SUPABASE_URL"))
        .unwrap_or_else(|_| "https://ojqfqxolbjegorgoyond.supabase.co".to_string())
}

/// Public anon key — required as the `apikey` header on every Edge Function
/// call so the Supabase API gateway routes the request (the user's JWT in the
/// Authorization header is what actually authenticates the caller).
fn supabase_anon_key() -> String {
    std::env::var("NEXT_PUBLIC_SUPABASE_ANON_KEY")
        .or_else(|_| std::env::var("SUPABASE_ANON_KEY"))
        .unwrap_or_else(|_| "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qcWZxeG9sYmplZ29yZ295b25kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NTcwMjgsImV4cCI6MjA5MzIzMzAyOH0.BBT77VK1ROJr57BJvMfCyra3lbycMA9u2-jxG-LhBJE".to_string())
}

/// Base URL for Supabase Edge Functions. Override with `HERZIES_FUNCTIONS_URL`
/// for local dev (`supabase functions serve` → http://127.0.0.1:54321/functions/v1).
fn functions_base() -> String {
    std::env::var("HERZIES_FUNCTIONS_URL")
        .unwrap_or_else(|_| format!("{}/functions/v1", supabase_url()))
}

/// Supabase's GoTrue token endpoint — refreshes a session without a Vercel hop.
///
/// The Next.js `/api/auth/refresh` route this replaces was a pure passthrough to
/// `supabase.auth.refreshSession()`; its stated reason for existing ("so the CLI
/// doesn't need the anon key") never applied to this client, which has always
/// shipped the anon key (see `supabase_anon_key`). Going direct removes a
/// serverless cold start and a shared-per-IP rate-limit bucket from in front of
/// the one call whose failure logs the user out.
fn refresh_url() -> String {
    format!("{}/auth/v1/token?grant_type=refresh_token", supabase_url())
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

/// Refresh if we're within 10 minutes of expiry. Outside the lock so callers
/// in the common (fresh-token) path don't serialize.
fn needs_refresh(session: &SessionData) -> bool {
    !session.refresh_token.is_empty() && session.expires_at <= now_ms() + 10 * 60 * 1000
}

async fn ensure_fresh_token(client: &Client) {
    let session = match storage::load_session() {
        Some(s) => s,
        None => return,
    };
    if !needs_refresh(&session) {
        return;
    }
    refresh_locked(client, false).await;
}

/// Force a refresh regardless of the expiry check. Used after a 401 from a
/// non-refresh endpoint, to recover from the case where our cached access
/// token is stale but the refresh token still works.
async fn force_refresh(client: &Client) {
    refresh_locked(client, true).await;
}

/// Perform the refresh under a global mutex so concurrent callers don't all
/// race the same refresh_token. Inside the lock we re-load the session and
/// re-check `needs_refresh` (unless `force` is true) — that way, callers that
/// were queued behind a successful refresh become no-ops.
async fn refresh_locked(client: &Client, force: bool) {
    let _guard = REFRESH_LOCK.lock().await;

    let session = match storage::load_session() {
        Some(s) => s,
        None => return,
    };
    if session.refresh_token.is_empty() {
        return;
    }
    if !force && !needs_refresh(&session) {
        return;
    }

    let anon = supabase_anon_key();
    let res = client
        .post(refresh_url())
        // GoTrue is behind the Supabase API gateway, which routes on `apikey`.
        // The anon key is also sent as the bearer because that's what an
        // unauthenticated token-endpoint call is expected to carry — the
        // refresh token in the body is what actually authorizes the exchange.
        .header("apikey", &anon)
        .bearer_auth(&anon)
        .json(&serde_json::json!({ "refresh_token": session.refresh_token }))
        .send()
        .await;

    match res {
        Ok(resp) => {
            // Any HTTP response proves we reached Supabase.
            mark_reachable();
            let status = resp.status();
            let body: serde_json::Value = resp
                .text()
                .await
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or(serde_json::Value::Null);

            if status.is_success() {
                // GoTrue responds in snake_case (the Vercel passthrough this
                // replaced re-cased these to camelCase).
                let access_token = body["access_token"].as_str().unwrap_or_default();
                let refresh_token = body["refresh_token"].as_str().unwrap_or_default();
                if access_token.is_empty() || refresh_token.is_empty() {
                    // A 2xx we can't parse is not a dead token — keep the
                    // session and retry rather than persisting an empty one,
                    // which would wedge every subsequent request.
                    log::warn!(
                        "Token refresh returned {} with no tokens, will retry",
                        status
                    );
                    return;
                }
                let expires_in = body["expires_in"].as_u64().unwrap_or(3600);
                storage::save_session(&SessionData {
                    access_token: access_token.to_string(),
                    refresh_token: refresh_token.to_string(),
                    expires_at: now_ms() + expires_in * 1000,
                    user_id: session.user_id,
                });
            } else if is_refresh_fatal(status, &body) {
                log::warn!("Refresh token rejected ({}), clearing session", status);
                storage::clear_session();
            } else {
                // 429 from the rate limiter, 5xx from a cold start, etc. The
                // refresh token is still valid — try again on the next tick.
                log::warn!(
                    "Token refresh transient failure (status {}), will retry",
                    status
                );
            }
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
    let url = format!("{}{}", api_base(), path);
    api_fetch_full(client, method, &url, body, None).await
}

/// Like `api_fetch` but takes a fully-qualified URL and an optional `apikey`
/// header. Used to call Supabase Edge Functions (which live on a different base
/// URL and require the anon key as `apikey`) while reusing the same token
/// freshness + 401-retry handling as the Next.js endpoints.
async fn api_fetch_full(
    client: &Client,
    method: reqwest::Method,
    url: &str,
    body: Option<serde_json::Value>,
    apikey: Option<&str>,
) -> Option<reqwest::Response> {
    let token = get_token(client).await?;

    let build = |tok: &str| {
        let mut req = client.request(method.clone(), url).bearer_auth(tok);
        if let Some(key) = apikey {
            req = req.header("apikey", key);
        }
        if let Some(ref b) = body {
            req = req.json(b);
        }
        req
    };

    let resp = build(&token).send().await.ok()?;
    // Any HTTP response (success or error) proves we reached the server.
    mark_reachable();

    if resp.status() != StatusCode::UNAUTHORIZED {
        return Some(resp);
    }

    // 401: our access token may just be stale relative to the refresh state
    // on disk. Force a refresh and retry once before declaring the session
    // dead. `force_refresh` itself will clear the session if the refresh
    // token is truly rejected (401/403).
    log::warn!("Got 401 on {}, forcing refresh and retrying", url);
    force_refresh(client).await;
    let new_token = storage::load_session().map(|s| s.access_token)?;
    if new_token.is_empty() || new_token == token {
        // Either force_refresh already cleared the session, or it failed
        // transiently and we still have the same (rejected) token. Either
        // way, give up on this request — don't double-clear.
        return None;
    }

    let resp2 = build(&new_token).send().await.ok()?;
    mark_reachable();
    if resp2.status() == StatusCode::UNAUTHORIZED {
        // Fresh token still rejected — the user really is unauthorized.
        log::warn!("Still 401 after refresh on {}, clearing session", url);
        storage::clear_session();
        return None;
    }
    Some(resp2)
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
    // /sync has been ported to a Supabase Edge Function (co-located with
    // Postgres, off Vercel). It lives on the functions base URL and needs the
    // anon key as `apikey`; everything else still routes through `api_base()`.
    let url = format!("{}/sync", functions_base());
    let anon = supabase_anon_key();
    let resp = api_fetch_full(client, reqwest::Method::POST, &url, Some(body), Some(&anon)).await?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

/// Manually collects one specific pending world drop (by id) into the
/// caller's inventory. Returns `Ok(Some((item_id, name)))` if it was
/// collected, `Ok(None)` if that drop no longer exists (already collected,
/// e.g. by a racing Spirit Orb auto-collect — not an error), `Err` on
/// network/server failure.
pub async fn api_collect_drop(
    client: &Client,
    drop_id: &str,
) -> Result<Option<(String, String)>, String> {
    // New functionality, not a port — lives only as an Edge Function (see
    // supabase/functions/collect-drop), same functions_base()/anon-key
    // pattern as api_sync.
    let url = format!("{}/collect-drop", functions_base());
    let anon = supabase_anon_key();
    let body = serde_json::json!({ "dropId": drop_id });
    let resp = api_fetch_full(client, reqwest::Method::POST, &url, Some(body), Some(&anon))
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
    let item_id = data["collected"]["itemId"].as_str().map(|s| s.to_string());
    let name = data["collected"]["name"].as_str().map(|s| s.to_string());
    Ok(item_id.map(|id| {
        let name = name.unwrap_or_else(|| id.clone());
        (id, name)
    }))
}

/// Dev-only: spawns a real, pickup-able world drop for the "Spawn Item Drop"
/// debug button in Settings (see supabase/functions/debug-spawn-drop — that
/// endpoint is further restricted server-side to the developer's own
/// account, since a client-side dev gate alone wouldn't stop any other
/// player from calling it directly).
pub async fn api_spawn_debug_drop(client: &Client) -> Result<PendingDrop, String> {
    let url = format!("{}/debug-spawn-drop", functions_base());
    let anon = supabase_anon_key();
    let resp = api_fetch_full(client, reqwest::Method::POST, &url, None, Some(&anon))
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
    serde_json::from_value(data["spawned"].clone()).map_err(|e| format!("Malformed response: {e}"))
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

/// POST a friend-request action and parse the JSON body, surfacing the
/// server's `error` message on failure.
async fn post_friend_action(
    client: &Client,
    path: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resp = api_fetch(client, reqwest::Method::POST, path, Some(body))
        .await
        .ok_or_else(|| "Network error".to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Read error: {e}"))?;
    let data: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        let msg = data["error"].as_str().unwrap_or("Something went wrong");
        return Err(msg.to_string());
    }
    Ok(data)
}

/// Send a friend request. Returns `Ok(true)` if it was auto-accepted because
/// the other player had already requested you.
pub async fn api_send_friend_request(
    client: &Client,
    my_code: &str,
    their_code: &str,
) -> Result<bool, String> {
    let body = serde_json::json!({ "myCode": my_code, "theirCode": their_code });
    let data = post_friend_action(client, "/friends/add", body).await?;
    Ok(data["accepted"].as_bool().unwrap_or(false))
}

pub async fn api_accept_friend_request(client: &Client, request_id: &str) -> Result<(), String> {
    let body = serde_json::json!({ "requestId": request_id });
    post_friend_action(client, "/friends/accept", body)
        .await
        .map(|_| ())
}

pub async fn api_decline_friend_request(client: &Client, request_id: &str) -> Result<(), String> {
    let body = serde_json::json!({ "requestId": request_id });
    post_friend_action(client, "/friends/decline", body)
        .await
        .map(|_| ())
}

pub async fn api_cancel_friend_request(client: &Client, request_id: &str) -> Result<(), String> {
    let body = serde_json::json!({ "requestId": request_id });
    post_friend_action(client, "/friends/cancel", body)
        .await
        .map(|_| ())
}

pub async fn api_search_friends(
    client: &Client,
    query: &str,
) -> Result<Vec<FriendSearchResult>, String> {
    let path = format!("/friends/search?q={}", urlencoding::encode(query));
    let resp = api_fetch(client, reqwest::Method::GET, &path, None)
        .await
        .ok_or_else(|| "Network error".to_string())?;
    if !resp.status().is_success() {
        return Err("Search failed".to_string());
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("Read error: {e}"))?;
    let results: Vec<FriendSearchResult> =
        serde_json::from_value(data["results"].clone()).unwrap_or_default();
    Ok(results)
}

pub async fn api_remove_friend(client: &Client, my_code: &str, their_code: &str) -> bool {
    let body = serde_json::json!({ "myCode": my_code, "theirCode": their_code });
    match api_fetch(client, reqwest::Method::POST, "/friends/remove", Some(body)).await {
        Some(r) => r.status().is_success(),
        None => false,
    }
}

#[cfg(test)]
mod lookup_tests {
    use crate::types::HerzieProfile;
    use std::collections::HashMap;

    #[test]
    fn herzie_profile_parses_top_artists_from_lookup_json() {
        let sample = serde_json::json!({
            "name": "Mafacka",
            "friendCode": "HERZ-ABCD",
            "stage": 1,
            "level": 5,
            "currency": 100,
            "appearance": {
                "headIndex": 0,
                "eyesIndex": 0,
                "mouthIndex": 0,
                "accessoryIndex": 0,
                "limbsIndex": 0,
                "bodyIndex": 0,
                "legsIndex": 0,
                "colorScheme": "cyan"
            },
            "topArtists": [
                { "name": "James Prophet", "plays": 9 },
                { "name": "The Soul of Philly", "plays": 7 }
            ],
            "equipped": { "head": "headphones" }
        });
        let profile: HerzieProfile = serde_json::from_value(sample).expect("parse profile");
        let artists = profile.top_artists.expect("top artists");
        assert_eq!(artists.len(), 2);
        assert_eq!(artists[0].name, "James Prophet");
        assert_eq!(artists[0].plays, 9);
        let mut expected = HashMap::new();
        expected.insert(
            "head".to_string(),
            serde_json::Value::String("headphones".to_string()),
        );
        assert_eq!(profile.equipped.as_ref(), Some(&expected));
    }
}

pub async fn api_lookup_herzies(
    client: &Client,
    codes: &[String],
) -> Option<HashMap<String, HerzieProfile>> {
    if codes.is_empty() {
        return Some(HashMap::new());
    }
    let codes_str = codes.join(",");
    // Authenticated: the server only returns listening data (now playing,
    // last played, top artists) for herzies the caller is friends with.
    let path = format!("/lookup?codes={}", urlencoding::encode(&codes_str));
    let resp = api_fetch(client, reqwest::Method::GET, &path, None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data = resp.json::<serde_json::Value>().await.ok()?;
    let mut result = HashMap::new();
    if let Some(herzies) = data["herzies"].as_array() {
        for h in herzies {
            if let Ok(profile) = serde_json::from_value::<HerzieProfile>(h.clone()) {
                result.insert(profile.friend_code.clone(), profile);
            }
        }
    }
    Some(result)
}

pub async fn api_fetch_inventory(
    client: &Client,
) -> Option<(Inventory, u32, HashMap<String, serde_json::Value>)> {
    let resp = api_fetch(client, reqwest::Method::GET, "/inventory", None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    let inventory: Inventory = serde_json::from_value(data["inventory"].clone()).ok()?;
    let currency = data["currency"].as_u64().unwrap_or(0) as u32;
    let equipped: HashMap<String, serde_json::Value> = match &data["equipped"] {
        serde_json::Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        _ => HashMap::new(),
    };
    Some((inventory, currency, equipped))
}

pub async fn api_equip_item(
    client: &Client,
    item_id: &str,
    action: &str,
    side: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({ "itemId": item_id, "action": action });
    if let Some(s) = side {
        body["side"] = serde_json::Value::String(s.to_string());
    }
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

/// Buys an item with in-game currency. Unlike `api_sell_item`, this surfaces
/// the server's error message (e.g. "not enough currency", "already own
/// this item") so the Items tab can show the user why a purchase failed.
pub async fn api_buy_item(
    client: &Client,
    item_id: &str,
    quantity: u32,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "itemId": item_id, "quantity": quantity });
    let resp = api_fetch(client, reqwest::Method::POST, "/inventory/buy", Some(body))
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

pub async fn api_fetch_store_products(client: &Client) -> Option<Vec<StoreProduct>> {
    let resp = api_fetch(client, reqwest::Method::GET, "/store/products", None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    serde_json::from_value(data["products"].clone()).ok()
}

/// What the last premium fetch attempt produced, and when it happened.
///
/// A *failed* attempt is recorded too, with `items` left at the last good
/// listing (or `None` if we never had one). Caching the failure is the whole
/// point: the case this exists for is a cold cache being hammered into 429s,
/// and a cache that only remembers successes would let every one of those
/// callers through to the rate limiter.
struct PremiumCache {
    /// Last listing we successfully fetched, kept across failures so a
    /// transient 429 doesn't empty the shelf.
    items: Option<Vec<PremiumItem>>,
    /// When we last *attempted*, whether or not it worked.
    attempted_at: u64,
    /// Whether that attempt succeeded — picks which TTL applies.
    ok: bool,
}

/// Guarded by a `tokio::sync::Mutex` held *across* the network call, which is
/// what makes this a request deduper and not just a TTL cache: callers that
/// arrive while a fetch is in flight queue on the lock, then re-check the TTL
/// and return the value the winner just stored instead of issuing their own
/// request.
static PREMIUM_CACHE: Mutex<Option<PremiumCache>> = Mutex::const_new(None);

/// Premium listings change only when a product is edited in the Stripe
/// Dashboard, so a minute of staleness costs nothing and keeps a remounting
/// store off the rate limiter.
const PREMIUM_TTL_MS: u64 = 60_000;

/// Backoff after a failed attempt. Much shorter than `PREMIUM_TTL_MS` so a
/// transient 429 doesn't leave the shelf empty for a full minute, but long
/// enough that a burst of callers costs one request rather than one each.
const PREMIUM_RETRY_MS: u64 = 10_000;

/// Items sold for money. An empty list is the normal answer when Stripe has
/// no such products configured, so a failure here is not distinguished from
/// "none for sale" — either way the store shows its coin-priced cards.
///
/// Cached for `PREMIUM_TTL_MS`. Every call costs a Stripe API request
/// server-side and shares the general 120/min per-IP bucket with every other
/// endpoint, so an unthrottled caller could — and did — flood it into 429s.
///
/// On failure the last good listing is served rather than `None`: both callers
/// above this (`fetch_premium_items`'s `unwrap_or_default` and the store view's
/// `setPremium([])`) collapse "the call failed" into "nothing is for sale", so
/// without this a single 429 empties the premium shelf.
pub async fn api_fetch_premium_items(client: &Client) -> Option<Vec<PremiumItem>> {
    let mut cache = PREMIUM_CACHE.lock().await;
    if let Some(entry) = cache.as_ref() {
        let ttl = if entry.ok {
            PREMIUM_TTL_MS
        } else {
            PREMIUM_RETRY_MS
        };
        if now_ms().saturating_sub(entry.attempted_at) < ttl {
            return entry.items.clone();
        }
    }

    // Taken before the request so the failure paths below can serve it without
    // holding a borrow of `cache` across the write at the end.
    let stale = cache.as_ref().and_then(|e| e.items.clone());

    // Records the attempt so a burst of callers costs one request, then hands
    // back the last good listing (if any) rather than "nothing for sale".
    let fail = |cache: &mut Option<PremiumCache>| {
        *cache = Some(PremiumCache {
            items: stale.clone(),
            attempted_at: now_ms(),
            ok: false,
        });
        stale.clone()
    };

    let resp = match api_fetch(client, reqwest::Method::GET, "/store/premium", None).await {
        Some(r) => r,
        None => return fail(&mut cache),
    };
    let status = resp.status();
    if !status.is_success() {
        log::warn!("Premium items request failed: {}", status);
        return fail(&mut cache);
    }
    let data: serde_json::Value = match resp.json().await {
        Ok(d) => d,
        Err(_) => return fail(&mut cache),
    };
    let items: Option<Vec<PremiumItem>> = serde_json::from_value(data["items"].clone()).ok();
    // Logged at info because zero is both the normal answer (nothing is
    // configured for sale) and the confusing one (a product exists in Stripe
    // but is filtered out) — and those are indistinguishable without this.
    match &items {
        Some(v) => log::info!("Premium items: {} for sale", v.len()),
        None => log::warn!("Premium items response could not be parsed"),
    }
    match items {
        Some(v) => {
            *cache = Some(PremiumCache {
                items: Some(v.clone()),
                attempted_at: now_ms(),
                ok: true,
            });
            Some(v)
        }
        None => fail(&mut cache),
    }
}

/// Creates a Stripe Checkout Session for `product_id` and returns the URL to
/// open in the system browser. Currency is credited only by the webhook once
/// Stripe confirms payment — this call never mutates local/server balances.
///
/// Returns `Ok(None)` when the server is running its Stripe-less test-mode
/// bypass (no `STRIPE_SECRET_KEY` configured, non-production only) — in that
/// case the order was already fulfilled server-side and there is no URL to
/// open.
pub async fn api_create_checkout(
    client: &Client,
    product_id: &str,
) -> Result<Option<String>, String> {
    let body = serde_json::json!({ "productId": product_id });
    let resp = api_fetch(client, reqwest::Method::POST, "/store/checkout", Some(body))
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
    if let Some(url) = data["url"].as_str() {
        return Ok(Some(url.to_string()));
    }
    if data["testMode"].as_bool() == Some(true) {
        return Ok(None);
    }
    Err("Unexpected checkout response".to_string())
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

pub async fn api_fetch_leaderboard(
    client: &Client,
    board: Option<&str>,
) -> Option<serde_json::Value> {
    let path = match board {
        Some(b) => format!("/leaderboard?board={b}"),
        None => "/leaderboard".to_string(),
    };
    let resp = api_fetch(client, reqwest::Method::GET, &path, None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    Some(data["entries"].clone())
}

/// Artist portrait photo for the now-playing bar's background, resolved
/// server-side (Spotify search — the client credentials never ship in the app).
pub async fn api_fetch_artist_image(client: &Client, artist: &str) -> Option<String> {
    let path = format!("/artist-image?artist={}", urlencoding::encode(artist));
    let resp = api_fetch(client, reqwest::Method::GET, &path, None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    data["url"].as_str().map(str::to_string)
}

pub async fn api_fetch_active_events(client: &Client) -> Option<Vec<GameEvent>> {
    // Ported to a Supabase Edge Function (co-located with Postgres, off
    // Vercel), like /sync and /chat: it's polled every 30s regardless of
    // window visibility, so it was a steady source of Vercel invocations.
    let url = format!("{}/events-active", functions_base());
    let anon = supabase_anon_key();
    let resp = api_fetch_full(client, reqwest::Method::GET, &url, None, Some(&anon)).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: ActiveEventsResponse = resp.json().await.ok()?;
    Some(data.events)
}

/// Grants one play of a hint's audio snippet and returns a short-lived
/// signed URL. Surfaces the server's error message (e.g. "No plays
/// remaining", "Hint is locked") so the Events tab can show why playback
/// was refused.
pub async fn api_play_hint_audio(
    client: &Client,
    event_id: &str,
    hint_index: u32,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "eventId": event_id, "hintIndex": hint_index });
    let resp = api_fetch(
        client,
        reqwest::Method::POST,
        "/events/hint-audio/play",
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

pub async fn api_fetch_previous_hunt(
    client: &Client,
) -> Option<(Vec<GameEvent>, Option<GameEvent>)> {
    let resp = api_fetch(client, reqwest::Method::GET, "/events/previous-hunt", None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    let events: Vec<GameEvent> = serde_json::from_value(data["events"].clone()).unwrap_or_default();
    let next: Option<GameEvent> = data.get("next").and_then(|v| {
        if v.is_null() {
            None
        } else {
            serde_json::from_value(v.clone()).ok()
        }
    });
    Some((events, next))
}

/// GET /trade/pending — lightweight check for an incoming trade invite.
/// Outer `None` = request failed; inner `None` = no pending invite.
///
/// Ported to a Supabase Edge Function (co-located with Postgres, off
/// Vercel), like /sync and /chat: trade_watch_loop hits this every 5s
/// whenever the window is hidden, so it was the single largest source of
/// Vercel invocations.
pub async fn api_check_pending_trade(client: &Client) -> Option<Option<PendingTradeRequest>> {
    let url = format!("{}/trade-pending", functions_base());
    let anon = supabase_anon_key();
    let resp = api_fetch_full(client, reqwest::Method::GET, &url, None, Some(&anon)).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    Some(
        serde_json::from_value::<Option<PendingTradeRequest>>(data["pending"].clone())
            .unwrap_or(None),
    )
}

/// GET /trade/ongoing — all non-terminal trades for the current user, so the
/// UI can offer a way back into a trade after closing the window.
pub async fn api_fetch_ongoing_trades(client: &Client) -> Option<serde_json::Value> {
    let resp = api_fetch(client, reqwest::Method::GET, "/trade/ongoing", None).await?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    Some(data["trades"].clone())
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
    // Ported to a Supabase Edge Function (co-located with Postgres, off Vercel),
    // like /sync: it lives on the functions base URL and needs the anon key as
    // `apikey`.
    let url = format!("{}/chat?limit=50", functions_base());
    let anon = supabase_anon_key();
    let resp = api_fetch_full(client, reqwest::Method::GET, &url, None, Some(&anon)).await?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}

pub async fn api_chat_send(
    client: &Client,
    content: &str,
    item_refs: &[String],
    user_refs: &[String],
) -> Option<ChatMessage> {
    let body = serde_json::json!({
        "content": content,
        "itemRefs": item_refs,
        "userRefs": user_refs,
    });
    let url = format!("{}/chat", functions_base());
    let anon = supabase_anon_key();
    let resp = api_fetch_full(client, reqwest::Method::POST, &url, Some(body), Some(&anon)).await?;
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

    /// Stand-in for a response body we didn't get or couldn't parse.
    const NO_BODY: serde_json::Value = serde_json::Value::Null;

    #[test]
    fn refresh_fatal_for_hard_auth_failures() {
        // Hard auth failures — refresh token is dead, clear the session.
        assert!(is_refresh_fatal(StatusCode::UNAUTHORIZED, &NO_BODY));
        assert!(is_refresh_fatal(StatusCode::FORBIDDEN, &NO_BODY));

        // Transient failures — must NOT clear the session. These were the
        // cause of the <2h logout bug: the middleware rate limiter returns
        // 429 when concurrent refresh attempts pile up, and serverless cold
        // starts return 5xx.
        assert!(!is_refresh_fatal(StatusCode::TOO_MANY_REQUESTS, &NO_BODY));
        assert!(!is_refresh_fatal(
            StatusCode::INTERNAL_SERVER_ERROR,
            &NO_BODY
        ));
        assert!(!is_refresh_fatal(StatusCode::BAD_GATEWAY, &NO_BODY));
        assert!(!is_refresh_fatal(StatusCode::SERVICE_UNAVAILABLE, &NO_BODY));
        assert!(!is_refresh_fatal(StatusCode::GATEWAY_TIMEOUT, &NO_BODY));
    }

    // GoTrue (which we now call directly instead of going through Vercel)
    // reports a dead refresh token as 400, not 401. If this regressed, an
    // expired session would retry forever instead of falling through to the
    // login screen.
    #[test]
    fn refresh_fatal_for_this_projects_gotrue_400() {
        // Verbatim body observed from this project's GoTrue for an unknown
        // refresh token (probed 2026-09-12). Note `error_code` is the generic
        // `validation_failed` — the message is the only discriminator.
        let observed = serde_json::json!({
            "code": 400,
            "error_code": "validation_failed",
            "msg": "Refresh token is not valid",
        });
        assert!(is_refresh_fatal(StatusCode::BAD_REQUEST, &observed));
    }

    #[test]
    fn refresh_fatal_for_other_gotrue_versions_400() {
        let invalid_grant = serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Invalid Refresh Token: Refresh Token Not Found",
        });
        assert!(is_refresh_fatal(StatusCode::BAD_REQUEST, &invalid_grant));

        for code in ["refresh_token_not_found", "refresh_token_already_used"] {
            let named = serde_json::json!({ "code": 400, "error_code": code });
            assert!(
                is_refresh_fatal(StatusCode::BAD_REQUEST, &named),
                "{code} should be fatal"
            );
        }
    }

    // A rotated/bad anon key is rejected by Supabase's API gateway with 401
    // before GoTrue sees the grant. Clearing the session there would brick every
    // shipped client permanently, since the refresh token it destroys is the
    // only thing that could retry once the key is fixed.
    #[test]
    fn refresh_not_fatal_for_gateway_api_key_rejection() {
        // Verbatim bodies observed from the gateway (probed 2026-09-12).
        for message in ["Invalid API key", "No API key found in request"] {
            let body = serde_json::json!({
                "message": message,
                "hint": "Double check your Supabase `anon` or `service_role` API key.",
            });
            assert!(
                !is_refresh_fatal(StatusCode::UNAUTHORIZED, &body),
                "{message} must not clear the session"
            );
        }
    }

    #[test]
    fn refresh_still_fatal_for_401_from_the_legacy_vercel_route() {
        // Older builds point at /api/auth/refresh, which reports a dead refresh
        // token as a bare 401 — that must keep clearing the session.
        let legacy = serde_json::json!({ "error": "Failed to refresh token" });
        assert!(is_refresh_fatal(StatusCode::UNAUTHORIZED, &legacy));
        assert!(is_refresh_fatal(StatusCode::UNAUTHORIZED, &NO_BODY));
    }

    #[test]
    fn refresh_not_fatal_for_400_unrelated_to_the_token() {
        // A 400 about something other than the refresh token is our bug, not a
        // dead session — retrying is right, logging the user out is not.
        let other = serde_json::json!({
            "code": 400,
            "error_code": "validation_failed",
            "msg": "Unsupported grant_type",
        });
        assert!(!is_refresh_fatal(StatusCode::BAD_REQUEST, &other));
        // A 400 we can't parse at all also stays non-fatal.
        assert!(!is_refresh_fatal(StatusCode::BAD_REQUEST, &NO_BODY));
    }

    #[test]
    fn needs_refresh_window() {
        let now = now_ms();
        let base = SessionData {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: 0,
            user_id: "u".into(),
        };

        // Within 10 min of expiry → refresh.
        assert!(needs_refresh(&SessionData {
            expires_at: now + 5 * 60 * 1000,
            ..base.clone()
        }));
        // Already expired → refresh.
        assert!(needs_refresh(&SessionData {
            expires_at: now.saturating_sub(60_000),
            ..base.clone()
        }));
        // Plenty of headroom → no-op (this is the hot path).
        assert!(!needs_refresh(&SessionData {
            expires_at: now + 30 * 60 * 1000,
            ..base.clone()
        }));
        // No refresh token → can't refresh anyway.
        assert!(!needs_refresh(&SessionData {
            refresh_token: String::new(),
            expires_at: 0,
            ..base
        }));
    }
}
