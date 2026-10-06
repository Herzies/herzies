use crate::api;
use crate::state::SharedState;
use crate::storage;
use crate::types::SessionData;
use reqwest::Client;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::time::timeout;

const CALLBACK_PORT: u16 = 8974;
/// How long we wait for the browser to hand the session back.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);
/// Per-connection budget for reading one request off the callback socket.
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound on a callback request (two JWTs plus headers fit comfortably).
const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub enum LoginError {
    Cancelled,
    PortInUse,
    BrowserOpenFailed,
    TimedOut,
    InvalidCallback,
}

impl LoginError {
    /// Stable string the frontend matches on.
    pub fn code(&self) -> &'static str {
        match self {
            LoginError::Cancelled => "cancelled",
            LoginError::PortInUse => "port_in_use",
            LoginError::BrowserOpenFailed => "browser_open_failed",
            LoginError::TimedOut => "timed_out",
            LoginError::InvalidCallback => "invalid_callback",
        }
    }
}

/// Runs one browser login. Resolves early with `Cancelled` when `cancel`
/// fires (or its sender is dropped by a newer attempt replacing it).
///
/// Everything here is async on purpose: the callback listener used to run in
/// `spawn_blocking`, so a saturated blocking pool left the port bound but
/// never accepted — the browser hung on "hang tight" until the app restarted.
/// Dropping this future now drops the listener and frees the port.
pub async fn login(app: &AppHandle, cancel: oneshot::Receiver<()>) -> Result<(), LoginError> {
    let web_url =
        std::env::var("HERZIES_WEB_URL").unwrap_or_else(|_| "https://www.herzies.app".to_string());

    // Echoed back by the browser with the session. Any other local page can
    // POST to the callback port too, so without this one could log the app
    // into an account of its choosing while we wait.
    let login_state = hex::encode(rand::random::<[u8; 16]>());

    let body = tokio::select! {
        res = timeout(LOGIN_TIMEOUT, wait_for_callback(&web_url, CALLBACK_PORT, &login_state)) => match res {
            Ok(r) => r?,
            Err(_) => {
                log::warn!("Login timed out waiting for the browser callback");
                return Err(LoginError::TimedOut);
            }
        },
        _ = cancel => {
            log::info!("Login cancelled");
            return Err(LoginError::Cancelled);
        }
    };

    finish_login(app, &body).await
}

async fn wait_for_callback(
    web_url: &str,
    port: u16,
    login_state: &str,
) -> Result<String, LoginError> {
    // A just-replaced attempt may still be dropping its listener on another
    // task, so give the port a moment to free up before giving up.
    let mut attempts = 0;
    let listener = loop {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => break l,
            Err(e) if attempts < 10 => {
                attempts += 1;
                log::debug!("Login callback port {} busy ({}), retrying", port, e);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => {
                log::warn!("Login callback port {} unavailable: {}", port, e);
                return Err(LoginError::PortInUse);
            }
        }
    };
    log::info!("Login callback listening on 127.0.0.1:{}", port);

    let auth_url = format!("{}/auth/desktop?state={}", web_url, login_state);
    if let Err(e) = open::that(&auth_url) {
        log::warn!("Failed to open browser for login: {}", e);
        return Err(LoginError::BrowserOpenFailed);
    }

    loop {
        let (mut stream, _) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                log::warn!("Login callback accept failed: {}", e);
                continue;
            }
        };

        let request = match timeout(REQUEST_READ_TIMEOUT, read_request(&mut stream)).await {
            Ok(Some(r)) => r,
            _ => continue,
        };

        if !request.head.starts_with("POST /callback") {
            let _ = stream
                .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        }

        if !carries_state(&request.body, login_state) {
            log::warn!("Login callback rejected: state mismatch");
            let _ = stream
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        }

        let html = "<h1>Logged in! You can close this window.</h1>";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(),
            html
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
        log::info!("Login callback received");
        return Ok(request.body);
    }
}

/// Whether a URL-encoded callback body carries this attempt's `state`.
fn carries_state(body: &str, login_state: &str) -> bool {
    url::form_urlencoded::parse(body.as_bytes()).any(|(k, v)| k == "state" && v == login_state)
}

struct RawRequest {
    head: String,
    body: String,
}

