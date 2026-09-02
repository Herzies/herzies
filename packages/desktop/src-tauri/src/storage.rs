use crate::types::{ActiveMultiplier, Herzie, HerzieProfile, SessionData};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashMap;

pub type Inventory = HashMap<String, u32>;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryCacheFile {
    inventory: Inventory,
    currency: u32,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FriendsCacheFile {
    friend_codes: Vec<String>,
    profiles: HashMap<String, HerzieProfile>,
}
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

type HmacSha256 = Hmac<Sha256>;

const HMAC_SALT: &str = "hrzs_v1_8f3a2c";

fn config_dir() -> PathBuf {
    dirs::home_dir()
        .expect("No home directory")
        .join(".config")
        .join("herzies")
}

fn ensure_dir() {
    let dir = config_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).ok();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).ok();
    }
}

fn write_secure(path: &PathBuf, data: &str) {
    fs::write(path, data).ok();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).ok();
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
    if path.exists() {
        fs::remove_file(&path).ok();
    }
}

pub fn load_session() -> Option<SessionData> {
    ensure_dir();
    let path = config_dir().join("session.json");
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let session: SessionData = serde_json::from_str(&raw).ok()?;
    if session.access_token.is_empty() || session.user_id.is_empty() {
        return None;
    }
    Some(session)
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

pub fn load_equipped() -> HashMap<String, String> {
    let path = config_dir().join("equipped.json");
    if !path.exists() {
        return HashMap::new();
    }
    let raw = fs::read_to_string(&path).ok();
    let Some(r) = raw else {
        return HashMap::new();
    };
    // Accept object maps; discard legacy string arrays.
    match serde_json::from_str::<serde_json::Value>(&r) {
        Ok(serde_json::Value::Object(map)) => map
            .into_iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
            .collect(),
        _ => HashMap::new(),
    }
}

pub fn save_equipped(equipped: &HashMap<String, String>) {
    ensure_dir();
    let path = config_dir().join("equipped.json");
    let data = serde_json::to_string(equipped).unwrap();
    write_secure(&path, &data);
}

pub fn clear_equipped() {
    ensure_dir();
    let path = config_dir().join("equipped.json");
    if path.exists() {
        fs::remove_file(&path).ok();
    }
}

pub fn load_inventory_cache() -> Option<(Inventory, u32)> {
    let path = config_dir().join("inventory_cache.json");
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let file: InventoryCacheFile = serde_json::from_str(&raw).ok()?;
    Some((file.inventory, file.currency))
}

pub fn save_inventory_cache(inventory: &Inventory, currency: u32) {
    ensure_dir();
    let path = config_dir().join("inventory_cache.json");
    let file = InventoryCacheFile {
        inventory: inventory.clone(),
        currency,
    };
    let data = serde_json::to_string(&file).unwrap();
    write_secure(&path, &data);
}

pub fn clear_inventory_cache() {
    ensure_dir();
    let path = config_dir().join("inventory_cache.json");
    if path.exists() {
        fs::remove_file(&path).ok();
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    #[serde(default)]
    pin_window: bool,
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
    if path.exists() {
        fs::remove_file(&path).ok();
    }
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
    use std::sync::Mutex;

    // These tests touch the real `~/.config/herzies/pending_minutes.json` (the
    // module has no config-dir injection point), so they run serially via a
    // shared lock to avoid clobbering each other, and always restore whatever
    // was on disk beforehand.
    static PENDING_MINUTES_TEST_LOCK: Mutex<()> = Mutex::new(());

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
