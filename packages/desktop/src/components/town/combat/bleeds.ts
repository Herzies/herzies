import { bleedEveryMs, FORBIDDEN_FREQUENCY } from "@herzies/shared";
import { useSyncExternalStore } from "react";

/**
 * Bleeds as this client shows them, Forbidden Frequency's and Silencio's:
 * on herzies (by entity id), mobs (by id), the boss, and, in practice,
 * dummies (by key). A target may bleed with one of each at once, kept apart
 * so neither overwrites the other. The server says who bleeds, how many
 * stacks and until when (`bleed`, its `skill` saying whose), and its hits
 * come as ordinary hits flagged `bleed`; in practice Combat keeps the
 * dummies' bleeds here itself and hits them. vfx/BleedVFX draws them, and
 * Forbidden Frequency's thrown discs until they land; the health bars mark
 * them ({@link useBleedStacks}, {@link bleedStacks}). Times are
 * performance.now() ms.
 */

/** The skills whose bleeds these are. */
export type BleedSkill = "forbidden-frequency" | "silencio";

export type BleedTarget =
  | { kind: "herzie"; id: number }
  | { kind: "mob"; id: number }
  | { kind: "boss" }
  | { kind: "dummy"; key: string };

export type Bleed = {
  skill: BleedSkill;
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

/** One skill's bleeds, by what bleeds. */
type Bleeds = {
  herzies: Map<number, Bleed>;
  mobs: Map<number, Bleed>;
  boss: Bleed | null;
  dummies: Map<string, Bleed>;
};

/** Every bleed, by skill, then by what bleeds. */
export const bleeds: Record<BleedSkill, Bleeds> = {
  "forbidden-frequency": {
    herzies: new Map(),
    mobs: new Map(),
    boss: null,
    dummies: new Map(),
  },
  silencio: {
    herzies: new Map(),
    mobs: new Map(),
    boss: null,
    dummies: new Map(),
  },
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

/** `target`'s bleed from `skill`, if any (ended or not). */
function bleedOf(skill: BleedSkill, target: BleedTarget): Bleed | undefined {
  const of = bleeds[skill];
  switch (target.kind) {
    case "herzie":
      return of.herzies.get(target.id);
    case "mob":
      return of.mobs.get(target.id);
    case "boss":
      return of.boss ?? undefined;
    case "dummy":
      return of.dummies.get(target.key);
  }
}

function put(skill: BleedSkill, target: BleedTarget, b: Bleed | null): void {
  const of = bleeds[skill];
  switch (target.kind) {
    case "herzie":
      if (b) of.herzies.set(target.id, b);
      else of.herzies.delete(target.id);
      return;
    case "mob":
      if (b) of.mobs.set(target.id, b);
      else of.mobs.delete(target.id);
      return;
    case "boss":
      of.boss = b;
      return;
    case "dummy":
      if (b) of.dummies.set(target.key, b);
      else of.dummies.delete(target.key);
      return;
  }
}

/** What the health bar's drop shows for bleeds `ff` and `hush` at `now`:
 * Forbidden Frequency's stacks while it runs, else 1 while a Silencio's
 * does (a drop with no count), else 0. */
function shownStacks(
  ff: Bleed | null | undefined,
  hush: Bleed | null | undefined,
  now: number,
): number {
  if (ff && ff.until > now) return ff.stacks;
  return hush && hush.until > now ? 1 : 0;
}

/** How many stacks a herzie (or a mob) bleeds with at `now`, for its
 * health bar: 0 if none (see {@link shownStacks}). */
export function bleedStacks(
  kind: "herzie" | "mob",
  id: number,
  now: number,
): number {
  const of = kind === "herzie" ? "herzies" : "mobs";
  return shownStacks(
    bleeds["forbidden-frequency"][of].get(id),
    bleeds.silencio[of].get(id),
    now,
  );
}

/** {@link bleedStacks} for the boss. */
export function bossBleedStacks(now: number): number {
  return shownStacks(
    bleeds["forbidden-frequency"].boss,
    bleeds.silencio.boss,
    now,
  );
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
 * `target` bleeds from `skill` with `stacks` until `until`, its newest
 * stack by `by` (0 stacks: it's over). Returns whether a stack landed
 * (more than it had, or the same started over), for the tick of its
 * sound.
 */
export function setBleed(
  skill: BleedSkill,
  target: BleedTarget,
  stacks: number,
  until: number,
  by: number,
  now: number,
): boolean {
  if (stacks <= 0 || until <= now) {
    if (bleedOf(skill, target)) {
      put(skill, target, null);
      emit();
    }
    return false;
  }
  // Only a Forbidden Frequency's disc was in the air to land.
  if (skill === "forbidden-frequency") discLanded.set(by, now);
  const was = bleedOf(skill, target);
  if (was) {
    was.stacks = stacks;
    was.until = until;
    was.landedAt = now;
  } else
    put(skill, target, {
      skill,
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

/** Practice: dummy `key` takes a bleed from `skill` (your Forbidden
 * Frequency's disc lands on it, or your Silencio catches it): the time
 * started over, each bleed hit `value` of a wave; a stack more of Forbidden
 * Frequency (up to the most), Silencio's only ever one. */
export function bleedDummy(
  skill: BleedSkill,
  key: string,
  value: number,
  durationMs: number,
  by: number,
  now: number,
): void {
  const was = bleeds[skill].dummies.get(key);
  const live = was && was.until > now ? was.stacks : 0;
  const stacks =
    skill === "silencio"
      ? 1
      : Math.min(FORBIDDEN_FREQUENCY.maxStacks, live + 1);
  setBleed(skill, { kind: "dummy", key }, stacks, now + durationMs, by, now);
  const b = bleeds[skill].dummies.get(key);
  if (!b) return;
  // A fresh bleed hits a beat from now; one running keeps its beat, at
  // its new pace.
  if (!live) b.nextTick = now + bleedEveryMs(stacks);
  b.value = skill === "silencio" ? value : Math.max(live ? b.value : 0, value);
}

/** Bleeds that ran out by `now`: gone. */
export function pruneBleeds(now: number): void {
  pruneAt = now;
  pruned = false;
  for (const of of Object.values(bleeds)) {
    of.herzies.forEach(pruneNumbered);
    of.mobs.forEach(pruneNumbered);
    of.dummies.forEach(pruneDummy);
    if (of.boss && of.boss.until <= now) {
      of.boss = null;
      pruned = true;
    }
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

/** Calls `visit` with every bleed (herzies', mobs', the boss's, dummies',
 * of both skills), allocating nothing. */
export function walkBleeds(visit: (b: Bleed) => void): void {
  walkOf(bleeds["forbidden-frequency"], visit);
  walkOf(bleeds.silencio, visit);
}
function walkOf(of: Bleeds, visit: (b: Bleed) => void): void {
  of.herzies.forEach(visit);
  of.mobs.forEach(visit);
  of.dummies.forEach(visit);
  if (of.boss) visit(of.boss);
}

export function clearBleeds(): void {
  for (const of of Object.values(bleeds)) {
    of.herzies.clear();
    of.mobs.clear();
    of.boss = null;
    of.dummies.clear();
  }
  discLanded.clear();
  emit();
}
