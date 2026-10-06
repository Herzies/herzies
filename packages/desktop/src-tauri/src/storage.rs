use crate::types::{ActiveMultiplier, Herzie, HerzieProfile, SessionData};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashMap;

pub type Inventory = HashMap<String, u32>;
pub type ItemUpgrades = HashMap<String, u32>;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryCacheFile {
    inventory: Inventory,
    currency: u32,
    /// Dice-upgrade levels — folded in here rather than a separate cache
    /// file since the two are always written together server-side too.
    /// Defaulted so a cache file written before this field existed still
    /// loads.
    #[serde(default)]
    item_upgrades: ItemUpgrades,
    /// Every owned copy. Defaulted so a cache file written before copies
    /// existed still loads — with none, and the next sync fills them in.
    #[serde(default)]
    units: Vec<crate::types::ItemUnit>,
    /// Inventory Expansions owned — cached so the grid opens at its real size
    /// rather than shrinking to the starting 18 (and hiding tiles) until the
    /// first sync lands. Defaulted so an older cache file still loads.
    #[serde(default)]
    bank_expansions: u32,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FriendsCacheFile {
    friend_codes: Vec<String>,
    profiles: HashMap<String, HerzieProfile>,
}
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

type HmacSha256 = Hmac<Sha256>;

const HMAC_SALT: &str = "hrzs_v1_8f3a2c";

// Unix (including macOS) keeps its existing `~/.config/herzies` path
// byte-for-byte — changing it would orphan every existing user's local
// herzie/session data. Windows has no such history, so it gets the
// platform-idiomatic `%APPDATA%\herzies` instead.
#[cfg(unix)]
fn config_dir() -> PathBuf {
    dirs::home_dir()
        .expect("No home directory")
        .join(".config")
        .join("herzies")
}

#[cfg(windows)]
fn config_dir() -> PathBuf {
    dirs::config_dir()
        .expect("No config directory")
        .join("herzies")
}

fn ensure_dir() {
    let dir = config_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).ok();
        #[cfg(unix)]
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).ok();
    }
}

/// Hash of what this process last wrote to each file, so a write whose
/// content hasn't changed can be skipped. The background loops re-save the
/// herzie, equipped set, multipliers and inventory cache after every sync, and
/// nearly all of those writes used to be byte-identical rewrites.
static LAST_WRITTEN: Mutex<Option<HashMap<PathBuf, u64>>> = Mutex::new(None);

/// Hash of the *content* of a JSON document, independent of object key order.
/// The cached state is full of `HashMap`s (inventory, equipped, upgrades,
/// friends, genre minutes), and each one freshly deserialized from a response
/// iterates in a new random order — so hashing the serialized text would see
/// every rewrite as a change. Non-JSON data falls back to the raw text.
fn content_hash(data: &str) -> u64 {
    let mut h = DefaultHasher::new();
    match serde_json::from_str::<serde_json::Value>(data) {
        Ok(value) => hash_json(&value, &mut h),
        Err(_) => data.hash(&mut h),
    }
    h.finish()
}

fn hash_json(value: &serde_json::Value, h: &mut DefaultHasher) {
    use serde_json::Value;
    match value {
        Value::Null => 0u8.hash(h),
        Value::Bool(b) => (1u8, b).hash(h),
        Value::Number(n) => (2u8, n.to_string()).hash(h),
        Value::String(s) => (3u8, s).hash(h),
        Value::Array(items) => {
            (4u8, items.len()).hash(h);
            for item in items {
                hash_json(item, h);
            }
        }
        Value::Object(map) => {
            (5u8, map.len()).hash(h);
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            for (key, item) in entries {
                key.hash(h);
                hash_json(item, h);
            }
        }
    }
}

