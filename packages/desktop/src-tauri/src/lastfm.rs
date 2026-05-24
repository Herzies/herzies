use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const API_BASE: &str = "https://ws.audioscrobbler.com/2.0/";
pub const ENRICHMENT_TIMEOUT: Duration = Duration::from_secs(5);
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

pub fn track_key(artist: &str, title: &str) -> String {
    format!(
        "{}\0{}",
        artist.trim().to_lowercase(),
        title.trim().to_lowercase()
    )
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
    })
}

pub struct LastFmService {
    api_key: Option<String>,
    app_name: String,
    http: reqwest::Client,
    cache: Mutex<HashMap<String, TrackEnrichment>>,
    rate_limit_until: Mutex<Option<Instant>>,
    warned_missing_key: Mutex<bool>,
}

impl LastFmService {
    pub fn from_env() -> Self {
        let api_key = std::env::var("LASTFM_API_KEY")
            .ok()
            .filter(|k| !k.is_empty());
        let app_name = std::env::var("LASTFM_APP_NAME").unwrap_or_else(|_| "Herzies".to_string());
        Self {
            api_key,
            app_name,
            http: reqwest::Client::new(),
            cache: Mutex::new(HashMap::new()),
            rate_limit_until: Mutex::new(None),
            warned_missing_key: Mutex::new(false),
        }
    }

    pub fn has_api_key(&self) -> bool {
        self.api_key.is_some()
    }

    pub async fn fetch_track(&self, artist: &str, title: &str) -> Option<TrackEnrichment> {
        let api_key = self.api_key.as_ref()?;
        let cache_key = track_key(artist, title);

        if let Some(cached) = self.cache.lock().unwrap().get(&cache_key).cloned() {
            return Some(cached);
        }

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
            .query(&[
                ("method", "track.getInfo"),
                ("api_key", api_key.as_str()),
                ("artist", artist),
                ("track", title),
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

        let enrichment = parse_track_response(&body)?;
        self.cache
            .lock()
            .unwrap()
            .insert(cache_key, enrichment.clone());
        Some(enrichment)
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
        };
        let genres = resolve_listen_genres(None, Some(&enrichment), false, false).unwrap();
        assert_eq!(genres, vec!["indie"]);
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
}
