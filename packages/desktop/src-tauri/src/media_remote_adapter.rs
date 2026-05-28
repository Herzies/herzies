//! macOS now playing via [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter).
//! Required on macOS 15.4+ where in-process MediaRemote calls return empty.

use crate::types::NowPlayingInfo;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

static MEDIAREMOTE_SCRIPT: OnceLock<PathBuf> = OnceLock::new();
static MEDIAREMOTE_FRAMEWORK: OnceLock<PathBuf> = OnceLock::new();

pub fn init(script: PathBuf, framework: PathBuf) {
    let _ = MEDIAREMOTE_SCRIPT.set(script);
    let _ = MEDIAREMOTE_FRAMEWORK.set(framework);
}

pub fn is_configured() -> bool {
    mediaremote_paths().is_some()
}

fn mediaremote_paths() -> Option<(PathBuf, PathBuf)> {
    let script = MEDIAREMOTE_SCRIPT.get()?;
    let framework = MEDIAREMOTE_FRAMEWORK.get()?;
    if script.is_file() && framework.is_dir() {
        Some((script.clone(), framework.clone()))
    } else {
        None
    }
}

/// Raw JSON from `get --no-artwork`, or `null` when nothing is playing.
pub fn raw_json() -> Option<String> {
    fetch_get_json(false)
}

/// Album art from the active player as a `data:` URL (fetched once per track; can be large).
pub fn fetch_system_artwork_url() -> Option<String> {
    let json = fetch_get_json(true)?;
    let parsed: AdapterArtworkPayload = serde_json::from_str(&json).ok()?;
    parsed.artwork_data_url()
}

