//! Qobuz's desktop app publishes nothing to the system's Now Playing (its
//! player is native), so playback is read from its own log: the last
//! "Status has changed to …" line says whether it's playing and the last
//! "Play track <id>" line says which track. Title and artist come from the
//! Qobuz API, using the app's own session token from `localuser.json`.

use crate::types::NowPlayingInfo;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const APP_ID: &str = "304027809";
const LOG_TAIL_BYTES: u64 = 64 * 1024;

#[derive(Clone)]
struct TrackMeta {
    title: String,
    artist: String,
    album: String,
    genre: String,
    duration: f64,
}

fn cache() -> &'static Mutex<HashMap<u64, TrackMeta>> {
    static CACHE: OnceLock<Mutex<HashMap<u64, TrackMeta>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn data_dir() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("Qobuz"))
}

/// (track id, elapsed seconds) if Qobuz's log says it's playing right now.
fn playing_track(log_tail: &str, now_unix: f64) -> Option<(u64, f64)> {
    let mut playing = false;
    let mut track: Option<(u64, f64)> = None;
    for line in log_tail.lines() {
        let Some((ts, msg)) = line.split_once("Z: ") else {
            continue;
        };
        if let Some(state) = msg.trim().strip_prefix("Status has changed to ") {
            playing = state.trim() == "Playing";
        } else if let Some(id) = msg.trim().strip_prefix("Play track ") {
            if let (Ok(id), Some(t)) = (id.trim().parse::<u64>(), parse_ts(ts)) {
                track = Some((id, t));
            }
        }
    }
    if !playing {
        return None;
    }
    let (id, started) = track?;
    Some((id, (now_unix - started).max(0.0)))
}

/// "2026-11-12T16:57:04.670" (UTC) → unix seconds.
fn parse_ts(ts: &str) -> Option<f64> {
    let (date, time) = ts.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let mut t = time.split(':');
    let h: f64 = t.next()?.parse().ok()?;
    let mi: f64 = t.next()?.parse().ok()?;
    let s: f64 = t.next()?.parse().ok()?;
    // days from civil (Howard Hinnant)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days as f64 * 86400.0 + h * 3600.0 + mi * 60.0 + s)
}

fn read_log_tail(dir: &std::path::Path) -> Option<String> {
    let mut f = std::fs::File::open(dir.join("logs").join("rapport_qobuz0.txt")).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(LOG_TAIL_BYTES)))
        .ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn session_token(dir: &std::path::Path) -> Option<String> {
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("localuser.json")).ok()?).ok()?;
    v.get("token")?.as_str().map(str::to_string)
}

async fn fetch_meta(track_id: u64, token: &str) -> Option<TrackMeta> {
    if let Some(m) = cache().lock().ok()?.get(&track_id) {
        return Some(m.clone());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let v: serde_json::Value = client
        .get("https://www.qobuz.com/api.json/0.2/track/get")
        .query(&[("track_id", track_id.to_string())])
        .header("X-App-Id", APP_ID)
        .header("X-User-Auth-Token", token)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let s = |p: &[&str]| -> String {
        let mut cur = &v;
        for k in p {
            match cur.get(*k) {
                Some(n) => cur = n,
                None => return String::new(),
            }
        }
        cur.as_str().unwrap_or("").to_string()
    };
    let meta = TrackMeta {
        title: s(&["title"]),
        artist: {
            let a = s(&["performer", "name"]);
            if a.is_empty() {
                s(&["album", "artist", "name"])
            } else {
                a
            }
        },
        album: s(&["album", "title"]),
        genre: s(&["album", "genre", "name"]),
        duration: v.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0),
    };
    if meta.title.is_empty() {
        return None;
    }
    cache().lock().ok()?.insert(track_id, meta.clone());
    Some(meta)
}

pub async fn get_now_playing() -> Option<NowPlayingInfo> {
    let dir = data_dir()?;
    let tail = read_log_tail(&dir)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs_f64();
    let (id, elapsed) = playing_track(&tail, now)?;
    let token = session_token(&dir)?;
    let meta = fetch_meta(id, &token).await?;
    // A stale log (Qobuz quit while "Playing") would linger; a track can't
    // have played longer than it lasts.
    if meta.duration > 0.0 && elapsed > meta.duration + 60.0 {
        return None;
    }
    Some(NowPlayingInfo {
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        genre: meta.genre,
        duration: meta.duration,
        elapsed: elapsed.min(meta.duration.max(elapsed)),
        is_playing: true,
        source: "Qobuz".into(),
        volume: 0,
        verified: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_playing_track_from_log() {
        let log = "2026-11-12T16:57:03.680Z: Status has changed to Playing \n\
                   2026-11-12T16:57:04.000Z: Play track 444529983 \n\
                   2026-11-12T16:57:05.000Z: Track 1 entirely buffered on player next \n";
        let start = parse_ts("2026-11-12T16:57:04.000").unwrap();
        let (id, el) = playing_track(log, start + 12.0).unwrap();
        assert_eq!(id, 444529983);
        assert!((el - 12.0).abs() < 0.01);
    }

    #[test]
    fn stopped_is_not_playing() {
        let log = "2026-11-12T16:57:04.000Z: Play track 5 \n\
                   2026-11-12T16:57:09.000Z: Status has changed to Stopped \n";
        assert!(playing_track(log, 0.0).is_none());
    }

    #[test]
    fn timestamps_are_unix_utc() {
        assert_eq!(parse_ts("1970-01-02T00:00:01.500"), Some(86401.5));
    }
}
