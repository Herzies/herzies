import { useSyncExternalStore } from "react";

/**
 * Home, as a way of looking at the Town rather than a screen of its own: the
 * camera swings round in front of your herzie and comes in close, and the
 * world around it fades away to the app's background. Your herzie (and
 * what's dropped around it) stays.
 *
 * Everything that changes on the way in or out is driven by one number,
 * `blend` (0 the Town as you walk it, 1 Home), moved toward `target` by a
 * critically damped spring: the camera's pose, the world's fade, the
 * accessories. Turning back halfway (Home, then a step) just sends it the
 * other way, from where it is and as fast as it was going — nothing snaps
 * or starts over, the way blending cameras in games do it.
 *
 * No three.js here: the app's shell (main.tsx) reads this too, and must not
 * pull the 3D world in with it.
 */

/** How long the blend takes to get most of the way, in seconds (the
 * spring's smoothing time: it's ~90% there after about twice this). */
export const HOME_SMOOTH_TIME = 0.3;

/** Where the blend has gone far enough for Home's things to be drawn over
 * the world (HomeLayer), and the world to start fading. */
const OVERLAY_FROM = 0.12;

/** How Home frames the herzie, as the app's shell lays Home out: where its
 * feet stand (window px from the top), how tall the box Home's own view
 * would draw it in is (px: its size on screen follows from that, see
 * HerzieView), and the camera's zoom (below 1: further back, when the deck
 * or the bag is open over Home). */
export type HomeFrame = {
  feetY: number;
  viewHeight: number;
  zoom: number;
  /** In the big window: Home's cards are a column at the left, with the
   * chat under them, rather than across the window. */
  big?: boolean;
};

type State = {
  /** 1: at Home, or on the way there. */
  target: 0 | 1;
  blend: number;
  /** The spring's speed, in blend per second. */
  velocity: number;
  /** The Town has drawn its first frame: Home can be shown in it (until
   * then the app shows its own stand-in). */
  ready: boolean;
  /** You're on an island you fight on (the boss's cave, the Tower, the
   * training grounds): no Home there. */
  combatMap: boolean;
  frame: HomeFrame | null;
  /** A window's open over Home: the keys are the window's, nobody walks. */
  locked: boolean;
  /** Where Home's camera stands round the herzie this visit (camera-controls'
   * azimuth): set by the camera, read by what's laid out to face it. */
  azimuth: number | null;
  /** Bumped on each way in, so whatever happens once per visit (drops
   * pulled back to you) knows a new one started. */
  visit: number;
};

const state: State = {
  target: 0,
  blend: 0,
  velocity: 0,
  ready: false,
  combatMap: false,
  frame: null,
  locked: false,
  azimuth: null,
  visit: 0,
};

const listeners = new Set<() => void>();
const exitListeners = new Set<(reason: HomeExitReason) => void>();
/** Snapshot for React: what the shell renders from (not the blend, which
 * changes every frame). */
let snapshot = { home: false, ready: false, combatMap: false };

function publish() {
  const next = {
    home: state.target === 1,
    ready: state.ready,
    combatMap: state.combatMap,
  };
  if (
    next.home === snapshot.home &&
    next.ready === snapshot.ready &&
    next.combatMap === snapshot.combatMap
  )
    return;
  snapshot = next;
  for (const l of listeners) l();
}

export type HomeExitReason = "move" | "portal";

/**
 * The spring: Unity's SmoothDamp (Game Programming Gems 4, 1.10), a
 * critically damped spring solved exactly for the step, so it's the same at
 * any frame rate and never overshoots.
 */
export function smoothDamp(
  current: number,
  target: number,
  velocity: number,
  smoothTime: number,
  dt: number,
): { value: number; velocity: number } {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  let v = (velocity - omega * temp) * exp;
  let value = target + (change + temp) * exp;
  // Never past the target.
  if (target - current > 0 === value > target) {
    value = target;
    v = (value - target) / Math.max(dt, 1e-6);
  }
  return { value, velocity: v };
}