fn fetch_get_json(include_artwork: bool) -> Option<String> {
    let (script, framework) = mediaremote_paths()?;
    let framework_str = framework.to_string_lossy();
    let mut cmd = Command::new("/usr/bin/perl");
    cmd.arg(&script).arg(Path::new(&*framework_str)).arg("get");
    if !include_artwork {
        cmd.arg("--no-artwork");
    }

    let output = cmd.output().ok()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!(
            "mediaremote-adapter get failed (status {:?}): {}",
            output.status.code(),
            stderr.trim()
        );
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() || stdout == "null" {
        None
    } else {
        Some(stdout)
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterArtworkPayload {
    #[serde(default)]
    artwork_mime_type: Option<String>,
    #[serde(default)]
    artwork_data: Option<String>,
}

impl AdapterArtworkPayload {
    fn artwork_data_url(&self) -> Option<String> {
        let data = self.artwork_data.as_ref().filter(|d| !d.is_empty())?;
        let mime = self
            .artwork_mime_type
            .as_ref()
            .filter(|m| !m.is_empty())
            .map(|m| m.as_str())
            .unwrap_or("image/jpeg");
        Some(format!("data:{mime};base64,{data}"))
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterNowPlaying {
    title: String,
    #[serde(default)]
    artist: Option<String>,
    #[serde(default)]
    album: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    elapsed_time: Option<f64>,
    #[serde(default)]
    playing: bool,
    #[serde(default)]
    genre: Option<String>,
    #[serde(default)]
    bundle_identifier: Option<String>,
    #[serde(default)]
    is_music_app: Option<bool>,
    #[serde(default)]
    media_type: Option<String>,
}

/// Known music players — always count toward listening even if album metadata is missing.
const MUSIC_BUNDLE_ALLOWLIST: &[&str] = &[
    "com.apple.Music",
    "com.spotify.client",
    "com.tidal.desktop",
    "com.apple.podcasts",
    "com.apple.MusicKit.MusicUI",
];

/// Browsers and other apps that often expose web/video Now Playing without album metadata.
const NON_MUSIC_BUNDLE_PREFIXES: &[&str] = &[
    "com.apple.Safari",
    "com.google.Chrome",
    "org.mozilla.firefox",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    "company.thebrowser.Browser",
    "com.operasoftware.Opera",
    "com.vivaldi.Vivaldi",
    "com.apple.QuickTimePlayerX",
    "com.colliderli.iina",
    "com.apple.TV",
];

fn counts_as_music_listening(parsed: &AdapterNowPlaying) -> bool {
    let bundle = parsed.bundle_identifier.as_deref().unwrap_or("");

    if MUSIC_BUNDLE_ALLOWLIST.contains(&bundle) {
        return true;
    }

    if NON_MUSIC_BUNDLE_PREFIXES
        .iter()
        .any(|prefix| bundle == *prefix || bundle.starts_with(&format!("{prefix}.")))
    {
        return false;
    }

    if parsed.is_music_app == Some(false) {
        return false;
    }

    if parsed.is_music_app == Some(true) {
        return true;
    }

    if let Some(ref media_type) = parsed.media_type {
        let mt = media_type.to_ascii_lowercase();
        if mt.contains("video") {
            return false;
        }
        if mt.contains("music") {
            return true;
        }
    }

    // Web players and misc sources: require album metadata (YouTube etc. usually omit it).
    parsed
        .album
        .as_ref()
        .is_some_and(|album| !album.trim().is_empty())
}

pub fn get_now_playing() -> Option<NowPlayingInfo> {
    let json = raw_json()?;
    let parsed: AdapterNowPlaying = serde_json::from_str(&json).ok()?;
    if parsed.title.is_empty() || !parsed.playing || !counts_as_music_listening(&parsed) {
        return None;
    }

    let source = parsed
        .bundle_identifier
        .as_deref()
        .map(source_from_bundle_id)
        .unwrap_or_else(|| "MediaRemote".to_string());

    Some(NowPlayingInfo {
        title: parsed.title,
        artist: parsed.artist.unwrap_or_default(),
        album: parsed.album.unwrap_or_default(),
        genre: parsed.genre.unwrap_or_default(),
        duration: parsed.duration.unwrap_or(0.0),
        elapsed: parsed.elapsed_time.unwrap_or(0.0),
        is_playing: true,
        source,
        volume: 100,
    })
}

fn source_from_bundle_id(bundle_id: &str) -> String {
    match bundle_id {
        "com.apple.Music" => "Music".into(),
        "com.spotify.client" => "Spotify".into(),
        "com.tidal.desktop" => "Tidal".into(),
        other => other.rsplit('.').next().unwrap_or(other).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(bundle: &str, is_music_app: Option<bool>, album: Option<&str>) -> AdapterNowPlaying {
        AdapterNowPlaying {
            title: "Track".into(),
            artist: Some("Artist".into()),
            album: album.map(str::to_string),
            duration: Some(200.0),
            elapsed_time: Some(10.0),
            playing: true,
            genre: None,
            bundle_identifier: Some(bundle.into()),
            is_music_app,
            media_type: None,
        }
    }

    #[test]
    fn allowlists_music_apps() {
        assert!(counts_as_music_listening(&sample(
            "com.tidal.desktop",
            None,
            None
        )));
    }

    #[test]
    fn rejects_browsers_without_album() {
        assert!(!counts_as_music_listening(&sample(
            "com.google.Chrome",
            Some(false),
            None
        )));
    }

    #[test]
    fn rejects_when_is_music_app_false() {
        assert!(!counts_as_music_listening(&sample(
            "com.example.app",
            Some(false),
            Some("Some Album")
        )));
    }

    #[test]
    fn accepts_unknown_with_album() {
        assert!(counts_as_music_listening(&sample(
            "com.example.app",
            None,
            Some("Album")
        )));
    }

    #[test]
    fn builds_data_url_from_artwork_fields() {
        let payload = AdapterArtworkPayload {
            artwork_mime_type: Some("image/png".into()),
            artwork_data: Some("abc123".into()),
        };
        assert_eq!(
            payload.artwork_data_url().as_deref(),
            Some("data:image/png;base64,abc123")
        );
    }
}
