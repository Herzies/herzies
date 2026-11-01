import { describe, expect, it } from "vitest";
import { parseMap } from "./map";
import homeMap from "./maps/home.json";
import {
  clearPath,
  pickTarget,
  ROAMERS,
  standable,
  startRoam,
  stepRoam,
} from "./roam";

const home = { x: 0, z: 0 };
const far = { x: 100, z: 100 };
const everywhere = () => true;

/** A seeded random, so runs repeat. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

describe("roam", () => {
  it("wanders, but never further than its radius", () => {
    const random = seeded();
    const s = startRoam(home, random);
    let walked = 0;
    let danced = false;
    for (let i = 0; i < 60 * 120; i++) {
      const v = stepRoam(s, {
        home,
        radius: 3,
        player: far,
        ok: everywhere,
        dt: 1 / 60,
        random,
      });
      walked += v / 60;
      danced ||= s.dancing;
      expect(Math.hypot(s.at.x, s.at.z)).toBeLessThanOrEqual(3 + 1e-6);
    }
    expect(walked).toBeGreaterThan(5);
    expect(danced).toBe(true);
  });

  it("stops walking when you come up to it", () => {
    const random = seeded(3);
    const s = startRoam(home, random);
    s.wait = 0;
    stepRoam(s, {
      home,
      radius: 3,
      player: far,
      ok: everywhere,
      dt: 0.01,
      random,
    });
    expect(s.to).not.toBeNull();
    const v = stepRoam(s, {
      home,
      radius: 3,
      player: { ...s.at },
      ok: everywhere,
      dt: 0.01,
      random,
    });
    expect(v).toBe(0);
    expect(s.to).toBeNull();
  });

  it("only picks somewhere it can walk straight to", () => {
    // A wall along x = 1.
    const ok = (x: number) => x < 1;
    for (let i = 0; i < 50; i++) {
      const to = pickTarget(home, home, 3, ok);
      if (to) expect(clearPath(home, to, ok)).toBe(true);
    }
    expect(pickTarget(home, home, 3, () => false)).toBeNull();
  });

  it("every roamer has room to wander on the home island", () => {
    const map = parseMap(homeMap);
    const ok = (x: number, z: number) => standable(map, x, z);
    for (const [key, { radius }] of Object.entries(ROAMERS)) {
      const spot = map.spots[key];
      if (!spot) continue;
      const at = { x: spot[0], z: spot[1] };
      const random = seeded(7);
      let found = 0;
      for (let i = 0; i < 20; i++)
        if (pickTarget(at, at, radius, ok, random)) found++;
      expect(found, key).toBeGreaterThan(10);
    }
  });
});
