import { describe, expect, it } from "vitest";
import { emptyMap, type TownMap } from "../map";
import { mapById } from "../maps";
import {
  DUMMY,
  type DummyState,
  dummiesOf,
  hitDummy,
  METER_RESET_MS,
  meterDps,
  meterIdle,
  stepDummy,
  waveHitsDummy,
} from "./dummy";
import { assistTarget, WAVE, WaveField, waveRadius } from "./waves";

function withDummy(x = 0, z = 0): DummyState {
  const map: TownMap = emptyMap(40, "test", "Test");
  const col = 20 + Math.floor(x);
  const row = 20 + Math.floor(z);
  const r = map.objects[row];
  map.objects[row] = `${r.slice(0, col)}D${r.slice(col + 1)}`;
  return dummiesOf(map)[0];
}

describe("training dummies", () => {
  it("stand where the testing ground has them", () => {
    const arena = mapById("arena");
    expect(arena.combat).toBe(true);
    expect(dummiesOf(arena).length).toBeGreaterThanOrEqual(3);
  });

  it("rock away from a hit and settle again", () => {
    const d = withDummy();
    d.yaw = 0;
    // A wave travelling +z: the top tips toward +z (a turn about +x).
    hitDummy(d, 0, 1, 100, false, 0);
    stepDummy(d, 0.05, 100);
    expect(d.rock.x).toBeGreaterThan(0.02);
    expect(Math.abs(d.rock.z)).toBeLessThan(1e-9);
    for (let t = 0; t < 4; t += 1 / 60) stepDummy(d, 1 / 60, 1000);
    expect(Math.abs(d.rock.x)).toBeLessThan(0.01);
    expect(d.flash).toBe(0);
  });

  it("rocks the right way whichever way it faces", () => {
    const d = withDummy();
    d.yaw = Math.PI / 2; // facing +x: its own +z is the world's +x
    hitDummy(d, 1, 0, 100, false, 0);
    stepDummy(d, 0.05, 100);
    expect(d.rock.x).toBeGreaterThan(0.02);
  });

  it("holds still for a beat on a crit", () => {
    const d = withDummy();
    hitDummy(d, 0, 1, 100, true, 0);
    stepDummy(d, 0.05, 10);
    expect(d.rock.x).toBe(0);
    stepDummy(d, 0.05, 100);
    expect(d.rock.x).not.toBe(0);
  });

  it("meters damage per second, and starts over after a pause", () => {
    const d = withDummy();
    hitDummy(d, 0, 1, 100, false, 0);
    hitDummy(d, 0, 1, 120, true, 1000);
    hitDummy(d, 0, 1, 80, false, 2000);
    expect(d.meter).toMatchObject({ total: 300, hits: 3, crits: 1 });
    expect(meterDps(d.meter, 2000)).toBe(150);
    // The first hit alone isn't a spike: it's spread over a second.
    const e = withDummy();
    hitDummy(e, 0, 1, 100, false, 0);
    expect(meterDps(e.meter, 0)).toBe(100);
    expect(meterIdle(d.meter, 2000 + METER_RESET_MS + 1)).toBe(true);
    hitDummy(d, 0, 1, 50, false, 2000 + METER_RESET_MS + 1);
    expect(d.meter).toMatchObject({ total: 50, hits: 1, crits: 0 });
  });

  it("leaves the meter alone for someone else's wave", () => {
    const d = withDummy();
    hitDummy(d, 0, 1, 100, false, 0, false);
    expect(d.meter.hits).toBe(0);
    expect(d.flash).toBe(1);
  });
});

describe("a wave reaching a dummy", () => {
  const d = withDummy(0.5, 0.5);

  it("touches it on the side it came from", () => {
    const hit = waveHitsDummy(d, [d.x, 1.2, d.z - 5], [d.x, 1.2, d.z + 5], 0.2);
    expect(hit).not.toBeNull();
    expect(hit?.t).toBeGreaterThan(0.3);
    expect(hit?.t).toBeLessThan(0.5);
    expect(hit?.point[2]).toBeCloseTo(d.z - DUMMY.radius, 5);
  });

  it("misses one it passes beside, above, or stops short of", () => {
    expect(
      waveHitsDummy(d, [d.x + 2, 1.2, d.z - 5], [d.x + 2, 1.2, d.z + 5], 0.2),
    ).toBeNull();
    expect(
      waveHitsDummy(d, [d.x, 4, d.z - 5], [d.x, 4, d.z + 5], 0.2),
    ).toBeNull();
    expect(
      waveHitsDummy(d, [d.x, 1.2, d.z - 5], [d.x, 1.2, d.z - 2], 0.2),
    ).toBeNull();
  });
});

describe("the wave field", () => {
  it("flies a wave into a dummy, which counts the hit and bursts", () => {
    const d = withDummy(0.5, 0.5);
    const field = new WaveField();
    field.cast([d.x, 1.2, d.z - 10], [0, 0, 1], { mine: true });
    const hits: number[] = [];
    for (let i = 0; i < 120 && hits.length === 0; i++) {
      field.step(1 / 60, [d], ({ dummy }) => {
        hits.push(dummy === d ? 1 : 0);
        return "hit";
      });
    }
    expect(hits).toEqual([1]);
    expect(field.waves.every((w) => !w.alive)).toBe(true);
    expect(field.impacts.some((i) => i.alive && i.kind === "hit")).toBe(true);
  });

  it("spreads as it travels", () => {
    const field = new WaveField();
    const w = field.cast([0, 1, 0], [1, 0, 0], { mine: true });
    const r0 = waveRadius(w);
    for (let i = 0; i < 60; i++) field.step(1 / 60, [], () => "hit");
    expect(waveRadius(w)).toBeGreaterThan(r0);
  });

  it("bursts where its reach ends on something solid", () => {
    const field = new WaveField();
    field.cast([0, 1, 0], [1, 0, 0], { mine: true, reach: 3 });
    for (let i = 0; i < 30; i++) field.step(1 / 60, [], () => "hit");
    expect(field.impacts.some((i) => i.alive && i.kind === "fizzle")).toBe(
      true,
    );
  });

  it("draws a near-miss in, but not a wide one", () => {
    const d = withDummy(0.5, 0.5);
    const from: [number, number, number] = [d.x, DUMMY.chest, d.z - 15];
    const slightly: [number, number, number] = [
      Math.sin(0.04),
      0,
      Math.cos(0.04),
    ];
    const wide: [number, number, number] = [Math.sin(0.3), 0, Math.cos(0.3)];
    expect(assistTarget(from, slightly, [d])).toBe(d);
    expect(assistTarget(from, wide, [d])).toBeNull();

    const field = new WaveField();
    field.cast(from, slightly, { mine: true, target: d });
    let hit = false;
    for (let i = 0; i < 120 && !hit; i++) {
      field.step(1 / 60, [d], () => {
        hit = true;
        return "hit";
      });
    }
    expect(hit).toBe(true);
  });

  it("goes no further than its range", () => {
    const field = new WaveField();
    const w = field.cast([0, 1, 0], [1, 0, 0], { mine: true });
    for (let i = 0; i < 400; i++) field.step(1 / 60, [], () => "hit");
    expect(w.alive).toBe(false);
    expect(w.travelled).toBeCloseTo(WAVE.range, 5);
  });
});
