import { describe, expect, it } from "vitest";
import { buildingsOf } from "./map";
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
  it("link home and the training grounds both ways", () => {
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

describe("the cave's mouth", () => {
  const home = mapById("home");
  const mouth = portalsOf(home).find((p) => p.to === "bossroom") as Portal;
  /** A herzie is this wide either side of its middle (Player's RADIUS). */
  const BODY = 0.55;

  it("is a portal into the boss room, and back out again", () => {
    expect(mouth).toBeTruthy();
    const room = portalsOf(mapById("bossroom"));
    expect(room.map((p) => p.to)).toContain("home");
  });

  it("stands where a herzie's middle can actually cross it", () => {
    // The cave is solid up to its faces: find the nearest one behind the
    // portal, along the way it faces.
    const fx = Math.sin(mouth.yaw);
    const fz = Math.cos(mouth.yaw);
    const faces = buildingsOf(home)
      .filter((b) => b.kind === "cave")
      .flatMap((b) => b.rects)
      .flatMap((r) => [
        // Each rectangle's corners; the one nearest behind the portal.
        [r.x0, r.z0],
        [r.x0 + r.w, r.z0],
        [r.x0, r.z0 + r.h],
        [r.x0 + r.w, r.z0 + r.h],
      ])
      .map(([x, z]) => (mouth.x - x) * fx + (mouth.z - z) * fz)
      // Only faces behind the plane, within a cell or so.
      .filter((d) => d > 0 && d < 2);
    const gap = Math.min(...faces);
    expect(gap).toBeGreaterThan(BODY);
  });

  it("is crossed by walking in from the front as far as the body goes", () => {
    const fx = Math.sin(mouth.yaw);
    const fz = Math.cos(mouth.yaw);
    const before = { x: mouth.x + fx * 1, z: mouth.z + fz * 1 };
    const after = { x: mouth.x - fx * 0.1, z: mouth.z - fz * 0.1 };
    expect(walkedThrough(mouth, before.x, before.z, after.x, after.z)).toBe(
      true,
    );
  });
});
