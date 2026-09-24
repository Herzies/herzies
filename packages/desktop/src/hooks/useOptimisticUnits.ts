import {
  applyEquip,
  type Equipped,
  type EquipRejection,
  type GroundSide,
  getItem,
  type ItemUnit,
  normalizeEquipped,
  normalizeUnits,
  unitsToEquipped,
  unitsToInventory,
} from "@herzies/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { herzies } from "../tauri-bridge";

/**
 * Ceiling on how long a prediction may outlive the server *while a change is
 * still in flight*. Only reached when a request never settles; on the normal
 * path the prediction is retired as soon as the server's state matches it.
 */
const RECONCILE_TIMEOUT_MS = 6000;

/**
 * Once nothing is in flight the server is authoritative again, so a prediction
 * it disagrees with only deserves the time it takes a trailing `state-update`
 * to arrive — the command's response and that event have no guaranteed IPC
 * order, and this covers the gap. Anything longer would show a stale value for
 * a divergence we already know about (a change from another device, a drop the
 * Greedy Spirit collected meanwhile) and then snap, which is worse than the lag
 * the optimistic layer replaced.
 */
const SETTLE_GRACE_MS = 400;

/** User-facing text for the reasons applyEquip can refuse a toggle locally. */
const REJECTION_MESSAGES: Record<EquipRejection, string> = {
  "not-owned": "Not in your inventory",
  "already-equipped": "Already equipped",
  "not-equipped": "Not equipped",
  "max-modifiers": "No modifier slots left",
  "missing-side": "No free ground slot",
  "no-slot": "This item can't be placed",
};

export type ToggleEquipResult =
  | { ok: true; action: "equip" | "unequip" }
  | {
      ok: false;
      action: "equip" | "unequip";
      error: string;
      /** False when the toggle was refused against local state and so never
       * reached the server: nothing moved, here or there. After a failed
       * *request* instead, dropping the overlay restores the previous state. */
      sent: boolean;
    };

/** What the UI reads: the copies, and the id-keyed `equipped` the creature is
 * drawn from. Kept together because they must never disagree for a frame. */
interface OwnedState {
  units: ItemUnit[];
  equipped: Equipped;
}

/**
 * The `equipped` a set of copies implies, with the modifier list keeping the
 * order the player equipped in. The copies alone can't say that order (they
 * arrive oldest-acquired first), and DeckRow renders modifiers positionally, so
 * a plain derivation would shuffle the deck on every prediction: anything
 * already in the list keeps its place, and anything new goes on the end.
 */
function deriveEquipped(units: ItemUnit[], previous: Equipped): Equipped {
  const derived = unitsToEquipped(units);
  const modifiers = derived.modifier;
  if (!modifiers) return derived;
  const kept = (previous.modifier ?? []).filter((id) => modifiers.includes(id));
  const added = modifiers.filter((id) => !kept.includes(id));
  return { ...derived, modifier: [...kept, ...added] };
}

