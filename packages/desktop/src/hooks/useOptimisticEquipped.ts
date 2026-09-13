import {
  applyEquip,
  type Equipped,
  type EquipRejection,
  findEquippedSlot,
  type GroundSide,
  getItem,
  isModifierEquipped,
  normalizeEquipped,
} from "@herzies/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { herzies } from "../tauri-bridge";

/**
 * Ceiling on how long a prediction may outlive the server *while a toggle is
 * still in flight*. Only reached when a request never settles; on the normal
 * path the prediction is retired as soon as the server's state matches it.
 */
const RECONCILE_TIMEOUT_MS = 6000;

/**
 * Once nothing is in flight the server is authoritative again, so a prediction
 * it disagrees with only deserves the time it takes a trailing `state-update`
 * to arrive — the command's response and that event have no guaranteed IPC
 * order, and this covers the gap. Anything longer would show a stale value for
 * a divergence we already know about (a sell that unequipped the last copy, a
 * change from another device) and then snap, which is worse than the lag the
 * optimistic layer replaced.
 */
const SETTLE_GRACE_MS = 400;

/** User-facing text for the reasons applyEquip can refuse a toggle locally. */
const REJECTION_MESSAGES: Record<EquipRejection, string> = {
  "already-equipped": "Already equipped",
  "not-equipped": "Not equipped",
  "max-modifiers": "No modifier slots left",
  "missing-side": "No free ground slot",
  "no-slot": "This item can't be placed",
};

export type ToggleEquipResult =
  | { ok: true; action: "equip" | "unequip" }
  | { ok: false; action: "equip" | "unequip"; error: string };

/**
 * Deep equality for Equipped. `normalizeEquipped` walks EQUIPPED_SLOTS in a
 * fixed order and appends `modifier` last, so two normalized values with the
 * same content always serialize identically — which makes stringify a
 * legitimate comparison here, and (unlike `equippedCacheKey`, which sorts)
 * one that stays sensitive to modifier *order*, since DeckRow renders
 * modifiers positionally.
 */
function sameEquipped(a: Equipped, b: Equipped): boolean {
  return (
    JSON.stringify(normalizeEquipped(a)) ===
    JSON.stringify(normalizeEquipped(b))
  );
}

/** Ground items pick a side at equip time; prefer a free one, else replace left. */
function pickGroundSide(equipped: Equipped): GroundSide {
  if (!equipped.ground_left) return "left";
  if (!equipped.ground_right) return "right";
  return "left";
}

/**
 * Optimistic equip/unequip.
 *
 * Equipping used to wait a full server round-trip before anything moved, which
 * read as lag on every click. This predicts the result locally and shows it at
 * once, using the same `applyEquip` the server uses — so the prediction *is*
 * the server's answer rather than an approximation of it, and the real
 * response lands as a no-op instead of a visible correction.
 *
 * Three things make it glitch-free, and all three are load-bearing:
 *
 *  1. **The prediction outranks incoming snapshots.** `state-update` fires
 *     every few seconds carrying the server's `equipped`; a snapshot issued
 *     before our mutation committed would otherwise revert the UI mid-flight.
 *  2. **It's retired by content, not by timing.** The overlay is dropped only
 *     once the server's own state matches it, so there is no instant where we
 *     swap prediction for truth and risk a frame of the old value. Clearing on
 *     promise-resolve instead would race the `state-update` carrying the new
 *     value — their IPC ordering isn't guaranteed.
 *  3. **Predictions compose, and survive until the last one settles.** Each
 *     toggle builds on the current prediction rather than the last snapshot,
 *     so two quick clicks don't have the second discard the first; and the
 *     overlay is held while anything is still in flight, so an equip-then-
 *     unequip pair can't briefly flash the equipped state in between.
 */
