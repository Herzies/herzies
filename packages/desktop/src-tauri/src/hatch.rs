use crate::types::{Herzie, HerzieAppearance};
use rand::Rng;
use std::collections::HashMap;

const COLOR_SCHEMES: [&str; 8] = [
    "pink", "blue", "green", "purple", "orange", "yellow", "cyan", "red",
];

const FRIEND_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub fn generate_appearance() -> HerzieAppearance {
    let mut rng = rand::thread_rng();
    HerzieAppearance {
        head_index: rng.gen_range(0..4),
        eyes_index: rng.gen_range(0..6),
        mouth_index: rng.gen_range(0..5),
        accessory_index: rng.gen_range(0..6),
        limbs_index: rng.gen_range(0..4),
        body_index: rng.gen_range(0..4),
        legs_index: rng.gen_range(0..4),
        color_scheme: COLOR_SCHEMES[rng.gen_range(0..COLOR_SCHEMES.len())].to_string(),
    }
}

pub fn generate_friend_code() -> String {
    let mut rng = rand::thread_rng();
    let mut code = String::from("HERZ-");
    for _ in 0..4 {
        let idx = rng.gen_range(0..FRIEND_CODE_ALPHABET.len());
        code.push(FRIEND_CODE_ALPHABET[idx] as char);
    }
    code
}

pub fn new_herzie(name: String) -> Herzie {
    Herzie {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        created_at: chrono_now_iso(),
        appearance: generate_appearance(),
        xp: 0.0,
        level: 1,
        stage: 1,
        total_minutes_listened: 0.0,
        genre_minutes: HashMap::new(),
        friend_code: generate_friend_code(),
        friend_codes: Vec::new(),
        last_craving_date: String::new(),
        last_craving_genre: String::new(),
        boost_until: None,
        streak_days: 0,
        streak_last_date: None,
        currency: 0,
        share_listening: true,
    }
}

/// ISO-8601 timestamp without pulling in chrono — uses SystemTime + formatted output.
fn chrono_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();

    // Compute UTC components from epoch seconds (no leap-second handling — fine for createdAt).
    let days = (secs / 86_400) as i64;
    let mut sod = secs % 86_400;
    let hour = sod / 3600;
    sod %= 3600;
    let min = sod / 60;
    let sec = sod % 60;

    let (y, mo, d) = days_to_ymd(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, mo, d, hour, min, sec, millis
    )
}

fn days_to_ymd(days_since_epoch: i64) -> (i32, u32, u32) {
    // Algorithm from Howard Hinnant: days from 1970-01-01 -> civil date.
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}
