use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const API_BASE: &str = "https://ws.audioscrobbler.com/2.0/";
pub const ENRICHMENT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `poll_tick` waits before retrying a failed lookup for an
/// unverified source, which can't count until one succeeds.
pub const ENRICHMENT_RETRY: Duration = Duration::from_secs(30);
const RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(60);

/// Metadata from Last.fm (and future providers) for the current track.
#[derive(Debug, Clone)]
pub struct TrackEnrichment {
    pub tags: Vec<String>,
    pub album_art_url: Option<String>,
    pub vibe: Option<String>,
    /// Reserved for a future BPM provider; Last.fm does not expose BPM.
    #[allow(dead_code)]
    pub bpm: Option<u32>,
    /// Whether `track.getInfo` confirmed this artist+title is a real,
    /// catalogued track — as opposed to falling back to the artist's top
    /// tags after a "not found", or matching an entry that only exists
    /// because someone scrobbled a video (see `is_catalogued_track`). Used
    /// to gate XP for unverified sources (browsers/YouTube) that can't be
    /// confirmed any other way.
    pub found: bool,
}

const GAME_GENRES: &[&str] = &[
    "pop",
    "rock",
    "hip-hop",
    "electronic",
    "jazz",
    "classical",
    "r&b",
    "country",
    "metal",
    "indie",
    "latin",
    "folk",
    "blues",
    "punk",
    "soul",
];

const MOOD_TAGS: &[&str] = &[
    "chill",
    "sad",
    "happy",
    "energetic",
    "melancholic",
    "dark",
    "uplifting",
    "relaxing",
    "aggressive",
    "romantic",
    "dreamy",
    "intense",
    "calm",
    "gloomy",
    "cheerful",
    "mellow",
    "hypnotic",
    "atmospheric",
    "peaceful",
    "brooding",
    "euphoric",
];

/// Tags that carry no genre/mood signal but rank high on artist.getTopTags.
const JUNK_TAGS: &[&str] = &[
    "seen live",
    "favorites",
    "favourites",
    "albums i own",
    "under 2000 listeners",
    "spotify",
];

fn is_junk_tag(tag: &str) -> bool {
    JUNK_TAGS.contains(&tag.to_lowercase().as_str())
}

fn is_version_marker(content: &str) -> bool {
    const MARKERS: &[&str] = &[
        "remaster",
        "remastered",
        "deluxe",
        "edition",
        "anniversary",
        "expanded",
        "mono",
        "stereo",
        "version",
        "edit",
        "bonus",
        // YouTube upload decorations: "(Official Music Video)", "[Lyric Video]", ...
        "official",
        "video",
        "audio",
        "lyric",
        "lyrics",
        "visualizer",
    ];
    content
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| MARKERS.contains(&w))
}

/// Strip trailing version markers — "(Remastered)", "[Deluxe Edition]",
/// "- 2014 Remaster", etc. — so the Last.fm lookup hits the canonical track
/// entry instead of a sparsely-tagged variant. Conservative: only removes a
/// trailing parenthetical/bracket group or dash suffix whose words match a
/// known marker, so titles like "Time (Clock of the Heart)" survive intact.
pub fn normalize_title(title: &str) -> String {
    let mut t = title.trim();
    loop {
        let trimmed = t.trim_end();
        let stripped = if trimmed.ends_with(')') {
            trimmed
                .rfind('(')
                .filter(|&i| i > 0 && is_version_marker(&trimmed[i + 1..trimmed.len() - 1]))
                .map(|i| &trimmed[..i])
        } else if trimmed.ends_with(']') {
            trimmed
                .rfind('[')
                .filter(|&i| i > 0 && is_version_marker(&trimmed[i + 1..trimmed.len() - 1]))
                .map(|i| &trimmed[..i])
        } else {
            trimmed
                .rfind(" - ")
                .filter(|&i| i > 0 && is_version_marker(&trimmed[i + 3..]))
                .map(|i| &trimmed[..i])
        };
        match stripped {
            Some(s) => t = s,
            None => break,
        }
    }
    let t = t.trim();
    if t.is_empty() {
        title.trim().to_string()
    } else {
        t.to_string()
    }
}

/// Strip YouTube channel decorations from an artist name — "Rick Astley -
/// Topic", "RickAstleyVEVO" — so the lookup hits the artist's real entry.
pub fn normalize_artist(artist: &str) -> String {
    let a = artist.trim();
    let a = a.strip_suffix(" - Topic").unwrap_or(a);
    let a = a
        .strip_suffix("VEVO")
        .or_else(|| a.strip_suffix("Vevo"))
        .filter(|rest| !rest.trim().is_empty())
        .unwrap_or(a);
    a.trim().to_string()
}

