import { describe, expect, it } from "vitest";
import { seededRandom } from "./companion.js";
import {
  BEAT_SECONDS,
  GHOST_SURGE,
  newSurgeState,
  SPIRIT_SURGE,
  SURGE_VARIANT_COUNT,
  type SurgeState,
  type SurgeTuning,
  startSurge,
  stepSurge,
} from "./surge.js";

/** Dances for `seconds` at `fps`, sampling the surge every frame. */
function dance(
  fps: number,
  seconds: number,
  tuning: SurgeTuning = SPIRIT_SURGE,
  seed = 7,
) {
  const s = newSurgeState(seededRandom(seed));
  const dt = 1 / fps;
  const frames: {
    t: number;
    y: number;
    v: number;
    started: number | null;
  }[] = [];
  let clock = 0;
  let pulse = s.pulse;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    clock += dt;
    stepSurge(s, dt, clock, true, tuning);
    frames.push({
      t: clock,
      y: s.y,
      v: s.v,
      started: s.pulse && s.pulse !== pulse ? s.pulse.start : null,
    });
    pulse = s.pulse;
  }
  return { s, frames };
}

/** One surge of `variant`, run out (no beats meanwhile), every 1/240s. */
function oneSurge(variant: number, tuning: SurgeTuning) {
  const s = newSurgeState(seededRandom(1));
  startSurge(s, variant, tuning);
  const ys: number[] = [];
  const vs: number[] = [];
  const dt = 1 / 240;
  for (let i = 0; i < 4 * 240; i++) {
    // A clock that never reaches a beat: no other surge starts.
    stepSurge(s, dt, BEAT_SECONDS / 2, true, tuning);
    ys.push(s.y);
    vs.push(s.v);
  }
  return { s, ys, vs };
}

const HEIGHTS = [0.16, 0.26, 0.18, 0.3];

describe("stepSurge", () => {
  it("is the same at any frame rate", () => {
    const slow = dance(30, 12).frames;
    const fast = dance(144, 12).frames;
    // Matching moments: every 1/6 s, which both land on exactly.
    for (let k = 1; k <= 12 * 6; k++) {
      const a = slow[k * 5 - 1];
      const b = fast[k * 24 - 1];
      expect(a.t).toBeCloseTo(b.t, 9);
      expect(a.y).toBeCloseTo(b.y, 3);
    }
  });

  it("surges on the beat, every few beats, never long without one", () => {
    const { frames } = dance(240, 60);
    const starts = frames.flatMap((f) =>
      f.started === null ? [] : [f.started],
    );
    expect(starts.length).toBeGreaterThan(10);
    for (const t of starts) {
      const beats = t / BEAT_SECONDS;
      // On the beat itself, not the frame after it.
      expect(Math.abs(beats - Math.round(beats)) * BEAT_SECONDS).toBeLessThan(
        1e-6,
      );
    }
    for (let i = 1; i < starts.length; i++) {
      const gap = (starts[i] - starts[i - 1]) / BEAT_SECONDS;
      expect(gap).toBeGreaterThanOrEqual(4 - 1e-6);
      expect(gap).toBeLessThanOrEqual(12 + 1e-6);
    }
  });

  for (const [name, tuning] of [
    ["spirit", SPIRIT_SURGE],
    ["ghost", GHOST_SURGE],
  ] as const) {
    describe(`a ${name}'s surge`, () => {
      for (let v = 0; v < SURGE_VARIANT_COUNT; v++) {
        it(`variant ${v} rises about as high as it should, and floats back`, () => {
          const { ys, vs } = oneSurge(v, tuning);
          const peak = Math.max(...ys);
          const want = HEIGHTS[v] * tuning.lift;
          expect(peak).toBeGreaterThan(want * 0.85);
          expect(peak).toBeLessThan(want * 1.35);
          // It dips a little below rest before settling — no floor to hit.
          expect(-Math.min(...ys)).toBeLessThan(peak * 0.15);
          // Rises quicker than it sinks: buoyant, not thrown. (The climb
          // rises in two steps and sinks in one, so only near it.)
          const sink = -Math.min(...vs);
          expect(Math.max(...vs)).toBeGreaterThan(sink * (v === 1 ? 0.9 : 1.1));
          // And settles.
          expect(Math.abs(ys[ys.length - 1])).toBeLessThan(1e-3);
        });
      }
    });
  }

  it("never jumps or jolts: no step in its height or speed", () => {
    const { frames } = dance(240, 30);
    const dt = 1 / 240;
    for (let i = 2; i < frames.length; i++) {
      const [a, b, c] = [frames[i - 2], frames[i - 1], frames[i]];
      // Height changes only as fast as its speed says.
      expect(Math.abs(c.y - b.y - c.v * dt)).toBeLessThan(2e-4);
      // Its speed changes smoothly too: acceleration bounded, and with no
      // sudden flip (what landing on a floor looks like).
      const acc = (c.v - b.v) / dt;
      const before = (b.v - a.v) / dt;
      expect(Math.abs(acc)).toBeLessThan(40);
      expect(Math.abs(acc - before)).toBeLessThan(2);
    }
  });

  it("lets go when the dance stops, and glides back to rest", () => {
    const s = newSurgeState(seededRandom(3));
    startSurge(s, 3, SPIRIT_SURGE);
    for (let i = 0; i < 60; i++) stepSurge(s, 1 / 120, 0.1, true, SPIRIT_SURGE);
    expect(s.y).toBeGreaterThan(0.1);
    let prev = s.y;
    let biggest = 0;
    for (let i = 0; i < 480; i++) {
      stepSurge(s, 1 / 120, 0, false, SPIRIT_SURGE);
      biggest = Math.max(biggest, Math.abs(s.y - prev));
      prev = s.y;
    }
    expect(s.pulse).toBeNull();
    expect(Math.abs(s.y)).toBeLessThan(1e-3);
    // Gently: no frame moves it far.
    expect(biggest).toBeLessThan(0.02);
    // Its twirl comes round to a whole turn, too.
    const turn = Math.PI * 2;
    expect(Math.abs(s.spin - Math.round(s.spin / turn) * turn)).toBeLessThan(
      1e-3,
    );
  });

  it("is back at rest after a long pause", () => {
    const { s } = dance(60, 1);
    s.y = 0.2;
    stepSurge(s, 5, 6, true, SPIRIT_SURGE);
    expect(s.y).toBe(0);
    expect(s.pulse).toBeNull();
  });
});

describe("surge variants", () => {
  it("never repeats one twice running", () => {
    const { frames, s } = dance(60, 120);
    expect(frames.length).toBeGreaterThan(0);
    // Re-run, recording each start's variant.
    const st: SurgeState = newSurgeState(seededRandom(7));
    const seen: number[] = [];
    let clock = 0;
    for (let i = 0; i < 120 * 60; i++) {
      clock += 1 / 60;
      const before = st.pulse;
      stepSurge(st, 1 / 60, clock, true, SPIRIT_SURGE);
      if (st.pulse && st.pulse !== before) seen.push(st.pulse.variant);
    }
    expect(new Set(seen).size).toBe(SURGE_VARIANT_COUNT);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    expect(s).toBeTruthy();
  });
});
