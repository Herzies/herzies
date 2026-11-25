import { bleedEveryMs, FORBIDDEN_FREQUENCY } from "@herzies/shared";
import { useSyncExternalStore } from "react";

/**
 * Forbidden Frequency's bleeds as this client shows them: on herzies (by
 * entity id), mobs (by id), the boss, and, in practice, dummies (by key).
 * The server says who bleeds, how many stacks and until when (`bleed`),
 * and its hits come as ordinary hits flagged `bleed`; in practice Combat
 * keeps the dummies' bleeds here itself and hits them. vfx/BleedVFX draws
 * them, and the thrown discs until they land; the health bars mark them
 * ({@link useBleedStacks}, {@link bleedStacks}). Times are
 * performance.now() ms.
 */

export type BleedTarget =
  | { kind: "herzie"; id: number }
  | { kind: "mob"; id: number }
  | { kind: "boss" }
  | { kind: "dummy"; key: string };

export type Bleed = {
  target: BleedTarget;
  stacks: number;
  until: number;
  /** When its last stack landed (the aura flares). */
  landedAt: number;
  /** Practice only: each bleed hit's share of a wave, and when the next
   * one lands. */
  value: number;
  nextTick: number;
};

/** Every bleed, by what bleeds. */
export const bleeds = {
  herzies: new Map<number, Bleed>(),
  mobs: new Map<number, Bleed>(),
  boss: null as Bleed | null,
  dummies: new Map<string, Bleed>(),
};

/** When each thrower's last Forbidden Frequency disc landed (by its
 * entity id): its disc in flight is gone from then. */
export const discLanded = new Map<number, number>();

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** `target`'s bleed, if any (ended or not). */
function bleedOf(target: BleedTarget): Bleed | undefined {
  switch (target.kind) {
    case "herzie":
      return bleeds.herzies.get(target.id);
    case "mob":
      return bleeds.mobs.get(target.id);
    case "boss":
      return bleeds.boss ?? undefined;
    case "dummy":
      return bleeds.dummies.get(target.key);
  }
}

function put(target: BleedTarget, b: Bleed | null): void {
  switch (target.kind) {
    case "herzie":
      if (b) bleeds.herzies.set(target.id, b);
      else bleeds.herzies.delete(target.id);
      return;
    case "mob":
      if (b) bleeds.mobs.set(target.id, b);
      else bleeds.mobs.delete(target.id);
      return;
    case "boss":
      bleeds.boss = b;
      return;
    case "dummy":
      if (b) bleeds.dummies.set(target.key, b);
      else bleeds.dummies.delete(target.key);
      return;
  }
}

/** How many stacks a herzie (or a mob) bleeds with at `now`: 0 if none. */
export function bleedStacks(
  kind: "herzie" | "mob",
  id: number,
  now: number,
): number {
  const b = (kind === "herzie" ? bleeds.herzies : bleeds.mobs).get(id);
  return b && b.until > now ? b.stacks : 0;
}

/** {@link bleedStacks} for the boss. */
export function bossBleedStacks(now: number): number {
  const b = bleeds.boss;
  return b && b.until > now ? b.stacks : 0;
}

/** The stacks a herzie (or the boss, with `id` null) bleeds with,
 * re-rendering as they change and when the bleed ends. */
export function useBleedStacks(id: number | null | undefined): number {
  return useSyncExternalStore(subscribe, () => {
    const now = performance.now();
    if (id === undefined) return 0;
    return id === null ? bossBleedStacks(now) : bleedStacks("herzie", id, now);
  });
}

/**
 * `target` bleeds `stacks` until `until`, its newest stack thrown by `by`
 * (0 stacks: it's over). Returns whether a stack landed (more than it
 * had, or the same started over), for the tick of its sound.
 */
export function setBleed(
  target: BleedTarget,
  stacks: number,
  until: number,
  by: number,
  now: number,
): boolean {
  if (stacks <= 0 || until <= now) {
    if (bleedOf(target)) {
      put(target, null);
      emit();
    }
    return false;
  }
  discLanded.set(by, now);
  const was = bleedOf(target);
  if (was) {
    was.stacks = stacks;
    was.until = until;
    was.landedAt = now;
  } else
    put(target, {
      target,
      stacks,
      until,
      landedAt: now,
      value: 0,
      nextTick: now + bleedEveryMs(stacks),
    });
  emit();
  return true;
}

/** Practice: your disc lands on dummy `key`: a stack more (up to the
 * most), the time started over, each bleed hit `value` of a wave. */
export function bleedDummy(
  key: string,
  value: number,
  durationMs: number,
  by: number,
  now: number,
): void {
  const was = bleeds.dummies.get(key);
  const live = was && was.until > now ? was.stacks : 0;
  const stacks = Math.min(FORBIDDEN_FREQUENCY.maxStacks, live + 1);
  setBleed({ kind: "dummy", key }, stacks, now + durationMs, by, now);
  const b = bleeds.dummies.get(key);
  if (!b) return;
  // A fresh bleed hits a beat from now; one running keeps its beat, at
  // its new pace.
  if (!live) b.nextTick = now + bleedEveryMs(stacks);
  b.value = Math.max(live ? b.value : 0, value);
}

/** Bleeds that ran out by `now`: gone. */
export function pruneBleeds(now: number): void {
  pruneAt = now;
  pruned = false;
  bleeds.herzies.forEach(pruneNumbered);
  bleeds.mobs.forEach(pruneNumbered);
  bleeds.dummies.forEach(pruneDummy);
  if (bleeds.boss && bleeds.boss.until <= now) {
    bleeds.boss = null;
    pruned = true;
  }
  if (pruned) emit();
}
let pruneAt = 0;
let pruned = false;
function pruneNumbered(b: Bleed, id: number, map: Map<number, Bleed>): void {
  if (b.until > pruneAt) return;
  map.delete(id);
  pruned = true;
}
function pruneDummy(b: Bleed, key: string, map: Map<string, Bleed>): void {
  if (b.until > pruneAt) return;
  map.delete(key);
  pruned = true;
}

/** Calls `visit` with every bleed (herzies', mobs', the boss's, dummies'),
 * allocating nothing. */
export function walkBleeds(visit: (b: Bleed) => void): void {
  bleeds.herzies.forEach(visit);
  bleeds.mobs.forEach(visit);
  bleeds.dummies.forEach(visit);
  if (bleeds.boss) visit(bleeds.boss);
}

export function clearBleeds(): void {
  bleeds.herzies.clear();
  bleeds.mobs.clear();
  bleeds.boss = null;
  bleeds.dummies.clear();
  discLanded.clear();
  emit();
}
