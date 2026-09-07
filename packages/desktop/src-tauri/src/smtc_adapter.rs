//! Windows now-playing via System Media Transport Controls (SMTC), the
//! Windows analogue of macOS's MediaRemote (see `media_remote_adapter.rs`).
//! Every media app that participates in Windows' native media overlay
//! (Spotify, the built-in Media Player, browsers playing audio/video, etc.)
//! reports through this same session manager.

use crate::types::NowPlayingInfo;
use windows::core::Interface;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus, MediaPlaybackType,
};

pub fn get_now_playing() -> Option<NowPlayingInfo> {
    let manager = SessionManager::RequestAsync().ok()?.get().ok()?;
    let session = manager.GetCurrentSession().ok()?;
    // GetCurrentSession() returns a *valid but null* object (not an Err)
    // when nothing is playing — this is the common case, so it must be
    // checked explicitly before calling any method on `session`, or the
    // null COM pointer gets dereferenced.
    if session.as_raw().is_null() {
        return None;
    }

    let playback_info = session.GetPlaybackInfo().ok()?;
    if playback_info.PlaybackStatus().ok()? != PlaybackStatus::Playing {
        return None;
    }

    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
    let album = props
        .AlbumTitle()
        .map(|h| h.to_string())
        .unwrap_or_default();
    let genre = props
        .Genres()
        .ok()
        .and_then(|genres| genres.GetAt(0).ok())
        .map(|g| g.to_string())
        .unwrap_or_default();
    let playback_type = props
        .PlaybackType()
        .ok()
        .and_then(|t| t.Value().ok())
        .map(playback_type_str);

    let (elapsed, duration) = session
        .GetTimelineProperties()
        .map(|t| {
            let position = t.Position().map(timespan_secs).unwrap_or(0.0);
            let end = t.EndTime().map(timespan_secs).unwrap_or(0.0);
            (position, end)
        })
        .unwrap_or((0.0, 0.0));

    let source_app_id = session.SourceAppUserModelId().map(|h| h.to_string()).ok();

    let parsed = SmtcNowPlaying {
        title,
        artist,
        source_app_id,
        playback_type,
    };

    if parsed.title.trim().is_empty() || !counts_as_music_listening(&parsed) {
        return None;
    }

    let verified = is_trusted_music_source(&parsed);
    let source = parsed
        .source_app_id
        .as_deref()
        .map(source_from_app_id)
        .unwrap_or_else(|| "SMTC".to_string());

    Some(NowPlayingInfo {
        title: parsed.title,
        artist: parsed.artist,
        album,
        genre,
        duration,
        elapsed,
        is_playing: true,
        source,
        // SMTC exposes no per-session volume — `poll_tick` gates listens on
        // `volume > 0`, so this must stay non-zero or Windows listens never
        // accrue XP. Mirrors `media_remote_adapter.rs`'s same fixed 100.
        volume: 100,
        verified,
    })
}

fn timespan_secs(ts: windows::Foundation::TimeSpan) -> f64 {
    ts.Duration as f64 / 10_000_000.0
}

fn playback_type_str(t: MediaPlaybackType) -> String {
    match t {
        MediaPlaybackType::Music => "Music".to_string(),
        MediaPlaybackType::Video => "Video".to_string(),
        MediaPlaybackType::Image => "Image".to_string(),
        _ => "Unknown".to_string(),
    }
}

struct SmtcNowPlaying {
    title: String,
    artist: String,
    source_app_id: Option<String>,
    playback_type: Option<String>,
}

/// Known music apps' AppUserModelId — always count toward listening even
/// without a "Music" playback-type hint. Best-effort: AUMIDs for Win32 apps
/// without an explicit manifest (like Spotify's desktop build) are derived
/// from the executable name at runtime and have not been confirmed against
/// a real Windows install; expect to refine this list once verified there.
const MUSIC_APP_ALLOWLIST: &[&str] = &[
    "Spotify.exe",
    "Microsoft.ZuneMusic_8wekyb3d8bbwe!App", // Windows' built-in Media Player (Groove-derived)
];

/// Whether the source is trusted to be genuinely music on its own — a known
/// player, or SMTC's own "Music" playback-type hint. Everything else
/// (mainly browser web players) can still count as a listen via the
/// title+artist fallback below, but only provisionally: the caller uses
/// this flag to require a Last.fm confirmation before crediting XP for it
/// (see `poll_tick`), matching the macOS adapter's same policy.
fn is_trusted_music_source(parsed: &SmtcNowPlaying) -> bool {
    let app_id = parsed.source_app_id.as_deref().unwrap_or("");
    if MUSIC_APP_ALLOWLIST.contains(&app_id) {
        return true;
    }
    parsed.playback_type.as_deref() == Some("Music")
}

fn counts_as_music_listening(parsed: &SmtcNowPlaying) -> bool {
    if is_trusted_music_source(parsed) {
        return true;
    }

    // Reject clear video content whenever SMTC bothers to tell us.
    if parsed.playback_type.as_deref() == Some("Video") {
        return false;
    }

    // Everything else (notably browser audio) lacks a playback-type hint,
    // so it counts only when we can extract both a track title and artist.
    let has_title = !parsed.title.trim().is_empty();
    let has_artist = !parsed.artist.trim().is_empty();
    has_title && has_artist
}

fn source_from_app_id(app_id: &str) -> String {
    match app_id {
        "Spotify.exe" => "Spotify".into(),
        "Microsoft.ZuneMusic_8wekyb3d8bbwe!App" => "Media Player".into(),
        other => other
            .split('!')
            .next()
            .unwrap_or(other)
            .trim_end_matches(".exe")
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(app_id: &str, playback_type: Option<&str>) -> SmtcNowPlaying {
        SmtcNowPlaying {
            title: "Track".into(),
            artist: "Artist".into(),
            source_app_id: Some(app_id.into()),
            playback_type: playback_type.map(str::to_string),
        }
    }

    #[test]
    fn allowlists_music_apps() {
        assert!(counts_as_music_listening(&sample("Spotify.exe", None)));
    }

    #[test]
    fn trusts_music_playback_type() {
        assert!(is_trusted_music_source(&sample(
            "some.unknown.app",
            Some("Music")
        )));
    }

    #[test]
    fn accepts_browser_audio_with_title_and_artist() {
        assert!(counts_as_music_listening(&sample("msedge.exe", None)));
    }

    #[test]
    fn rejects_browser_audio_without_artist() {
        let mut np = sample("msedge.exe", None);
        np.artist = String::new();
        assert!(!counts_as_music_listening(&np));
    }

    #[test]
    fn rejects_browser_audio_without_title() {
        let mut np = sample("msedge.exe", None);
        np.title = "   ".into();
        assert!(!counts_as_music_listening(&np));
    }

    #[test]
    fn rejects_video_playback_type() {
        let np = sample("msedge.exe", Some("Video"));
        assert!(!counts_as_music_listening(&np));
    }
}
