//! The playing track's artwork from the OS (MediaRemote / SMTC), served to
//! the webview over the `herzies-art` protocol instead of as a `data:` URL.
//!
//! As a `data:` URL the image (often hundreds of KB of base64) rode inside
//! every `state-update`, which while listening is one every few seconds:
//! serialised, sent over IPC, parsed and deep-compared on the webview's main
//! thread, the same thread that draws the Town. Now the state carries a short
//! URL, and the bytes cross once, when the `<img>` loads them.

use base64::Engine;
use std::borrow::Cow;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::http::{header, Response, StatusCode};

pub const SCHEME: &str = "herzies-art";

/// One decoded image, ready to publish.
pub struct Artwork {
    mime: String,
    bytes: Vec<u8>,
}

impl Artwork {
    /// Decodes a `data:<mime>;base64,<data>` URL, as the adapters produce.
    pub fn from_data_url(data_url: &str) -> Option<Self> {
        let (meta, data) = data_url.strip_prefix("data:")?.split_once(',')?;
        let mime = meta.strip_suffix(";base64")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .ok()?;
        Some(Self {
            mime: mime.to_string(),
            bytes,
        })
    }
}

/// The published image. Only ever the latest: the state never points at an
/// older one, because a track change clears its URL before the next is
/// published (and publishing happens under the state lock, after checking
/// the track is still the one playing).
static CURRENT: Mutex<Option<(u64, Artwork)>> = Mutex::new(None);
/// Each publish gets a new id, so its URL is new and the `<img>` reloads.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Makes `art` the image the protocol serves and returns its URL.
pub fn publish(art: Artwork) -> String {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    *CURRENT.lock().unwrap() = Some((id, art));
    url_for(id)
}

/// Custom protocols are `<scheme>://localhost/` on macOS and Linux, and
/// `http://<scheme>.localhost/` on Windows (see
/// `tauri::Builder::register_uri_scheme_protocol`).
fn url_for(id: u64) -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{id}")
    } else {
        format!("{SCHEME}://localhost/{id}")
    }
}

/// The protocol's answer for a request to `path` (`/<id>`).
pub fn respond(path: &str) -> Response<Cow<'static, [u8]>> {
    let id = path.trim_start_matches('/').parse::<u64>().ok();
    let current = CURRENT.lock().unwrap();
    match current
        .as_ref()
        .filter(|(current_id, _)| Some(*current_id) == id)
    {
        Some((_, art)) => Response::builder()
            .header(header::CONTENT_TYPE, art.mime.as_str())
            // An id is one image for good.
            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
            .body(Cow::Owned(art.bytes.clone()))
            .unwrap(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Cow::Borrowed(&[][..]))
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_the_latest_artwork() {
        let first = publish(Artwork::from_data_url("data:image/png;base64,AQID").unwrap());
        let second = publish(Artwork::from_data_url("data:image/jpeg;base64,BAUG").unwrap());
        let path = |url: &str| {
            url.rsplit_once('/')
                .map(|(_, id)| format!("/{id}"))
                .unwrap()
        };

        let hit = respond(&path(&second));
        assert_eq!(hit.status(), StatusCode::OK);
        assert_eq!(hit.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(hit.body().as_ref(), &[4, 5, 6]);

        assert_eq!(respond(&path(&first)).status(), StatusCode::NOT_FOUND);
        assert_eq!(respond("/nonsense").status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn rejects_what_is_not_a_base64_data_url() {
        assert!(Artwork::from_data_url("https://example.com/a.jpg").is_none());
        assert!(Artwork::from_data_url("data:image/png,plain").is_none());
        assert!(Artwork::from_data_url("data:image/png;base64,***").is_none());
    }
}