/// Title to look up on Last.fm: `normalize_title`, plus dropping a leading
/// "Artist - " that YouTube uploads usually carry ("Rick Astley - Never
/// Gonna Give You Up (Official Music Video)"). The prefix goes first —
/// otherwise `normalize_title`'s dash rule would see "The Buggles - Video
/// Killed the Radio Star" and strip the song name as a version marker.
pub fn lookup_title(artist: &str, title: &str) -> String {
    let t = title.trim();
    let prefix = format!("{} - ", artist.trim()).to_lowercase();
    let t = if t.len() > prefix.len()
        && t.is_char_boundary(prefix.len())
        && t[..prefix.len()].to_lowercase() == prefix
    {
        &t[prefix.len()..]
    } else {
        t
    };
    normalize_title(t)
}

pub fn track_key(artist: &str, title: &str) -> String {
    format!(
        "{}\0{}",
        artist.trim().to_lowercase(),
        title.trim().to_lowercase()
    )
}

/// Whether the current listen is confirmed as real music — gates both XP
/// crediting and what `sync_tick` reports to the server (now-playing status,
/// listen_log, which writes a permanent row). Trusted sources
/// (Music/Spotify/Tidal, or anything the OS flags as a music app) always
/// count. Everything else — mainly browser web players, including YouTube —
/// only counts once Last.fm's `track.getInfo` confirms the artist+title is a
/// real, catalogued track (`enrichment.found`). This fails *closed*: a
/// pending, timed-out, rate-limited or failed lookup (or no API key at all)
/// never confirms an unverified source, since browser audio is far more
/// often a random video than music. `poll_tick` retries failed lookups.
pub fn is_confirmed_listen(verified: bool, enrichment: Option<&TrackEnrichment>) -> bool {
    verified || enrichment.is_some_and(|e| e.found)
}

/// Genres to use for XP / sync. Returns `None` while Last.fm enrichment is pending.
pub fn resolve_listen_genres(
    local_genre: Option<&str>,
    enrichment: Option<&TrackEnrichment>,
    enrichment_timed_out: bool,
    enrichment_in_flight: bool,
) -> Option<Vec<String>> {
    if let Some(g) = local_genre.filter(|s| !s.is_empty()) {
        return Some(vec![g.to_string()]);
    }
    if let Some(e) = enrichment {
        if !e.tags.is_empty() {
            return Some(e.tags.clone());
        }
        return Some(vec!["pop".to_string()]);
    }
    if enrichment_timed_out {
        return Some(vec!["pop".to_string()]);
    }
    if enrichment_in_flight {
        return None;
    }
    Some(vec!["pop".to_string()])
}

pub fn pick_album_art(images: &[Value]) -> Option<String> {
    // Prefer medium (64×64) — closest to the 48×48 UI without upscaling.
    const SIZE_ORDER: &[&str] = &["medium", "large", "extralarge", "small"];
    for size in SIZE_ORDER {
        for img in images {
            if img.get("size").and_then(|s| s.as_str()) != Some(size) {
                continue;
            }
            let url = img.get("#text").and_then(|t| t.as_str()).unwrap_or("");
            if !url.is_empty() {
                return Some(url.to_string());
            }
        }
    }
    None
}

pub fn parse_tag_names(toptags: &Value) -> Vec<String> {
    let tag_val = match toptags.get("tag") {
        Some(v) => v,
        None => return Vec::new(),
    };
    let tags: Vec<&Value> = if tag_val.is_array() {
        tag_val.as_array().unwrap().iter().collect()
    } else {
        vec![tag_val]
    };
    tags.iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
        .map(|s| s.to_string())
        .collect()
}

pub fn pick_vibe(tags: &[String]) -> Option<String> {
    for tag in tags {
        let lower = tag.to_lowercase();
        if GAME_GENRES.iter().any(|g| *g == lower) {
            continue;
        }
        if MOOD_TAGS.iter().any(|m| lower.contains(m)) {
            return Some(tag.clone());
        }
    }
    None
}

