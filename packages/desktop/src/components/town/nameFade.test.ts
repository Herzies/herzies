import { describe, expect, it } from "vitest";
import {
  NAME_FADE,
  nameOpacity,
  nearestIds,
  REMOTE_LABEL,
  remoteLabel,
} from "./nameFade";

describe("nameOpacity", () => {
  it("is gone far off, there up close, and eases between", () => {
    expect(nameOpacity(NAME_FADE.far + 5)).toBe(0);
    expect(nameOpacity(NAME_FADE.far)).toBe(0);
    expect(nameOpacity(NAME_FADE.near)).toBe(1);
    expect(nameOpacity(0)).toBe(1);
    const mid = nameOpacity((NAME_FADE.far + NAME_FADE.near) / 2);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });

  it("never gets less visible as you come closer", () => {
    let last = 0;
    for (let d = 20; d >= 0; d -= 0.5) {
      const o = nameOpacity(d);
      expect(o).toBeGreaterThanOrEqual(last);
      last = o;
    }
  });
});

describe("remoteLabel", () => {
  it("reads another player's name from further than a visitor's", () => {
    expect(nameOpacity(20)).toBe(0);
    expect(remoteLabel(20).name).toBe(1);
    expect(remoteLabel(26).name).toBeGreaterThan(0);
    expect(remoteLabel(31).name).toBe(0);
  });

  it("drops the title before the name", () => {
    expect(remoteLabel(10).title).toBe(1);
    expect(remoteLabel(20).title).toBeGreaterThan(0);
    expect(remoteLabel(20).title).toBeLessThan(remoteLabel(20).name);
    expect(remoteLabel(22).title).toBe(0);
    expect(remoteLabel(22).name).toBe(1);
    for (let d = 0; d <= 40; d += 0.5)
      expect(remoteLabel(d).title).toBeLessThanOrEqual(remoteLabel(d).name);
  });

  it("shrinks names a little with distance, never below 80%", () => {
    expect(remoteLabel(5).scale).toBe(1);
    expect(remoteLabel(21).scale).toBeLessThan(1);
    expect(remoteLabel(21).scale).toBeGreaterThan(0.8);
    expect(remoteLabel(80).scale).toBeCloseTo(0.8);
    let last = 1;
    for (let d = 0; d <= 40; d += 1) {
      expect(remoteLabel(d).scale).toBeLessThanOrEqual(last);
      last = remoteLabel(d).scale;
    }
  });

  it("keeps a duelist's name and health in sight across the field", () => {
    const watched = remoteLabel(40, { duelist: true });
    expect(watched.name).toBe(1);
    expect(watched.hp).toBe(1);
    // Its title fades as anyone's does.
    expect(watched.title).toBe(0);
    expect(remoteLabel(55, { duelist: true }).name).toBe(0);
    // Not a duelist: no bar past the usual reach.
    expect(remoteLabel(16).hp).toBe(0);
    expect(remoteLabel(5).hp).toBe(1);
  });

  it("names only the nearest few, but always duelists and the hovered", () => {
    expect(remoteLabel(5, { ranked: false }).name).toBe(0);
    expect(remoteLabel(5, { ranked: false, duelist: true }).name).toBe(1);
    const hovered = remoteLabel(60, { ranked: false, hovered: true });
    expect(hovered).toMatchObject({ name: 1, title: 1, scale: 1 });
  });
});

describe("nearestIds", () => {
  it("picks the nearest, however they're listed", () => {
    const at = new Map(
      Array.from({ length: 20 }, (_, i) => [i, { x: (19 - i) * 3, z: 1 }]),
    );
    const out = nearestIds(at, 0, 0, REMOTE_LABEL.nearest, new Set([99]));
    expect(out.size).toBe(12);
    expect(out.has(99)).toBe(false);
    for (let i = 8; i < 20; i++) expect(out.has(i)).toBe(true);
    expect(out.has(7)).toBe(false);
  });

  it("takes everyone when there are fewer", () => {
    const at = new Map([[4, { x: 1, z: 1 }]]);
    expect([...nearestIds(at, 0, 0, 12, new Set())]).toEqual([4]);
  });
});
