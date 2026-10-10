import { benchBonusHp, liveHp, type Vitals } from "@herzies/shared";
import { useEffect, useState, useSyncExternalStore } from "react";
import { herzies } from "../../tauri-bridge";
import { townLive } from "./runtime";

/** The player's health as the server last told us: handed out with every
 * ticket and by `town-vitals`, and rewritten from a fight's `hp` messages.
 * Regen is counted here from the stamp, so the bar climbs between updates. */
let current: Vitals | null = null;
/** HP earned on a bench since `current` was set: the server adds it in
 * batches, so the app counts it as it happens to agree when it looks. */
let benchExtra = 0;
/** In a fight health doesn't come back: the server's value is the truth. */
let frozen = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setVitals(v: Vitals | null) {
  current = v;
  benchExtra = 0;
  emit();
}

/** The last vitals the server gave us (null before the first). */
export function getVitals(): Vitals | null {
  return current;
}

/** In (or out of) a fight: health stops regenerating in the bar. */
export function setRegenFrozen(on: boolean) {
  if (frozen === on) return;
  frozen = on;
  emit();
}

/** HP now, from a server value: used when a fight reports an absolute HP. */
export function setHpNow(hp: number, down = hp <= 0) {
  if (!current) return;
  setVitals({ ...current, hp, stored: hp, hpAt: Date.now(), down });
}

/** Ask the server how healthy the herzie is, and take its word. */
export function refreshVitals(): void {
  herzies
    .townVitals("vitals")
    // In a fight the room's count is truer than the database's (which it
    // updates every couple of seconds).
    .then((r) => {
      if (!frozen) setVitals(r.vitals);
    })
    .catch(() => {});
}

export function useVitals(): Vitals | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** How long after standing up before asking the server (it reports the
 * bench's earnings as you stand). */
const STOOD_UP_REFRESH_MS = 1_500;

/** The player's HP right now, re-read every second while it's changing:
 * regenerating (faster on a bench), unless a fight has it held. */
export function useLiveHp(): {
  hp: number;
  maxHp: number;
  down: boolean;
} | null {
  const v = useVitals();
  const [now, setNow] = useState(() => Date.now());
  const moving =
    !!v && !v.down && !frozen && (v.stored !== null || benchExtra > 0);
  const resting = !!v && !v.down && !frozen;
  useEffect(() => {
    if (!resting) return;
    let wasSeated = !!townLive.seat;
    let stood: ReturnType<typeof setTimeout> | null = null;
    const t = setInterval(() => {
      const seated = !!townLive.seat;
      if (seated && v) benchExtra += benchBonusHp(v.maxHp, 1);
      // Stood up: the server has the bench's earnings by now; take its word.
      if (wasSeated && !seated) {
        stood = setTimeout(refreshVitals, STOOD_UP_REFRESH_MS);
      }
      wasSeated = seated;
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
      if (stood) clearTimeout(stood);
    };
  }, [resting, v]);
  if (!v) return null;
  const base = frozen ? v.hp : liveHp(v, Math.max(now, Date.now()));
  const hp = v.down
    ? 0
    : Math.min(v.maxHp, frozen ? (v.stored ?? base) : base + benchExtra);
  return { hp, maxHp: v.maxHp, down: v.down };
}
