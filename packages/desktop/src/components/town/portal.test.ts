import { describe, expect, it } from "vitest";
import { buildingsOf } from "./map";
import { mapById } from "./maps";
import {
  arrivalOn,
  PORTAL_HALF_WIDTH,
  PORTAL_REACH,
  type Portal,
  portalSide,
  portalsOf,
  walkedThrough,
} from "./portal";
import { TOWER_PLINTH, towerPlace } from "./towerPlan";

const facingSouth: Portal = {
  key: "0,0",
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  to: "home",
};

describe("portals", () => {
  it("lead from home to islands that lead back home", () => {
    // Which islands home opens onto is the map's call; every one must have
    // a way back.
    const home = portalsOf(mapById("home"));
    expect(home.length).toBeGreaterThan(0);
    for (const p of home) {
      const back = portalsOf(mapById(p.to)).map((q) => q.to);
      expect(back, p.to).toContain("home");
    }
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
    const cave = mapById("bossroom");
    const back = portalsOf(cave).find((p) => p.to === "home") as Portal;
    const at = arrivalOn(cave, "home");
    expect(portalSide(back, at.x, at.z).ahead).toBeGreaterThan(1.5);
    expect(at.heading).toBeCloseTo(back.yaw);
    // From an island with no portal back: its spawn.
    const spawn = arrivalOn(cave, "nowhere");
    expect([spawn.x, spawn.z]).toEqual(cave.spawn.at);
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

describe("the Tower's door", () => {
  const home = mapById("home");
  const door = portalsOf(home).find((p) => p.door) as Portal;
  const tower = buildingsOf(home).find((b) => b.kind === "tower");
  /** A herzie is this wide either side of its middle (Player's RADIUS). */
  const BODY = 0.55;

  it("is home's way into the Tower, now there's no portal disc for it", () => {
    expect(door).toMatchObject({ to: "tower", door: true });
    expect(portalsOf(home).filter((p) => p.to === "tower" && !p.door)).toEqual(
      [],
    );
    // And the Tower still leads back home.
    expect(portalsOf(mapById("tower")).map((p) => p.to)).toContain("home");
  });

  it("is reached with E from where a herzie can stand, in front of the porch", () => {
    if (!tower) throw new Error("no tower");
    const at = towerPlace(tower);
    // The tower's behind it.
    expect(portalSide(door, at.x, at.z).ahead).toBeLessThan(0);
    // Pressed up against the tower, straight in front of the door, and a
    // step back from there: in reach either way.
    for (const back of [0, 1.5]) {
      const out = TOWER_PLINTH + BODY + back;
      const x = at.x + Math.sin(door.yaw) * out;
      const z = at.z + Math.cos(door.yaw) * out;
      expect(Math.hypot(x - door.x, z - door.z)).toBeLessThan(PORTAL_REACH);
    }
  });

  it("never takes you in for walking past or into the wall beside it", () => {
    // Across its plane, right through where a disc would be.
    const fx = Math.sin(door.yaw);
    const fz = Math.cos(door.yaw);
    expect(
      walkedThrough(
        door,
        door.x + fx,
        door.z + fz,
        door.x - fx * 0.2,
        door.z - fz * 0.2,
      ),
    ).toBe(false);
  });

  it("lets you out of the Tower in front of it, facing away from it", () => {
    if (!tower) throw new Error("no tower");
    const out = arrivalOn(home, "tower");
    expect(out.heading).toBeCloseTo(door.yaw);
    expect(portalSide(door, out.x, out.z).ahead).toBeGreaterThan(1.5);
    // Clear of the tower itself.
    const at = towerPlace(tower);
    expect(Math.hypot(out.x - at.x, out.z - at.z)).toBeGreaterThan(
      TOWER_PLINTH + BODY,
    );
  });
});
