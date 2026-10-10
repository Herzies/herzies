import { describe, expect, it } from "vitest";
import { mapById } from "./maps";
import {
  arrivalOn,
  PORTAL_HALF_WIDTH,
  type Portal,
  portalSide,
  portalsOf,
  walkedThrough,
} from "./portal";

const facingSouth: Portal = { key: "0,0", x: 0, z: 0, yaw: 0, to: "home" };

describe("portals", () => {
  it("link home and the testing ground both ways", () => {
    const home = portalsOf(mapById("home"));
    const arena = portalsOf(mapById("arena"));
    expect(home.map((p) => p.to)).toContain("arena");
    expect(arena.map((p) => p.to)).toContain("home");
  });

  it("know which side of the disc you're on", () => {
    expect(portalSide(facingSouth, 0, 2).ahead).toBeCloseTo(2);
    expect(portalSide(facingSouth, 0, -2).ahead).toBeCloseTo(-2);
  });

  it("take you through when you walk through the disc, not past it", () => {
    expect(walkedThrough(facingSouth, 0.3, 0.5, 0.3, -0.5)).toBe(true);
    expect(walkedThrough(facingSouth, 0.3, -0.5, 0.3, 0.5)).toBe(true);
    // Beside it, past a pillar.
    const wide = PORTAL_HALF_WIDTH + 0.5;
    expect(walkedThrough(facingSouth, wide, 0.5, wide, -0.5)).toBe(false);
    // Walking up to it, not through.
    expect(walkedThrough(facingSouth, 0, 2, 0, 0.5)).toBe(false);
  });

  it("puts you out in front of the portal back, facing away from it", () => {
    const arena = mapById("arena");
    const back = portalsOf(arena).find((p) => p.to === "home") as Portal;
    const at = arrivalOn(arena, "home");
    expect(portalSide(back, at.x, at.z).ahead).toBeGreaterThan(1.5);
    expect(at.heading).toBeCloseTo(back.yaw);
    // From an island with no portal back: its spawn.
    const spawn = arrivalOn(arena, "nowhere");
    expect([spawn.x, spawn.z]).toEqual(arena.spawn.at);
  });
});