/** Smooth 0..1 between `a` and `b`. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export const homeMode = {
  /** At Home (or on the way). */
  get on(): boolean {
    return state.target === 1;
  },
  get blend(): number {
    return state.blend;
  },
  get ready(): boolean {
    return state.ready;
  },
  get combatMap(): boolean {
    return state.combatMap;
  },
  get frame(): HomeFrame | null {
    return state.frame;
  },
  get visit(): number {
    return state.visit;
  },
  /** Where Home's camera stands round the herzie this visit (null until
   * it's been there). */
  get azimuth(): number | null {
    return state.azimuth;
  },
  setAzimuth(azimuth: number): void {
    state.azimuth = azimuth;
  },
  /** At Home with a window open over it: nothing walks. */
  get locked(): boolean {
    return state.target === 1 && state.locked;
  },
  /** Settled at Home: the world's all gone, so only what Home shows needs
   * drawing. */
  get full(): boolean {
    return state.target === 1 && state.blend >= 0.999;
  },

  // What follows from the blend, each on its own curve.

  /** How much of the world's contact shade (ambient occlusion) is gone:
   * first, so the herzie drawn over the fading world (see HomeLayer)
   * matches the one under it. */
  get aoFade(): number {
    return smoothstep(0, OVERLAY_FROM, state.blend);
  },
  /** How far the world has faded to nothing: done a little before the
   * camera gets there, so it arrives on a clean background. */
  get worldFade(): number {
    return smoothstep(OVERLAY_FROM, 0.8, state.blend);
  },
  /** Whether Home's things are drawn again over the fading world (see
   * HomeLayer). */
  get overlay(): boolean {
    return state.blend > OVERLAY_FROM;
  },
  /** The accessories (the boombox), which only belong at Home: in late, out
   * early. */
  get accessories(): number {
    return smoothstep(0.55, 1, state.blend);
  },

  /** Go Home, or leave it. */
  set(on: boolean): void {
    const target = on ? 1 : 0;
    if (state.target === target) return;
    state.target = target;
    if (on) state.visit += 1;
    // Nothing on screen to blend from yet (the world's still loading): it
    // starts where it's going.
    if (!state.ready) homeMode.snap();
    publish();
  },
  /** Straight there, no blend (the app opening on Home). */
  snap(): void {
    state.blend = state.target;
    state.velocity = 0;
  },
  /** Moves the blend on by `dt` seconds. The world calls it once a frame. */
  step(dt: number): void {
    if (state.blend === state.target && state.velocity === 0) return;
    const r = smoothDamp(
      state.blend,
      state.target,
      state.velocity,
      HOME_SMOOTH_TIME,
      Math.min(dt, 0.1),
    );
    state.blend = r.value;
    state.velocity = r.velocity;
    if (Math.abs(state.blend - state.target) < 1e-4) {
      state.blend = state.target;
      state.velocity = 0;
    }
  },
  setReady(ready: boolean): void {
    if (state.ready === ready) return;
    state.ready = ready;
    // The world appearing under a Home already on screen: it starts there.
    if (ready) homeMode.snap();
    publish();
  },
  setCombatMap(on: boolean): void {
    if (state.combatMap === on) return;
    state.combatMap = on;
    publish();
  },
  setFrame(frame: HomeFrame | null): void {
    state.frame = frame;
  },
  setLocked(locked: boolean): void {
    state.locked = locked;
  },
  /** The world wants out of Home (the herzie was walked off, a portal taken):
   * the shell switches to the Town, which calls `set(false)`. */
  requestExit(reason: HomeExitReason): void {
    if (state.target !== 1) return;
    for (const l of exitListeners) l(reason);
  },
  onExitRequest(listener: (reason: HomeExitReason) => void): () => void {
    exitListeners.add(listener);
    return () => exitListeners.delete(listener);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** At Home, whether the world's ready to show it, and whether you're on an
 * island without one — re-rendering when any of them changes. */
export function useHomeMode(): {
  home: boolean;
  ready: boolean;
  combatMap: boolean;
} {
  return useSyncExternalStore(homeMode.subscribe, () => snapshot);
}

/** For tests: back to how the app starts. */
export function resetHomeMode(): void {
  Object.assign(state, {
    target: 0,
    blend: 0,
    velocity: 0,
    ready: false,
    combatMap: false,
    frame: null,
    locked: false,
    azimuth: null,
    visit: 0,
  });
  snapshot = { home: false, ready: false, combatMap: false };
}
