//! Picking up a ground drop, optimistically.
//!
//! The pickup shows at once: the drop leaves the ground and its copy is in the
//! bag before the server's said anything. The server answers later, and in
//! the meantime `/sync` (or any other call that hands back the inventory) can
//! land with a snapshot taken either side of the pickup. So rather than
//! patching the state once and hand-reverting it later (which double-counted
//! whenever a snapshot landed in between), each pickup is kept in a ledger
//! until a snapshot shows it, and re-applied over every snapshot that doesn't:
//! what's shown is always the server's state plus the pickups it hasn't seen.
//!
//! The marker is the copy: the server mints it under the drop's own id
//! (`collect_pending_drop`), so a snapshot has seen the pickup exactly when its
//! units hold that id.

use crate::state::ManagedState;
use crate::types::{ItemUnit, PendingDrop};
use std::time::{Duration, Instant};

/// How long a confirmed pickup is kept waiting for a snapshot that shows it
/// (one without units, from an old server, never will).
const CONFIRMED_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct PendingCollect {
    pub drop: PendingDrop,
    /// When the server said yes. `None` while the call's still out.
    pub confirmed_at: Option<Instant>,
    /// Whether the bag's count holds this pickup on our own say-so (the
    /// snapshot it sits on doesn't have it yet). Only then is there anything
    /// to take back.
    pub applied: bool,
}

/// What the server made of a pickup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollectOutcome {
    /// In the bag.
    Collected,
    /// Not on the ground any more: taken some other way (the server's own
    /// spirit, during a sync), or gone.
    Gone,
    /// No room for it: it stays on the ground.
    BagFull,
}

impl CollectOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            CollectOutcome::Collected => "collected",
            CollectOutcome::Gone => "gone",
            CollectOutcome::BagFull => "bag-full",
        }
    }
}

/// Which parts of the state a snapshot just replaced.
#[derive(Debug, Clone, Copy, Default)]
pub struct Replaced {
    pub inventory: bool,
    pub units: bool,
    pub pending_drops: bool,
}

impl ManagedState {
    /// Takes `drop_id` off the ground and into the bag, now. False if it isn't
    /// on the ground (as far as we know) or is already being picked up.
    pub fn begin_collect(&mut self, drop_id: &str) -> bool {
        if self.collects.contains_key(drop_id) {
            return false;
        }
        let Some(i) = self.pending_drops.iter().position(|d| d.id == drop_id) else {
            return false;
        };
        let drop = self.pending_drops.remove(i);
        let applied = self.inventory.is_some();
        if let Some(inv) = self.inventory.as_mut() {
            *inv.entry(drop.item_id.clone()).or_insert(0) += 1;
        }
        add_unit(&mut self.units, &drop);
        self.collects.insert(
            drop_id.to_string(),
            PendingCollect {
                drop,
                confirmed_at: None,
                applied,
            },
        );
        true
    }

    /// The server said yes. Kept until a snapshot shows it.
    pub fn confirm_collect(&mut self, drop_id: &str) {
        if let Some(c) = self.collects.get_mut(drop_id) {
            c.confirmed_at = Some(Instant::now());
        }
    }

    /// The server said no (or the call failed): back on the ground, out of
    /// the bag — as far as we put it there. With `still_there` false (the
    /// server says it's gone) it isn't put back on the ground: the next
    /// snapshot says where it went.
    pub fn undo_collect(&mut self, drop_id: &str, still_there: bool) {
        let Some(c) = self.collects.remove(drop_id) else {
            return;
        };
        if !c.applied {
            // A snapshot already shows the copy in the bag: nothing of ours
            // to take back.
            return;
        }
        if !still_there {
            // Most likely the server's spirit took it during a sync, and it's
            // in the bag; else it's gone. Either way the ground's already
            // right, and the next snapshot settles the bag.
            return;
        }
        if let Some(inv) = self.inventory.as_mut() {
            if let Some(qty) = inv.get_mut(&c.drop.item_id) {
                *qty = qty.saturating_sub(1);
                if *qty == 0 {
                    inv.remove(&c.drop.item_id);
                }
            }
        }
        self.units.retain(|u| u.id != c.drop.id);
        if !self.pending_drops.iter().any(|d| d.id == c.drop.id) {
            self.pending_drops.push(c.drop);
        }
    }

