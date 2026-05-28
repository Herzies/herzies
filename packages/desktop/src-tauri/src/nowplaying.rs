use crate::types::NowPlayingInfo;
use std::process::Command;
use std::time::Duration;
use tokio::time::timeout;

const MUSIC_SCRIPT: &str = r#"
if application "Music" is not running then return "NOT_RUNNING"
tell application "Music"
    if player state is not playing then return "NOT_PLAYING"
    set t to name of current track
    set a to artist of current track
    set al to album of current track
    set g to genre of current track
    set d to duration of current track
    set p to player position
    set v to sound volume
    return t & "||" & a & "||" & al & "||" & g & "||" & d & "||" & p & "||" & v
end tell
"#;

const SPOTIFY_SCRIPT: &str = r#"
if application "Spotify" is not running then return "NOT_RUNNING"
tell application "Spotify"
    if player state is not playing then return "NOT_PLAYING"
    set u to spotify url of current track
    if u starts with "spotify:ad:" then return "NOT_PLAYING"
    set t to name of current track
    set a to artist of current track
    set al to album of current track
    set d to (duration of current track) / 1000
    set p to player position
    set v to sound volume
    return t & "||" & a & "||" & al & "||" & "||" & d & "||" & p & "||" & v
end tell
"#;

pub async fn get_now_playing() -> Option<NowPlayingInfo> {
    #[cfg(target_os = "macos")]
    if crate::media_remote_adapter::is_configured() {
        if let Ok(Some(info)) =
            tokio::task::spawn_blocking(crate::media_remote_adapter::get_now_playing).await
        {
            return Some(info);
        }
    }

    if let Some(info) = query_app(MUSIC_SCRIPT, "Music").await {
        return Some(info);
    }
    query_app(SPOTIFY_SCRIPT, "Spotify").await
}

#[cfg(target_os = "macos")]
pub fn raw_media_remote_json() -> Option<String> {
    crate::media_remote_adapter::raw_json()
}

#[cfg(not(target_os = "macos"))]
pub fn raw_media_remote_json() -> Option<String> {
    None
}

async fn query_app(script: &str, source: &str) -> Option<NowPlayingInfo> {
    let script = script.to_string();
    let source = source.to_string();

    let result = timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            Command::new("osascript").args(["-e", &script]).output()
        }),
    )
    .await
    .ok()?
    .ok()?
    .ok()?;

    let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();

    if stdout == "NOT_RUNNING" || stdout == "NOT_PLAYING" || stdout.is_empty() {
        return None;
    }

    let parts: Vec<&str> = stdout.split("||").collect();
    if parts.len() < 7 {
        return None;
    }

    Some(NowPlayingInfo {
        title: parts[0].to_string(),
        artist: parts[1].to_string(),
        album: parts[2].to_string(),
        genre: parts[3].to_string(),
        duration: parts[4].parse().unwrap_or(0.0),
        elapsed: parts[5].parse().unwrap_or(0.0),
        is_playing: true,
        source,
        volume: parts[6].parse().unwrap_or(0),
    })
}