/// Write `data` to `path` atomically and owner-only.
///
/// Atomic: written to a sibling temp file and renamed over the target, so a
/// crash or power loss mid-write leaves either the old file or the new one —
/// never the truncated, half-written file `fs::write` could leave behind, which
/// for session.json meant being silently logged out.
///
/// Owner-only from the start: the temp file is created 0600, rather than
/// created with the umask's permissions and only then tightened.
fn write_secure(path: &PathBuf, data: &str) {
    let hash = content_hash(data);
    {
        let cache = LAST_WRITTEN.lock().unwrap();
        // Still re-written if the file has gone missing behind our back.
        if cache.as_ref().and_then(|c| c.get(path)) == Some(&hash) && path.exists() {
            return;
        }
    }

    // Unique per write: two writers of the same file (a token refresh saving
    // the session while a failed request clears it) must not share a temp
    // file, or one could rename the other's half-written bytes into place.
    let tmp = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let written = opts.open(&tmp).and_then(|mut f| {
        f.write_all(data.as_bytes())?;
        f.sync_all()
    });
    if let Err(e) = written.and_then(|()| fs::rename(&tmp, path)) {
        log::warn!("Failed to write {}: {e}", path.display());
        fs::remove_file(&tmp).ok();
        forget_written(path);
        return;
    }
    // A file that predates this (written by an older build) keeps whatever
    // mode it had; the rename replaced it with the 0600 temp file, but tighten
    // anyway in case the umask widened the create.
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).ok();
    LAST_WRITTEN
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(path.clone(), hash);
}

fn forget_written(path: &PathBuf) {
    if let Some(cache) = LAST_WRITTEN.lock().unwrap().as_mut() {
        cache.remove(path);
    }
}

/// Delete a file written by `write_secure`, keeping the write cache honest.
fn remove_secure(path: &PathBuf) {
    if path.exists() {
        fs::remove_file(path).ok();
    }
    forget_written(path);
}

/// Compute HMAC-SHA256 over cheat-sensitive fields, bound to the owning user_id.
/// An empty `owner` means legacy (pre-ownership) format — used during one-shot migration.
fn compute_signature(herzie: &Herzie, owner: &str) -> String {
    let payload = if owner.is_empty() {
        // Legacy format — kept around so we can verify and migrate pre-ownership files.
        serde_json::json!({
            "id": herzie.id,
            "xp": herzie.xp,
            "level": herzie.level,
            "stage": herzie.stage,
            "totalMinutesListened": herzie.total_minutes_listened,
            "genreMinutes": herzie.genre_minutes,
            "currency": herzie.currency,
        })
    } else {
        serde_json::json!({
            "id": herzie.id,
            "owner": owner,
            "xp": herzie.xp,
            "level": herzie.level,
            "stage": herzie.stage,
            "totalMinutesListened": herzie.total_minutes_listened,
            "genreMinutes": herzie.genre_minutes,
            "currency": herzie.currency,
        })
    };
    let payload_str = serde_json::to_string(&payload).unwrap();

    let key = format!("{}:{}", HMAC_SALT, herzie.id);
    let mut mac = HmacSha256::new_from_slice(key.as_bytes()).unwrap();
    mac.update(payload_str.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub struct LoadedHerzie {
    pub herzie: Herzie,
    /// Owning user_id. `None` if the file is in legacy (pre-ownership) format.
    pub owner: Option<String>,
}

pub fn load_herzie() -> Option<LoadedHerzie> {
    ensure_dir();
    let path = config_dir().join("herzie.json");
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let mut value: serde_json::Value = serde_json::from_str(&raw).ok()?;

    let sig = value.get("_sig").and_then(|v| v.as_str()).map(String::from);
    let owner_field = value
        .get("_owner")
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(obj) = value.as_object_mut() {
        obj.remove("_sig");
        obj.remove("_owner");
    }

    let mut herzie: Herzie = serde_json::from_value(value).ok()?;

    let (verified, owner) = match (&sig, &owner_field) {
        (Some(s), Some(o)) if s == &compute_signature(&herzie, o) => (true, Some(o.clone())),
        (Some(s), None) if s == &compute_signature(&herzie, "") => (true, None),
        _ => (false, owner_field),
    };

    if !verified {
        // Tampered or unsigned — reset progress.
        log::warn!(
            "herzie.json signature mismatch — resetting xp/level/stage to defaults (owner={:?})",
            owner
        );
        herzie.xp = 0.0;
        herzie.level = 1;
        herzie.stage = 1;
        herzie.total_minutes_listened = 0.0;
        herzie.genre_minutes = HashMap::new();
    }

    Some(LoadedHerzie { herzie, owner })
}

/// Save the herzie, binding it to the currently-logged-in user.
/// Skips if there is no session — a herzie without an owner can't be safely signed.
pub fn save_herzie(herzie: &Herzie) {
    let owner = match load_session() {
        Some(s) => s.user_id,
        None => {
            log::warn!("save_herzie called without an active session; skipping");
            return;
        }
    };
    save_herzie_with_owner(herzie, &owner);
}

pub fn save_herzie_with_owner(herzie: &Herzie, owner: &str) {
    ensure_dir();
    let path = config_dir().join("herzie.json");
    let mut value = serde_json::to_value(herzie).unwrap();
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "_owner".to_string(),
            serde_json::Value::String(owner.to_string()),
        );
        obj.insert(
            "_sig".to_string(),
            serde_json::Value::String(compute_signature(herzie, owner)),
        );
    }
    let data = serde_json::to_string_pretty(&value).unwrap();
    write_secure(&path, &data);
}