    /// Call after a server snapshot overwrote the parts in `replaced`:
    /// re-applies every pickup it hasn't seen. `snapshot_units` is the
    /// snapshot's own list of copies (whether or not it was applied), the
    /// only way to tell what it has seen; `None` if it carried none.
    pub fn rebase_collects(&mut self, replaced: Replaced, snapshot_units: Option<&[ItemUnit]>) {
        if self.collects.is_empty() {
            return;
        }
        let now = Instant::now();
        let mut settled = Vec::new();
        for (id, c) in self.collects.iter_mut() {
            let seen = match snapshot_units {
                Some(units) => units.iter().any(|u| &u.id == id),
                // No copies to go by: a confirmed pickup is taken as seen.
                None => c.confirmed_at.is_some(),
            };
            if seen {
                if replaced.inventory {
                    c.applied = false;
                }
                if c.confirmed_at.is_some() {
                    settled.push(id.clone());
                }
            } else {
                if replaced.inventory {
                    if let Some(inv) = self.inventory.as_mut() {
                        *inv.entry(c.drop.item_id.clone()).or_insert(0) += 1;
                        c.applied = true;
                    }
                }
                if replaced.units {
                    add_unit(&mut self.units, &c.drop);
                }
                if c.confirmed_at
                    .is_some_and(|at| now.duration_since(at) > CONFIRMED_TTL)
                {
                    settled.push(id.clone());
                }
            }
            // Never back on the ground while it's being (or been) picked up.
            if replaced.pending_drops {
                self.pending_drops.retain(|d| &d.id != id);
            }
        }
        for id in settled {
            self.collects.remove(&id);
        }
    }
}