/// Whether a `track.getInfo` hit is a real catalogued track rather than an
/// entry that exists only because someone scrobbled a video (browser
/// scrobblers happily submit "MrBeast — I Spent 50 Hours Buried Alive").
/// Those scrobble-only entries have no catalogue duration and no album;
/// listener counts don't separate them (a MrBeast video has more Last.fm
/// listeners than plenty of real indie tracks).
fn is_catalogued_track(track: &Value) -> bool {
    let duration_ms = track
        .get("duration")
        .and_then(|d| {
            d.as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .or(d.as_u64())
        })
        .unwrap_or(0);
    let has_album = track
        .get("album")
        .and_then(|a| a.get("title"))
        .and_then(|t| t.as_str())
        .is_some_and(|t| !t.trim().is_empty());
    duration_ms > 0 || has_album
}

pub fn parse_track_response(body: &Value) -> Option<TrackEnrichment> {
    if body.get("error").is_some() {
        return None;
    }
    let track = body.get("track")?;
    let tags = track
        .get("toptags")
        .map(parse_tag_names)
        .unwrap_or_default();
    let images = track
        .get("album")
        .and_then(|a| a.get("image"))
        .and_then(|i| i.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    let album_art_url = pick_album_art(images);
    let vibe = pick_vibe(&tags);
    Some(TrackEnrichment {
        tags,
        album_art_url,
        vibe,
        bpm: None,
        found: is_catalogued_track(track),
    })
}

pub struct LastFmService {
    api_key: Option<String>,
    app_name: String,
    http: reqwest::Client,
    cache: Mutex<HashMap<String, TrackEnrichment>>,
    artist_tags_cache: Mutex<HashMap<String, Vec<String>>>,
    rate_limit_until: Mutex<Option<Instant>>,
    warned_missing_key: Mutex<bool>,
}

impl LastFmService {
    pub fn from_env() -> Self {
        // Runtime env wins (so .env.local can override a baked-in key in dev);
        // compile-time `option_env!` is the fallback so the shipped binary works
        // without the user setting anything.
        let api_key = std::env::var("LASTFM_API_KEY")
            .ok()
            .or_else(|| option_env!("LASTFM_API_KEY").map(str::to_string))
            .filter(|k| !k.is_empty());
        let app_name = std::env::var("LASTFM_APP_NAME")
            .ok()
            .or_else(|| option_env!("LASTFM_APP_NAME").map(str::to_string))
            .unwrap_or_else(|| "Herzies".to_string());
        Self {
            api_key,
            app_name,
            http: reqwest::Client::new(),
            cache: Mutex::new(HashMap::new()),
            artist_tags_cache: Mutex::new(HashMap::new()),
            rate_limit_until: Mutex::new(None),
            warned_missing_key: Mutex::new(false),
        }
    }

    pub fn has_api_key(&self) -> bool {
        self.api_key.is_some()
    }

    pub async fn fetch_track(&self, artist: &str, title: &str) -> Option<TrackEnrichment> {
        self.api_key.as_ref()?;
        let artist = &normalize_artist(artist);
        let lookup_title = lookup_title(artist, title);
        let cache_key = track_key(artist, &lookup_title);

        if let Some(cached) = self.cache.lock().unwrap().get(&cache_key).cloned() {
            return Some(cached);
        }

        let body = self
            .request(&[
                ("method", "track.getInfo"),
                ("artist", artist),
                ("track", &lookup_title),
            ])
            .await?;

        // An unknown track still deserves the artist-tags fallback below, but
        // `found` stays false — the exact track was never confirmed, only
        // (maybe) its artist.
        let mut enrichment = parse_track_response(&body).unwrap_or(TrackEnrichment {
            tags: Vec::new(),
            album_art_url: None,
            vibe: None,
            bpm: None,
            found: false,
        });

        // Sparsely-scrobbled tracks often have no tags; the artist's top tags
        // are a decent genre proxy in that case.
        if enrichment.tags.is_empty() {
            if let Some(artist_tags) = self.fetch_artist_tags(artist).await {
                enrichment.vibe = pick_vibe(&artist_tags);
                enrichment.tags = artist_tags;
            }
        }

        self.cache
            .lock()
            .unwrap()
            .insert(cache_key, enrichment.clone());
        Some(enrichment)
    }

    async fn fetch_artist_tags(&self, artist: &str) -> Option<Vec<String>> {
        let cache_key = artist.trim().to_lowercase();

        if let Some(cached) = self.artist_tags_cache.lock().unwrap().get(&cache_key) {
            return Some(cached.clone());
        }

        let body = self
            .request(&[("method", "artist.getTopTags"), ("artist", artist)])
            .await?;

        if body.get("error").is_some() {
            return None;
        }
        let tags: Vec<String> = body
            .get("toptags")
            .map(parse_tag_names)
            .unwrap_or_default()
            .into_iter()
            .filter(|t| !is_junk_tag(t))
            .take(5)
            .collect();

        self.artist_tags_cache
            .lock()
            .unwrap()
            .insert(cache_key, tags.clone());
        Some(tags)
    }

    /// Single Last.fm GET with shared rate-limit bookkeeping.
    async fn request(&self, params: &[(&str, &str)]) -> Option<Value> {
        let api_key = self.api_key.as_ref()?;

        {
            let until = self.rate_limit_until.lock().unwrap();
            if let Some(until) = *until {
                if Instant::now() < until {
                    return None;
                }
            }
        }

        let user_agent = format!("Herzies/{} ({})", env!("CARGO_PKG_VERSION"), self.app_name);

        let resp = self
            .http
            .get(API_BASE)
            .header("User-Agent", user_agent)
            .query(params)
            .query(&[
                ("api_key", api_key.as_str()),
                ("autocorrect", "1"),
                ("format", "json"),
            ])
            .send()
            .await
            .ok()?;

        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            *self.rate_limit_until.lock().unwrap() = Some(Instant::now() + RATE_LIMIT_BACKOFF);
            log::warn!("Last.fm rate limit hit; backing off for 60s");
            return None;
        }

        let body: Value = resp.json().await.ok()?;

        if body.get("error").and_then(|e| e.as_i64()) == Some(29) {
            *self.rate_limit_until.lock().unwrap() = Some(Instant::now() + RATE_LIMIT_BACKOFF);
            log::warn!("Last.fm rate limit (error 29); backing off for 60s");
            return None;
        }

        Some(body)
    }

    pub fn log_missing_key_once(&self) {
        if self.api_key.is_some() {
            return;
        }
        let mut warned = self.warned_missing_key.lock().unwrap();
        if !*warned {
            *warned = true;
            log::info!("LASTFM_API_KEY not set; track enrichment disabled");
        }
    }
}