pub fn clear_herzie() {
    ensure_dir();
    let path = config_dir().join("herzie.json");
    remove_secure(&path);
}

/// The last parsed session.json, keyed on the file's modification time and
/// length. `load_session` runs several times per request and on every state
/// push (`is_logged_in`); this turns each of those from a read + JSON parse
/// into a single stat. Keyed on the file rather than updated by `save_session`
/// so a write from anywhere else is still picked up.
static SESSION_CACHE: Mutex<Option<(SystemTime, u64, Option<SessionData>)>> = Mutex::new(None);

pub fn load_session() -> Option<SessionData> {
    let path = config_dir().join("session.json");
    let Ok(meta) = fs::metadata(&path) else {
        *SESSION_CACHE.lock().unwrap() = None;
        return None;
    };
    let stamp = (meta.modified().ok()?, meta.len());
    if let Some((mtime, len, ref session)) = *SESSION_CACHE.lock().unwrap() {
        if (mtime, len) == stamp {
            return session.clone();
        }
    }
    let session = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<SessionData>(&raw).ok())
        .filter(|s| !s.access_token.is_empty() && !s.user_id.is_empty());
    *SESSION_CACHE.lock().unwrap() = Some((stamp.0, stamp.1, session.clone()));
    session
}

pub fn save_session(session: &SessionData) {
    ensure_dir();
    let path = config_dir().join("session.json");
    let data = serde_json::to_string_pretty(session).unwrap();
    write_secure(&path, &data);
}

pub fn clear_session() {
    ensure_dir();
    let path = config_dir().join("session.json");
    if path.exists() {
        write_secure(&path, "{}");
    }
}