export function useOptimisticEquipped(serverEquipped: Equipped) {
  const [overlay, setOverlay] = useState<Equipped | null>(null);
  /** Unsettled toggles. While non-zero, more server transitions are still coming. */
  const [inFlight, setInFlight] = useState(0);

  // Normalize once, here at the boundary. The Rust side hands us whatever it
  // last stored, which can be a legacy shape (`modifier` as a bare string) —
  // and `isModifierEquipped` would then substring-match it. Everything
  // downstream (grid, deck row, 3D herzie) reads this one value, so
  // normalizing here is what keeps them from disagreeing.
  //
  // Held behind a content key so a content-identical snapshot keeps its object
  // identity: `state-update` fires every few seconds with a freshly
  // deserialized map, and without this every one of them would be a new
  // reference. Same trick the shared Herzie3D uses via equippedCacheKey.
  const serverKey = JSON.stringify(normalizeEquipped(serverEquipped));
  const serverRef = useRef<Equipped>(normalizeEquipped(serverEquipped));
  const serverKeyRef = useRef(serverKey);
  if (serverKeyRef.current !== serverKey) {
    serverKeyRef.current = serverKey;
    serverRef.current = normalizeEquipped(serverEquipped);
  }
  const server = serverRef.current;

  // Read inside the callback without making it depend on (and be recreated by)
  // every render — same pattern as FriendsView's friendsRef.
  const overlayRef = useRef<Equipped | null>(null);
  overlayRef.current = overlay;

  const equipped = overlay ?? server;

  // Nothing in flight, so the server is authoritative again.
  //  - It agrees: retire immediately. Content-based, so this is invisible by
  //    construction — what the UI shows is identical before and after.
  //  - It disagrees: wait out SETTLE_GRACE_MS for the trailing `state-update`,
  //    then defer to the server rather than keep showing a prediction nothing
  //    is going to confirm.
  useEffect(() => {
    if (!overlay || inFlight > 0) return;
    if (sameEquipped(server, overlay)) {
      setOverlay(null);
      return;
    }
    const id = setTimeout(() => setOverlay(null), SETTLE_GRACE_MS);
    return () => clearTimeout(id);
  }, [server, overlay, inFlight]);

  // Safety valve for a toggle that never settles, so a prediction can't pin the
  // UI indefinitely. Re-armed whenever the in-flight count changes, so a burst
  // of toggles gets the full window from the last one rather than expiring
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
    async (itemId: string): Promise<ToggleEquipResult> => {
      const current = overlayRef.current ?? serverRef.current;
      const item = getItem(itemId);
      const worn =
        findEquippedSlot(current, itemId) !== null ||
        isModifierEquipped(current, itemId);
      const action: "equip" | "unequip" = worn ? "unequip" : "equip";
      const side =
        action === "equip" && item?.equipSlot === "ground"
          ? pickGroundSide(current)
          : undefined;

      const predicted = applyEquip(
        current,
        itemId,
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
        };
      }

      setOverlay(predicted.equipped);
      setInFlight((n) => n + 1);
      try {
        await herzies.equipItem(itemId, action, side);
        return { ok: true, action };
      } catch (e: unknown) {
        // The equip didn't happen, so the prediction is wrong. Drop the whole
        // overlay and let the server's state show through rather than trying to
        // unpick just this one toggle — with several in flight there's no sound
        // way to rebuild the rest. Any that are still pending will be reflected
        // once the server confirms them and the next `state-update` lands;
        // nothing re-applies a prediction for them.
        setOverlay(null);
        const error = e instanceof Error ? e.message : String(e);
        return { ok: false, action, error };
      } finally {
        setInFlight((n) => Math.max(0, n - 1));
      }
    },
    [],
  );

  /**
   * Show an unequip that some *other* in-flight request is performing
   * server-side — selling the last copy of an equipped item unequips it in the
   * same call (see `applySell`). Issues no request of its own; `settled` is the
   * caller's request, and the prediction is held until it resolves exactly as a
   * toggle's would be.
   *
   * Routing it through this hook rather than predicting separately is what
   * stops a sell and an explicit unequip from fighting over the same overlay.
   */
  const predictUnequip = useCallback(
    (itemId: string, settled: Promise<unknown>) => {
      const current = overlayRef.current ?? serverRef.current;
      const predicted = applyEquip(current, itemId, "unequip", undefined);
      if (!predicted.ok) return;

      setOverlay(predicted.equipped);
      setInFlight((n) => n + 1);
      const release = () => setInFlight((n) => Math.max(0, n - 1));
      // Both arms, rather than .finally(), so a rejected `settled` doesn't
      // surface here as an unhandled rejection — the caller handles its own.
      settled.then(release, release);
    },
    [],
  );

  return { equipped, toggleEquip, predictUnequip };
}