/** A copy's place in the world, for comparing two lists of copies. */
function unitsKey(units: ItemUnit[]): string {
  return JSON.stringify(
    units
      .map((u) => [u.id, u.upgradeLevel, u.equippedSlot])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

/**
 * Deep equality for Equipped. `normalizeEquipped` walks EQUIPPED_SLOTS in a
 * fixed order and appends `modifier` last, so two normalized values with the
 * same content always serialize identically — which makes stringify a
 * legitimate comparison here, and one that stays sensitive to modifier *order*,
 * since DeckRow renders modifiers positionally.
 */
function sameEquipped(a: Equipped, b: Equipped): boolean {
  return (
    JSON.stringify(normalizeEquipped(a)) ===
    JSON.stringify(normalizeEquipped(b))
  );
}

function sameOwned(a: OwnedState, b: OwnedState): boolean {
  return (
    sameEquipped(a.equipped, b.equipped) &&
    unitsKey(a.units) === unitsKey(b.units)
  );
}

/** Ground items pick a side at equip time; prefer a free one, else replace left. */
function pickGroundSide(equipped: Equipped): GroundSide {
  if (!equipped.ground_left) return "left";
  if (!equipped.ground_right) return "right";
  return "left";
}

/**
 * Optimistic changes to what the player owns: equipping and unequipping a copy,
 * and — via `predict` — the sells and dice upgrades InventoryView performs.
 *
 * Each of those used to wait a full server round-trip before anything moved,
 * which read as lag on every click. This predicts the result locally and shows
 * it at once, using the same pure functions the server's rules are written as
 * (`applyEquip`, `applySell`, `applyItemUpgrade` in @herzies/shared) — so the
 * prediction *is* the server's answer rather than an approximation of it, and
 * the real response lands as a no-op instead of a visible correction.
 *
 * Three things make it glitch-free, and all three are load-bearing:
 *
 *  1. **The prediction outranks incoming snapshots.** `state-update` fires
 *     every few seconds carrying the server's state; a snapshot issued before
 *     our mutation committed would otherwise revert the UI mid-flight.
 *  2. **It's retired by content, not by timing.** The overlay is dropped only
 *     once the server's own state matches it, so there is no instant where we
 *     swap prediction for truth and risk a frame of the old value. Clearing on
 *     promise-resolve instead would race the `state-update` carrying the new
 *     value — their IPC ordering isn't guaranteed.
 *  3. **Predictions compose, and survive until the last one settles.** Each
 *     change builds on the current prediction rather than the last snapshot,
 *     so two quick clicks don't have the second discard the first; and the
 *     overlay is held while anything is still in flight, so an equip-then-
 *     unequip pair can't briefly flash the equipped state in between.
 */
export function useOptimisticUnits(
  serverEquipped: Equipped,
  serverUnits: ItemUnit[],
) {
  const [overlay, setOverlay] = useState<OwnedState | null>(null);
  /** Unsettled changes. While non-zero, more server transitions are coming. */
  const [inFlight, setInFlight] = useState(0);

  // Normalize once, here at the boundary. The Rust side hands us whatever it
  // last stored, which can be a legacy shape (`modifier` as a bare string) —
  // and `isModifierEquipped` would then substring-match it. Everything
  // downstream (grid, deck row, 3D herzie) reads this one value, so
  // normalizing here is what keeps them from disagreeing.
  //
  // Held behind a content key so a content-identical snapshot keeps its object
  // identity: `state-update` fires every few seconds with freshly deserialized
  // values, and without this every one of them would be a new reference. Same
  // trick the shared Herzie3D uses via equippedCacheKey.
  const serverKey = `${JSON.stringify(normalizeEquipped(serverEquipped))}|${unitsKey(normalizeUnits(serverUnits))}`;
  const serverRef = useRef<OwnedState>({
    equipped: normalizeEquipped(serverEquipped),
    units: normalizeUnits(serverUnits),
  });
  const serverKeyRef = useRef(serverKey);
  if (serverKeyRef.current !== serverKey) {
    serverKeyRef.current = serverKey;
    serverRef.current = {
      equipped: normalizeEquipped(serverEquipped),
      units: normalizeUnits(serverUnits),
    };
  }
  const server = serverRef.current;

  // Read inside callbacks without making them depend on (and be recreated by)
  // every render — same pattern as FriendsView's friendsRef.
  const overlayRef = useRef<OwnedState | null>(null);
  overlayRef.current = overlay;

  const current = overlay ?? server;

  // Nothing in flight, so the server is authoritative again.
  //  - It agrees: retire immediately. Content-based, so this is invisible by
  //    construction — what the UI shows is identical before and after.
  //  - It disagrees: wait out SETTLE_GRACE_MS for the trailing `state-update`,
  //    then defer to the server rather than keep showing a prediction nothing
  //    is going to confirm.
  useEffect(() => {
    if (!overlay || inFlight > 0) return;
    if (sameOwned(server, overlay)) {
      setOverlay(null);
      return;
    }
    const id = setTimeout(() => setOverlay(null), SETTLE_GRACE_MS);
    return () => clearTimeout(id);
  }, [server, overlay, inFlight]);

  // Safety valve for a change that never settles, so a prediction can't pin the
  // UI indefinitely. Re-armed whenever the in-flight count changes, so a burst
  // of changes gets the full window from the last one rather than expiring
  // mid-flight.
  useEffect(() => {
    if (!overlay || inFlight === 0) return;
    const id = setTimeout(() => {
      setInFlight(0);
      setOverlay(null);
    }, RECONCILE_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [overlay, inFlight]);

  const toggleEquip = useCallback(
    async (
      unitId: string,
      preferredSide?: GroundSide,
    ): Promise<ToggleEquipResult> => {
      const base = overlayRef.current ?? serverRef.current;
      const unit = base.units.find((u) => u.id === unitId);
      const worn = unit?.equippedSlot != null;
      const action: "equip" | "unequip" = worn ? "unequip" : "equip";
      if (!unit) {
        return {
          ok: false,
          action,
          error: REJECTION_MESSAGES["not-owned"],
          sent: false,
        };
      }

      const item = getItem(unit.itemId);
      // `preferredSide` is the caller naming the exact ground slot it means
      // (the deck's two Accessory boxes are ground_left and ground_right, and
      // clicking the right one must not fill the left). Without one, fall
      // back to picking a free side — which is all a bank click can say.
      const side =
        action === "equip" && item?.equipSlot === "ground"
          ? (preferredSide ?? pickGroundSide(base.equipped))
          : undefined;

      const predicted = applyEquip(
        base.units,
        unitId,
        action,
        item?.equipSlot,
        side,
      );
      if (!predicted.ok) {
        // Refused against our own state — the server would refuse it too, so
        // don't send it, and don't move the UI.
        return {
          ok: false,
          action,
          error: REJECTION_MESSAGES[predicted.reason],
          sent: false,
        };
      }

      setOverlay({
        units: predicted.units,
        equipped: deriveEquipped(predicted.units, base.equipped),
      });
      setInFlight((n) => n + 1);
      try {
        await herzies.equipItem(unitId, action, side);
        return { ok: true, action };
      } catch (e: unknown) {
        // The change didn't happen, so the prediction is wrong. Drop the whole
        // overlay and let the server's state show through rather than trying
        // to unpick just this one — with several in flight there's no sound
        // way to rebuild the rest. Any still pending will be reflected once
        // the server confirms them and the next `state-update` lands; nothing
        // re-applies a prediction for them.
        setOverlay(null);
        const error = e instanceof Error ? e.message : String(e);
        return { ok: false, action, error, sent: true };
      } finally {
        setInFlight((n) => Math.max(0, n - 1));
      }
    },
    [],
  );

  /**
   * Show a change to the copies that some *other* in-flight request is
   * performing server-side — a sell removing copies (and un-wearing any that
   * were worn), a dice upgrade raising one's level. Issues no request of its
   * own; `settled` is the caller's request, and the prediction is held until it
   * resolves exactly as an equip's would be.
   *
   * Routing these through this hook rather than predicting them separately is
   * what stops a sell and an equip from fighting over the same overlay.
   * `update` receives the copies as currently shown (the prediction so far, or
   * the server's) and returns what they will be.
   */
  const predict = useCallback(
    (
      update: (units: readonly ItemUnit[]) => ItemUnit[],
      settled: Promise<unknown>,
    ) => {
      const base = overlayRef.current ?? serverRef.current;
      const units = update(base.units);
      setOverlay({ units, equipped: deriveEquipped(units, base.equipped) });
      setInFlight((n) => n + 1);
      const release = () => setInFlight((n) => Math.max(0, n - 1));
      // Both arms, rather than .finally(), so a rejected `settled` doesn't
      // surface here as an unhandled rejection — the caller handles its own.
      settled.then(release, release);
    },
    [],
  );

  // Memoized: it feeds a useMemo upstream, and a fresh object every render
  // would rebuild the whole app state on each one while a change is predicted.
  const predictedInventory = useMemo(
    () => (overlay ? unitsToInventory(overlay.units) : null),
    [overlay],
  );

  return {
    units: current.units,
    equipped: current.equipped,
    /** The counts implied by the copies as currently shown, or null while
     * nothing is predicted (callers then use the server's own counts, which
     * may be all that's cached before copies have arrived). */
    predictedInventory,
    toggleEquip,
    predict,
  };
}