pub fn load_multipliers() -> Option<Vec<ActiveMultiplier>> {
    let path = config_dir().join("multipliers.json");
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_multipliers(multipliers: &[ActiveMultiplier]) {
    ensure_dir();
    let path = config_dir().join("multipliers.json");
    let data = serde_json::to_string(multipliers).unwrap();
    write_secure(&path, &data);
}

pub fn load_equipped() -> HashMap<String, serde_json::Value> {
    let path = config_dir().join("equipped.json");
    if !path.exists() {
        return HashMap::new();
    }
    let raw = fs::read_to_string(&path).ok();
    let Some(r) = raw else {
        return HashMap::new();
    };
    // Accept object maps; discard legacy string arrays. Values are passed
    // through as-is (a plain string per single-value slot, or an array for
    // the unbounded "modifier" slot) rather than coerced to strings.
    match serde_json::from_str::<serde_json::Value>(&r) {
        Ok(serde_json::Value::Object(map)) => map.into_iter().collect(),
        _ => HashMap::new(),
    }
}

pub fn save_equipped(equipped: &HashMap<String, serde_json::Value>) {
    ensure_dir();
    let path = config_dir().join("equipped.json");
    let data = serde_json::to_string(equipped).unwrap();
    write_secure(&path, &data);
}

pub fn clear_equipped() {
    ensure_dir();
    let path = config_dir().join("equipped.json");
    remove_secure(&path);
}

pub fn load_inventory_cache() -> Option<(
    Inventory,
    u32,
    ItemUpgrades,
    Vec<crate::types::ItemUnit>,
    u32,
)> {
    let path = config_dir().join("inventory_cache.json");
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let file: InventoryCacheFile = serde_json::from_str(&raw).ok()?;
    Some((
        file.inventory,
        file.currency,
        file.item_upgrades,
        file.units,
        file.bank_expansions,
    ))
}

pub fn save_inventory_cache(
    inventory: &Inventory,
    currency: u32,
    item_upgrades: &ItemUpgrades,
    units: &[crate::types::ItemUnit],
    bank_expansions: u32,
) {
    ensure_dir();
    let path = config_dir().join("inventory_cache.json");
    let file = InventoryCacheFile {
        inventory: inventory.clone(),
        currency,
        item_upgrades: item_upgrades.clone(),
        units: units.to_vec(),
        bank_expansions,
    };
    let data = serde_json::to_string(&file).unwrap();
    write_secure(&path, &data);
}

pub fn clear_inventory_cache() {
    ensure_dir();
    let path = config_dir().join("inventory_cache.json");
    remove_secure(&path);
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    /// Pinned unless the user has explicitly unpinned — a missing settings
    /// file or key means pinned.
    #[serde(default = "default_pin_window")]
    pin_window: bool,
}

fn default_pin_window() -> bool {
    true
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            pin_window: default_pin_window(),
        }
    }
}

fn load_settings() -> SettingsFile {
    let path = config_dir().join("settings.json");
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_settings(settings: &SettingsFile) {
    ensure_dir();
    let path = config_dir().join("settings.json");
    let data = serde_json::to_string_pretty(settings).unwrap();
    write_secure(&path, &data);
}

pub fn load_pin_window() -> bool {
    load_settings().pin_window
}

pub fn save_pin_window(pinned: bool) {
    let mut settings = load_settings();
    settings.pin_window = pinned;
    save_settings(&settings);
}

pub fn load_friends_cache(current_codes: &[String]) -> HashMap<String, HerzieProfile> {
    let path = config_dir().join("friends_cache.json");
    if !path.exists() {
        return HashMap::new();
    }
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };
    let file: FriendsCacheFile = match serde_json::from_str(&raw) {
        Ok(f) => f,
        Err(_) => return HashMap::new(),
    };
    if file.friend_codes != current_codes {
        return HashMap::new();
    }
    file.profiles
}

pub fn save_friends_cache(friend_codes: &[String], profiles: &HashMap<String, HerzieProfile>) {
    ensure_dir();
    let path = config_dir().join("friends_cache.json");
    let file = FriendsCacheFile {
        friend_codes: friend_codes.to_vec(),
        profiles: profiles.clone(),
    };
    let data = serde_json::to_string(&file).unwrap();
    write_secure(&path, &data);
}

pub fn clear_friends_cache() {
    ensure_dir();
    let path = config_dir().join("friends_cache.json");
    remove_secure(&path);
}

/// Minutes of listening time accrued locally but not yet confirmed by `/sync`.
/// This is an estimate cache, not a source of truth — the server always
/// recomputes XP authoritatively from minutes it receives — so it's
/// deliberately not HMAC-signed like `herzie.json`. Persisting it means a
/// relaunch (app update or otherwise) doesn't silently drop unsynced
/// listening time; a missing or corrupt file is treated as `0.0` rather than
/// an error, since losing a few minutes of estimate is far better than
/// failing startup.
pub fn load_pending_minutes() -> f64 {
    let path = config_dir().join("pending_minutes.json");
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<f64>(&raw).ok())
        .unwrap_or(0.0)
}