/// Reads the request head, then exactly `Content-Length` body bytes. Browsers
/// keep the connection open, so reading to EOF would stall.
async fn read_request(stream: &mut TcpStream) -> Option<RawRequest> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];

    let head_end = loop {
        if let Some(i) = find_subslice(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_REQUEST_BYTES {
            return None;
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let content_length = head
        .lines()
        .skip(1)
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_REQUEST_BYTES {
        return None;
    }

    let body_start = head_end + 4;
    while buf.len() < body_start + content_length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }

    let body = String::from_utf8_lossy(&buf[body_start..body_start + content_length]).to_string();
    Some(RawRequest { head, body })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn finish_login(app: &AppHandle, body: &str) -> Result<(), LoginError> {
    // Parse URL-encoded body
    let params: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();

    let access_token = match params.get("access_token") {
        Some(t) if !t.is_empty() => t.clone(),
        _ => return Err(LoginError::InvalidCallback),
    };
    let refresh_token = params.get("refresh_token").cloned().unwrap_or_default();
    let expires_in: u64 = params
        .get("expires_in")
        .and_then(|v| v.parse().ok())
        .unwrap_or(3600);

    // Decode JWT to get userId
    let parts: Vec<&str> = access_token.split('.').collect();
    if parts.len() < 2 {
        return Err(LoginError::InvalidCallback);
    }

    use base64::Engine;
    let user_id = {
        // JWT uses base64url (no padding)
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[1])
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(parts[1]));
        match decoded {
            Ok(bytes) => {
                let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
                payload["sub"].as_str().unwrap_or_default().to_string()
            }
            Err(_) => return Err(LoginError::InvalidCallback),
        }
    };

    if user_id.is_empty() {
        return Err(LoginError::InvalidCallback);
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let state = app.state::<SharedState>();

    // From here the session exists, so the UI would otherwise treat us as
    // logged in while the herzie and items are still loading: it showed the
    // herzie bare (or the onboarding screen) for a moment, and judged the bag
    // full against the base capacity. Hold it on a loading splash instead.
    // Nothing below returns early, so this is always cleared.
    state.lock().unwrap().logging_in = true;
    storage::save_session(&SessionData {
        access_token,
        refresh_token,
        expires_at: now_ms + expires_in * 1000,
        user_id,
    });
    crate::emit_state_update(app);

    // Reconcile any in-memory or on-disk herzie against the new session. If
    // the local data belongs to a different user (or no one), it gets wiped
    // here so we don't accidentally re-register someone else's pet.
    let local_for_user = crate::adopt_local_herzie();
    let equip_epoch_before = {
        let mut s = state.lock().unwrap();
        s.herzie = local_for_user;
        s.equip_epoch
    };

    // Load the herzie and its items together, so the first state shown after
    // the splash is complete. Bounded so a hung request can't pin the login
    // command; the sync loop picks up anything missed here.
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_default();
    let (server_herzie, items) =
        tokio::join!(api::api_get_me(&client), api::api_fetch_inventory(&client));

    if let Some(h) = server_herzie {
        storage::save_herzie(&h);
        let mut s = state.lock().unwrap();
        s.herzie = Some(h);
    } else {
        // Server has nothing for this user. If we still hold a local herzie
        // here, it provably belongs to this user (adopt_local_herzie just
        // confirmed it) — upload it. Otherwise the UI falls through to the
        // onboarding screen.
        let herzie_clone = {
            let s = state.lock().unwrap();
            s.herzie.clone()
        };
        if let Some(herzie) = herzie_clone {
            if let Ok(registered) = api::api_register_herzie(&client, &herzie).await {
                storage::save_herzie(&registered);
                let mut s = state.lock().unwrap();
                s.herzie = Some(registered);
            }
        }
    }

    {
        let mut s = state.lock().unwrap();
        if let Some(snapshot) = items {
            crate::apply_inventory(&mut s, snapshot, Some(equip_epoch_before));
        }
        s.last_sync_ok = true;
        s.logging_in = false;
        let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
        drop(s);
        let _ = app.emit("state-update", &app_state);
    }

    // Items are already in; chat and friends can follow.
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let client = crate::api::http();
        crate::refresh_app_cache(&app_clone, &client, false).await;
    });

    log::info!("Login complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_must_carry_the_issued_state() {
        let state = "0123456789abcdef0123456789abcdef";
        assert!(carries_state(
            &format!("access_token=a.b.c&refresh_token=r&state={state}"),
            state
        ));
        assert!(!carries_state("access_token=a.b.c&refresh_token=r", state));
        assert!(!carries_state(
            "access_token=a.b.c&state=ffffffffffffffffffffffffffffffff",
            state
        ));
        assert!(!carries_state("access_token=a.b.c&state=", state));
    }

    #[tokio::test]
    async fn reads_body_split_across_writes_on_open_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let body = "access_token=a.b.c&refresh_token=r&expires_in=3600";

        let client = tokio::spawn(async move {
            let mut s = TcpStream::connect(addr).await.unwrap();
            let head = format!(
                "POST /callback HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            s.write_all(head.as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            s.write_all(body.as_bytes()).await.unwrap();
            // Keep the connection open like a browser would.
            tokio::time::sleep(Duration::from_secs(1)).await;
        });

        let (mut stream, _) = listener.accept().await.unwrap();
        let req = timeout(Duration::from_millis(500), read_request(&mut stream))
            .await
            .expect("should not wait for EOF")
            .unwrap();
        assert!(req.head.starts_with("POST /callback"));
        assert_eq!(req.body, body);
        client.abort();
    }
}
