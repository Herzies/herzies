use crate::api;
use crate::state::SharedState;
use crate::storage;
use crate::types::SessionData;
use reqwest::Client;
use std::io::Read;
use std::net::TcpListener;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::timeout;

pub async fn login(app: &AppHandle) -> bool {
    let web_url =
        std::env::var("HERZIES_WEB_URL").unwrap_or_else(|_| "https://www.herzies.app".to_string());
    let port: u16 = 8974;

    timeout(Duration::from_secs(120), do_login(app, &web_url, port))
        .await
        .unwrap_or_default()
}

async fn do_login(app: &AppHandle, web_url: &str, port: u16) -> bool {
    let listener = match TcpListener::bind(format!("127.0.0.1:{}", port)) {
        Ok(l) => l,
        Err(_) => return false,
    };

    // Open browser
    let auth_url = format!("{}/auth/cli?port={}", web_url, port);
    if open::that(&auth_url).is_err() {
        return false;
    }

    // Set non-blocking so we can poll with timeout
    listener.set_nonblocking(true).ok();

    // Wait for the callback POST in a blocking task
    let result = tokio::task::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(120);

        loop {
            if std::time::Instant::now() > deadline {
                return None;
            }

            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = Vec::new();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .ok();
                    let _ = stream.read_to_end(&mut buf);
                    let request = String::from_utf8_lossy(&buf).to_string();

                    // Check it's a POST to /callback
                    if !request.starts_with("POST /callback") {
                        let response = "HTTP/1.1 405 Method Not Allowed\r\n\r\n";
                        let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
                        continue;
                    }

                    // Send response
                    let html = "<h1>Logged in! You can close this window.</h1>";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                        html.len(),
                        html
                    );
                    let _ = std::io::Write::write_all(&mut stream, response.as_bytes());

                    // Parse body (after \r\n\r\n)
                    if let Some(body_start) = request.find("\r\n\r\n") {
                        let body = &request[body_start + 4..];
                        return Some(body.to_string());
                    }
                    return None;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(_) => return None,
            }
        }
    })
    .await
    .ok()
    .flatten();

    let body = match result {
        Some(b) => b,
        None => return false,
    };

    // Parse URL-encoded body
    let params: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();

    let access_token = match params.get("access_token") {
        Some(t) if !t.is_empty() => t.clone(),
        _ => return false,
    };
    let refresh_token = params.get("refresh_token").cloned().unwrap_or_default();
    let expires_in: u64 = params
        .get("expires_in")
        .and_then(|v| v.parse().ok())
        .unwrap_or(3600);

    // Decode JWT to get userId
    let parts: Vec<&str> = access_token.split('.').collect();
    if parts.len() < 2 {
        return false;
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
            Err(_) => return false,
        }
    };

    if user_id.is_empty() {
        return false;
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    storage::save_session(&SessionData {
        access_token,
        refresh_token,
        expires_at: now_ms + expires_in * 1000,
        user_id,
    });

    let state = app.state::<SharedState>();

    // Reconcile any in-memory or on-disk herzie against the new session. If
    // the local data belongs to a different user (or no one), it gets wiped
    // here so we don't accidentally re-register someone else's pet.
    let local_for_user = crate::adopt_local_herzie();
    {
        let mut s = state.lock().unwrap();
        s.herzie = local_for_user;
    }

    // Sync herzie with server
    let client = Client::new();
    let server_herzie = api::api_get_me(&client).await;

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
        s.last_sync_ok = true;
        let app_state = s.to_app_state(env!("CARGO_PKG_VERSION"));
        drop(s);
        let _ = app.emit("state-update", &app_state);
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        crate::refresh_app_cache(&app_clone, &client).await;
    });

    true
}