pub fn load_env() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env.local");
    if path.exists() {
        let _ = dotenvy::from_path(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_tags_from_array() {
        let body = json!({
            "track": {
                "toptags": {
                    "tag": [
                        { "name": "indie rock" },
                        { "name": "chill" }
                    ]
                },
                "album": { "image": [] }
            }
        });
        let e = parse_track_response(&body).unwrap();
        assert_eq!(e.tags, vec!["indie rock", "chill"]);
        assert_eq!(e.vibe.as_deref(), Some("chill"));
    }

    #[test]
    fn parse_tags_from_single_object() {
        let body = json!({
            "track": {
                "toptags": { "tag": { "name": "rock" } },
                "album": { "image": [] }
            }
        });
        let e = parse_track_response(&body).unwrap();
        assert_eq!(e.tags, vec!["rock"]);
        assert!(e.vibe.is_none());
    }

    #[test]
    fn pick_medium_art_when_available() {
        let images = vec![
            json!({ "#text": "http://small.jpg", "size": "small" }),
            json!({ "#text": "http://medium.jpg", "size": "medium" }),
            json!({ "#text": "http://xl.jpg", "size": "extralarge" }),
        ];
        assert_eq!(
            pick_album_art(&images).as_deref(),
            Some("http://medium.jpg")
        );
    }

    #[test]
    fn pick_falls_back_when_medium_missing() {
        let images = vec![
            json!({ "#text": "http://small.jpg", "size": "small" }),
            json!({ "#text": "http://large.jpg", "size": "large" }),
            json!({ "#text": "http://xl.jpg", "size": "extralarge" }),
        ];
        assert_eq!(pick_album_art(&images).as_deref(), Some("http://large.jpg"));
    }

    #[test]
    fn resolve_prefers_local_genre() {
        let genres = resolve_listen_genres(Some("Jazz"), None, false, false).unwrap();
        assert_eq!(genres, vec!["Jazz"]);
    }

    #[test]
    fn resolve_waits_while_in_flight() {
        assert!(resolve_listen_genres(None, None, false, true).is_none());
    }

    #[test]
    fn resolve_uses_lastfm_tags() {
        let enrichment = TrackEnrichment {
            tags: vec!["indie".to_string()],
            album_art_url: None,
            vibe: None,
            bpm: None,
            found: true,
        };
        let genres = resolve_listen_genres(None, Some(&enrichment), false, false).unwrap();
        assert_eq!(genres, vec!["indie"]);
    }

    fn enrichment(found: bool) -> TrackEnrichment {
        TrackEnrichment {
            tags: vec![],
            album_art_url: None,
            vibe: None,
            bpm: None,
            found,
        }
    }

    #[test]
    fn confirmed_trusted_source_always_counts() {
        assert!(is_confirmed_listen(true, None));
    }

    #[test]
    fn confirmed_unverified_counts_once_lastfm_confirms() {
        assert!(is_confirmed_listen(false, Some(&enrichment(true))));
    }

    #[test]
    fn confirmed_unverified_rejected_when_lastfm_says_not_found() {
        assert!(!is_confirmed_listen(false, Some(&enrichment(false))));
    }

    #[test]
    fn confirmed_unverified_fails_closed_without_a_lookup() {
        // Pending, timed out, failed, or no API key — browser audio is more
        // often a video than music, so it never counts unconfirmed.
        assert!(!is_confirmed_listen(false, None));
    }

    #[test]
    fn parse_rejects_scrobble_only_video_entries() {
        // What track.getInfo returns for a scrobbled YouTube video.
        let body = json!({
            "track": {
                "name": "I Spent 50 Hours Buried Alive",
                "duration": "0",
                "listeners": "608",
                "toptags": { "tag": [] }
            }
        });
        assert!(!parse_track_response(&body).unwrap().found);
    }

    #[test]
    fn parse_accepts_catalogued_tracks() {
        let with_duration = json!({ "track": { "duration": "212000" } });
        assert!(parse_track_response(&with_duration).unwrap().found);
        let with_album = json!({
            "track": { "duration": "0", "album": { "title": "Whenever You Need Somebody" } }
        });
        assert!(parse_track_response(&with_album).unwrap().found);
    }

    #[test]
    fn normalizes_youtube_artist_names() {
        assert_eq!(normalize_artist("Rick Astley - Topic"), "Rick Astley");
        assert_eq!(normalize_artist("RickAstleyVEVO"), "RickAstley");
        assert_eq!(normalize_artist("Vevo"), "Vevo");
        assert_eq!(normalize_artist("Duster"), "Duster");
    }

    #[test]
    fn lookup_title_strips_youtube_decorations() {
        assert_eq!(
            lookup_title(
                "Rick Astley",
                "Rick Astley - Never Gonna Give You Up (Official Music Video)"
            ),
            "Never Gonna Give You Up"
        );
        assert_eq!(
            lookup_title("Duster", "Inside Out [Lyric Video]"),
            "Inside Out"
        );
        assert_eq!(lookup_title("Duster", "Inside Out"), "Inside Out");
        assert_eq!(
            lookup_title(
                "The Buggles",
                "The Buggles - Video Killed the Radio Star (Official Music Video)"
            ),
            "Video Killed the Radio Star"
        );
    }

    #[test]
    fn resolve_pop_after_timeout() {
        let genres = resolve_listen_genres(None, None, true, false).unwrap();
        assert_eq!(genres, vec!["pop"]);
    }

    #[test]
    fn parse_error_returns_none() {
        let body = json!({ "error": 6, "message": "Track not found" });
        assert!(parse_track_response(&body).is_none());
    }

    #[test]
    fn normalize_strips_parenthetical_remaster() {
        assert_eq!(normalize_title("Live Forever (Remastered)"), "Live Forever");
        assert_eq!(normalize_title("Wonderwall (2014 Remaster)"), "Wonderwall");
    }

    #[test]
    fn normalize_strips_dash_suffix() {
        assert_eq!(
            normalize_title("Live Forever - Remastered 2014"),
            "Live Forever"
        );
        assert_eq!(normalize_title("Heroes - 2017 Remaster"), "Heroes");
    }

    #[test]
    fn normalize_strips_brackets_and_stacked_suffixes() {
        assert_eq!(normalize_title("Song [Deluxe Edition]"), "Song");
        assert_eq!(normalize_title("Song (Remastered) [Bonus Track]"), "Song");
    }

    #[test]
    fn normalize_keeps_legit_parentheses_and_dashes() {
        assert_eq!(
            normalize_title("Time (Clock of the Heart)"),
            "Time (Clock of the Heart)"
        );
        assert_eq!(
            normalize_title("Brain Damage - Eclipse"),
            "Brain Damage - Eclipse"
        );
        assert_eq!(normalize_title("(Remastered)"), "(Remastered)");
    }

    #[test]
    fn junk_tags_filtered() {
        assert!(is_junk_tag("Seen Live"));
        assert!(is_junk_tag("albums i own"));
        assert!(!is_junk_tag("britpop"));
    }
}
