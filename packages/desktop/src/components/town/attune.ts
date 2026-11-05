import { canAttune } from "@herzies/shared";
import { notify } from "../../lib/notices";
import { herzies } from "../../tauri-bridge";
import { burstCrystal, getCrystal, setCrystal } from "./crystalState";
import { townSave } from "./runtime";
import { sfxCrystalBurst, sfxCrystalCharge } from "./sfx";

/**
 * Attuning to the Crystal, played like a skill with a cast time: a cast bar
 * ("Attuning") while you hold still by it, then the Crystal goes off — the
 * flash, a "+N exp" notice, the exp bar filling, and the finds coming out of
 * black holes round you (they're on the ground the moment the server
 * answers; HomeDrops brings them out).
 *
 * Walking off cancels it, and nothing is asked of the server until the cast
 * is done, so a cancelled attune costs nothing.
 */

/** How long the cast takes. */
export const ATTUNE_CAST_MS = 1600;
/** How far you can drift while casting before it's cancelled. */
const DRIFT = 0.6;

/** The cast in progress, if any (read by CastBar every frame). */
export const crystalCast = {
  active: false,
  from: 0,
  until: 0,
  x: 0,
  z: 0,
};

/** Whether there's enough resonance to hand over (else E opens the
 * Crystal's window). */
export function crystalHasSomething(): boolean {
  return canAttune(getCrystal());
}

export function isAttuning(): boolean {
  return crystalCast.active;
}

let busy = false;

/** E at the Crystal with something in it: start the cast. */
export function startAttune(): void {
  if (crystalCast.active || busy || !crystalHasSomething()) return;
  const now = performance.now();
  Object.assign(crystalCast, {
    active: true,
    from: now,
    until: now + ATTUNE_CAST_MS,
    x: townSave.x,
    z: townSave.z,
  });
  sfxCrystalCharge();
  const watch = () => {
    if (!crystalCast.active) return;
    if (
      Math.hypot(townSave.x - crystalCast.x, townSave.z - crystalCast.z) > DRIFT
    ) {
      crystalCast.active = false;
      notify("Attuning interrupted", { kind: "info" });
      return;
    }
    if (performance.now() >= crystalCast.until) {
      crystalCast.active = false;
      void finish();
      return;
    }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

async function finish(): Promise<void> {
  const now = getCrystal();
  if (!now) return;
  busy = true;
  try {
    const reply = await herzies.attuneCrystal(now.attunes);
    if (reply.crystal) setCrystal(reply.crystal);
    if (!reply.ok) return; // already paid (a double press, another window)
    burstCrystal();
    sfxCrystalBurst();
    if (reply.xp > 0)
      notify(`+${reply.xp.toLocaleString()} exp`, { kind: "success" });
    if (reply.dropsLeft > 0)
      notify(
        reply.groundFull
          ? `${reply.dropsLeft} more ${reply.dropsLeft === 1 ? "find waits" : "finds wait"} in your resonance: pick up what's lying around first`
          : `${reply.dropsLeft} more ${reply.dropsLeft === 1 ? "find waits" : "finds wait"} in your resonance`,
        { kind: "info" },
      );
  } catch (e: unknown) {
    notify(e instanceof Error ? e.message : String(e));
  } finally {
    busy = false;
  }
}