pub fn save_pending_minutes(minutes: f64) {
    ensure_dir();
    let path = config_dir().join("pending_minutes.json");
    let data = serde_json::to_string(&minutes).unwrap();
    write_secure(&path, &data);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_ignores_map_order_but_not_content() {
        let mut a = HashMap::new();
        let mut b = HashMap::new();
        for (k, v) in [
            ("cd", 1u32),
            ("boombox", 2),
            ("headphones", 3),
            ("vinyl", 4),
        ] {
            a.insert(k.to_string(), v);
        }
        for (k, v) in [
            ("vinyl", 4u32),
            ("headphones", 3),
            ("boombox", 2),
            ("cd", 1),
        ] {
            b.insert(k.to_string(), v);
        }
        let ja =
            serde_json::to_string(&serde_json::json!({ "inventory": a, "currency": 5 })).unwrap();
        let jb =
            serde_json::to_string(&serde_json::json!({ "currency": 5, "inventory": b })).unwrap();
        assert_eq!(content_hash(&ja), content_hash(&jb));
        // Hand-built so the key order genuinely differs in the text.
        assert_eq!(
            content_hash(r#"{"a":1,"b":{"x":[1,2],"y":null}}"#),
            content_hash(r#"{"b":{"y":null,"x":[1,2]},"a":1}"#)
        );
        assert_ne!(content_hash(r#"{"a":1}"#), content_hash(r#"{"a":2}"#));
        assert_ne!(content_hash(r#"[1,2]"#), content_hash(r#"[2,1]"#));
    }
    use std::sync::Mutex;

    // These tests touch the real `~/.config/herzies/pending_minutes.json` (the
    // module has no config-dir injection point), so they run serially via a
    // shared lock to avoid clobbering each other, and always restore whatever
    // was on disk beforehand.
    static PENDING_MINUTES_TEST_LOCK: Mutex<()> = Mutex::new(());

    // Pure serde — no disk — so unlike the tests below these can't touch a
    // player's real cache.
    #[test]
    fn an_inventory_cache_written_before_copies_existed_still_loads() {
        let old = r#"{"inventory":{"cd":3},"currency":10,"itemUpgrades":{"boombox":1}}"#;
        let file: InventoryCacheFile = serde_json::from_str(old).unwrap();
        assert_eq!(file.inventory["cd"], 3);
        assert_eq!(file.currency, 10);
        // No copies yet; the next sync fills them in.
        assert!(file.units.is_empty());
        // Nor any expansions: the grid opens at the starting 18 until told more.
        assert_eq!(file.bank_expansions, 0);
    }

    #[test]
    fn the_inventory_cache_round_trips_its_units() {
        let file = InventoryCacheFile {
            inventory: Inventory::from([("boombox".to_string(), 1)]),
            currency: 5,
            item_upgrades: ItemUpgrades::new(),
            units: vec![crate::types::ItemUnit {
                id: "u1".to_string(),
                item_id: "boombox".to_string(),
                upgrade_level: 3,
                equipped_slot: Some("ground_left".to_string()),
            }],
            bank_expansions: 2,
        };
        let back: InventoryCacheFile =
            serde_json::from_str(&serde_json::to_string(&file).unwrap()).unwrap();
        assert_eq!(back.units, file.units);
        assert_eq!(back.bank_expansions, 2);
    }

    #[test]
    fn pending_minutes_round_trips() {
        let _guard = PENDING_MINUTES_TEST_LOCK.lock().unwrap();
        let path = config_dir().join("pending_minutes.json");
        let previous = fs::read_to_string(&path).ok();

        save_pending_minutes(4.5);
        assert_eq!(load_pending_minutes(), 4.5);

        match previous {
            Some(raw) => write_secure(&path, &raw),
            None => {
                fs::remove_file(&path).ok();
            }
        }
    }

    #[test]
    fn pending_minutes_missing_or_corrupt_file_yields_zero() {
        let _guard = PENDING_MINUTES_TEST_LOCK.lock().unwrap();
        let path = config_dir().join("pending_minutes.json");
        let previous = fs::read_to_string(&path).ok();

        fs::remove_file(&path).ok();
        assert_eq!(load_pending_minutes(), 0.0);

        ensure_dir();
        write_secure(&path, "not valid json");
        assert_eq!(load_pending_minutes(), 0.0);

        match previous {
            Some(raw) => write_secure(&path, &raw),
            None => {
                fs::remove_file(&path).ok();
            }
        }
    }
}
