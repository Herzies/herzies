use crate::types::ActiveMultiplier;

const GENRES: &[&str] = &[
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

const BASE_XP_PER_MINUTE: f64 = 10.0;

pub fn xp_for_level(level: u32) -> f64 {
    (100.0 * (level as f64).powf(1.5)).floor()
}

pub fn total_xp_for_level(level: u32) -> f64 {
    let mut total = 0.0;
    for i in 2..=level {
        total += xp_for_level(i);
    }
    total
}

pub fn stage_for_level(level: u32) -> u32 {
    if level >= 25 {
        3
    } else if level >= 10 {
        2
    } else {
        1
    }
}

pub fn calculate_xp_gain(minutes: f64, multipliers: &[ActiveMultiplier]) -> f64 {
    let mut xp = minutes * BASE_XP_PER_MINUTE;
    if !multipliers.is_empty() {
        let total_bonus: f64 = multipliers.iter().map(|m| m.bonus).sum();
        xp *= 1.0 + total_bonus;
    }
    xp
}

/// How many minutes a `/sync` round-trip actually credited, derived from the
/// real `total_minutes_listened` delta the server returned — never assume
/// the full amount sent was billed. The server's own caps (elapsed-wall-clock
/// limit, per-sync cooldown) can credit less than that, including zero, and
/// treating "sent" as "credited" silently discards the shortfall forever
/// instead of leaving it in `pending_minutes` to retry on the next sync.
pub fn minutes_credited(previous_total_minutes: f64, server_total_minutes: f64) -> f64 {
    (server_total_minutes - previous_total_minutes).max(0.0)
}

fn roll_over_levels(xp: f64, level: &mut u32, stage: &mut u32) {
    while xp >= total_xp_for_level(*level + 1) {
        *level += 1;
        *stage = stage_for_level(*level);
    }
}

/// Pure projection for optimistic display only: given the last server-confirmed
/// xp/level/stage and an estimated additional gain from not-yet-synced listening
/// time, returns the projected xp/level/stage. Fires no notifications — the
/// server remains the sole source of truth and the sole writer of confirmed
/// xp/level/stage, applied when a `/sync` confirms it (see `sync_tick` in
/// `lib.rs` and `ManagedState::display_herzie` in `state.rs`).
pub fn project_xp(xp: f64, level: u32, stage: u32, xp_gain: f64) -> (f64, u32, u32) {
    let mut level = level;
    let mut stage = stage;
    let projected_xp = xp + xp_gain;
    roll_over_levels(projected_xp, &mut level, &mut stage);
    (projected_xp, level, stage)
}

pub fn classify_genre(spotify_genres: &[String]) -> Vec<String> {
    let mut matched = std::collections::HashSet::new();

    for raw in spotify_genres {
        let lower = raw.to_lowercase();

        for &genre in GENRES {
            if lower.contains(genre) || genre.contains(&*lower) {
                matched.insert(genre.to_string());
            }
        }

        if lower.contains("rap") || lower.contains("trap") || lower.contains("drill") {
            matched.insert("hip-hop".to_string());
        }
        if lower.contains("edm")
            || lower.contains("house")
            || lower.contains("techno")
            || lower.contains("dubstep")
        {
            matched.insert("electronic".to_string());
        }
        if lower.contains("alt") || lower.contains("shoegaze") || lower.contains("dream pop") {
            matched.insert("indie".to_string());
        }
        if lower.contains("hardcore") || lower.contains("death") || lower.contains("thrash") {
            matched.insert("metal".to_string());
        }
        if lower.contains("reggaeton") || lower.contains("salsa") || lower.contains("bachata") {
            matched.insert("latin".to_string());
        }
        if lower.contains("rhythm") || lower.contains("rnb") {
            matched.insert("r&b".to_string());
        }
    }

    if matched.is_empty() {
        vec!["pop".to_string()]
    } else {
        matched.into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xp_for_level() {
        assert_eq!(xp_for_level(2), 282.0);
        assert_eq!(xp_for_level(1), 100.0);
        assert_eq!(xp_for_level(10), 3162.0);
    }

    #[test]
    fn test_stage_for_level() {
        assert_eq!(stage_for_level(1), 1);
        assert_eq!(stage_for_level(9), 1);
        assert_eq!(stage_for_level(10), 2);
        assert_eq!(stage_for_level(24), 2);
        assert_eq!(stage_for_level(25), 3);
        assert_eq!(stage_for_level(100), 3);
    }

    #[test]
    fn test_classify_genre_default() {
        let result = classify_genre(&["unknown-genre".to_string()]);
        assert_eq!(result, vec!["pop"]);
    }

    #[test]
    fn test_classify_genre_rock() {
        let result = classify_genre(&["Rock".to_string()]);
        assert!(result.contains(&"rock".to_string()));
    }

    #[test]
    fn test_calculate_xp_basic() {
        let xp = calculate_xp_gain(1.0, &[]);
        assert!((xp - 10.0).abs() < 0.001);
    }

    #[test]
    fn test_minutes_credited_full_amount() {
        assert_eq!(minutes_credited(100.0, 105.0), 5.0);
    }

    #[test]
    fn test_minutes_credited_throttled_to_zero() {
        // The server's cooldown/elapsed-wall-clock cap can credit nothing for
        // a sync even though minutes were sent — must be reported as 0, not
        // negative, so pending_minutes isn't incorrectly bumped up.
        assert_eq!(minutes_credited(100.0, 100.0), 0.0);
    }

    #[test]
    fn test_minutes_credited_never_negative() {
        // Defensive: a stale/out-of-order response should never look like a
        // negative credit.
        assert_eq!(minutes_credited(100.0, 99.0), 0.0);
    }

    #[test]
    fn test_project_xp_no_gain_is_unchanged() {
        let (xp, level, stage) = project_xp(500.0, 3, 1, 0.0);
        assert_eq!(xp, 500.0);
        assert_eq!(level, 3);
        assert_eq!(stage, 1);
    }

    #[test]
    fn test_project_xp_rolls_over_a_single_level() {
        // Exactly enough xp to cross into the next level should bump level by
        // one and re-derive stage from the leveling curve, same as the old
        // apply_xp mutator did.
        let start_level = 3;
        let gain_to_next = total_xp_for_level(start_level + 1) + 1.0;
        let (xp, level, stage) =
            project_xp(0.0, start_level, stage_for_level(start_level), gain_to_next);
        assert_eq!(level, start_level + 1);
        assert_eq!(stage, stage_for_level(start_level + 1));
        assert!(xp >= total_xp_for_level(level));
    }

    #[test]
    fn test_project_xp_multi_level_rollover() {
        // Simulate an app closed for days: a single large one-shot gain should
        // roll over several levels without panicking or looping pathologically.
        let (xp, level, stage) = project_xp(0.0, 1, 1, 50_000.0);
        assert!(level > 10);
        assert_eq!(stage, stage_for_level(level));
        assert!(xp >= total_xp_for_level(level));
        assert!(xp < total_xp_for_level(level + 1));
    }

    #[test]
    fn test_project_xp_does_not_mutate_inputs() {
        // project_xp is a pure projection — verify it doesn't require a Herzie
        // at all and leaves no persisted state to roll back.
        let (xp, level, _stage) = project_xp(100.0, 2, 1, 0.0);
        assert_eq!(xp, 100.0);
        assert_eq!(level, 2);
    }
}