fn add_unit(units: &mut Vec<ItemUnit>, drop: &PendingDrop) {
    if units.iter().any(|u| u.id == drop.id) {
        return;
    }
    units.push(ItemUnit {
        id: drop.id.clone(),
        item_id: drop.item_id.clone(),
        upgrade_level: 0,
        equipped_slot: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn drop(id: &str, item: &str) -> PendingDrop {
        PendingDrop {
            id: id.into(),
            item_id: item.into(),
            dropped_at: "2026-11-05T00:00:00Z".into(),
        }
    }

    fn unit(id: &str, item: &str) -> ItemUnit {
        ItemUnit {
            id: id.into(),
            item_id: item.into(),
            upgrade_level: 0,
            equipped_slot: None,
        }
    }

    /// A bag with one hat in it, and a pearl necklace on the ground.
    fn state() -> ManagedState {
        let mut s = ManagedState::new(None);
        s.inventory = Some(HashMap::from([("hat".to_string(), 1)]));
        s.units = vec![unit("u-hat", "hat")];
        s.pending_drops = vec![drop("d1", "pearl")];
        s
    }

    fn qty(s: &ManagedState, item: &str) -> u32 {
        s.inventory
            .as_ref()
            .unwrap()
            .get(item)
            .copied()
            .unwrap_or(0)
    }

    /// The server's state, as a sync would hand it over.
    fn sync(
        s: &mut ManagedState,
        inv: &[(&str, u32)],
        units: Vec<ItemUnit>,
        ground: Vec<PendingDrop>,
    ) {
        s.inventory = Some(inv.iter().map(|(k, v)| (k.to_string(), *v)).collect());
        s.units = units.clone();
        s.pending_drops = ground;
        s.rebase_collects(
            Replaced {
                inventory: true,
                units: true,
                pending_drops: true,
            },
            Some(&units),
        );
    }

    #[test]
    fn picked_up_at_once() {
        let mut s = state();
        assert!(s.begin_collect("d1"));
        assert_eq!(qty(&s, "pearl"), 1);
        assert!(s.pending_drops.is_empty());
        assert!(s.units.iter().any(|u| u.id == "d1"));
        // Not twice.
        assert!(!s.begin_collect("d1"));
    }

    #[test]
    fn a_sync_from_before_the_pickup_does_not_undo_it() {
        let mut s = state();
        s.begin_collect("d1");
        sync(
            &mut s,
            &[("hat", 1)],
            vec![unit("u-hat", "hat")],
            vec![drop("d1", "pearl")],
        );
        assert_eq!(qty(&s, "pearl"), 1);
        assert!(s.pending_drops.is_empty());
        assert!(s.units.iter().any(|u| u.id == "d1"));
    }

    /// The loop that was: a sync between the pickup and the server's "no
    /// room" left the bag a slot short, so the spirit went again, and again.
    #[test]
    fn refused_after_a_sync_comes_out_exactly_once() {
        let mut s = state();
        s.begin_collect("d1");
        sync(
            &mut s,
            &[("hat", 1)],
            vec![unit("u-hat", "hat")],
            vec![drop("d1", "pearl")],
        );
        s.undo_collect("d1", true);
        assert_eq!(qty(&s, "pearl"), 0);
        assert_eq!(qty(&s, "hat"), 1);
        assert_eq!(s.pending_drops.len(), 1);
        assert!(!s.units.iter().any(|u| u.id == "d1"));
        assert!(s.collects.is_empty());
    }

    #[test]
    fn refused_with_no_sync_between() {
        let mut s = state();
        s.begin_collect("d1");
        s.undo_collect("d1", true);
        assert_eq!(qty(&s, "pearl"), 0);
        assert_eq!(s.pending_drops.len(), 1);
    }

    #[test]
    fn gone_is_not_put_back_on_the_ground() {
        let mut s = state();
        s.begin_collect("d1");
        s.undo_collect("d1", false);
        assert!(s.pending_drops.is_empty());
        assert!(s.collects.is_empty());
    }

    /// The server's spirit took it during a sync while our call was out: the
    /// sync shows it in the bag, and the "gone" that follows takes nothing.
    #[test]
    fn taken_by_the_server_meanwhile_stays_in_the_bag() {
        let mut s = state();
        s.begin_collect("d1");
        sync(
            &mut s,
            &[("hat", 1), ("pearl", 1)],
            vec![unit("u-hat", "hat"), unit("d1", "pearl")],
            vec![],
        );
        assert_eq!(qty(&s, "pearl"), 1);
        s.undo_collect("d1", true);
        assert_eq!(qty(&s, "pearl"), 1);
        assert!(s.pending_drops.is_empty());
    }

    #[test]
    fn confirmed_is_kept_until_a_sync_shows_it() {
        let mut s = state();
        s.begin_collect("d1");
        s.confirm_collect("d1");
        // A sync sent before the server got to it: still shown.
        sync(
            &mut s,
            &[("hat", 1)],
            vec![unit("u-hat", "hat")],
            vec![drop("d1", "pearl")],
        );
        assert_eq!(qty(&s, "pearl"), 1);
        assert!(s.pending_drops.is_empty());
        assert_eq!(s.collects.len(), 1);
        // One that has it: settled.
        sync(
            &mut s,
            &[("hat", 1), ("pearl", 1)],
            vec![unit("u-hat", "hat"), unit("d1", "pearl")],
            vec![],
        );
        assert_eq!(qty(&s, "pearl"), 1);
        assert!(s.collects.is_empty());
    }

    #[test]
    fn only_what_a_snapshot_replaced_is_reapplied() {
        let mut s = state();
        s.begin_collect("d1");
        // Inventory skipped (another change raced it); only the ground came.
        s.pending_drops = vec![drop("d1", "pearl")];
        s.rebase_collects(
            Replaced {
                pending_drops: true,
                ..Default::default()
            },
            Some(&[unit("u-hat", "hat")]),
        );
        assert_eq!(qty(&s, "pearl"), 1);
        assert!(s.pending_drops.is_empty());
    }
}
