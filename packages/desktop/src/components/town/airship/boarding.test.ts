import { inTownBounds } from "@herzies/shared";
import * as THREE from "three";
import { beforeEach, describe, expect, it } from "vitest";
import { worldRadius } from "../map";
import { mapById } from "../maps";
import { arriving, goToMap, townLive, townSave } from "../runtime";
import {
  crossAboard,
  crossAshore,
  gangwayAt,
  keepOnDeck,
  keepOnIsland,
  seeOffPlank,
  standY,
} from "./boarding";
import { onDeck } from "./deck";
import { fleet, updateFleet } from "./fleet";
import { acrossPlank, alongPlank, plankOf } from "./gangplank";
import { PLANK_IN_BY_S } from "./route";
import { setWildsService } from "./service";

const home = mapById("home");
const plank = plankOf(home);
if (!plank) throw new Error("home has no Sky Dock");
const p = plank;
const reach = worldRadius(home);
const DEPART_MS = 120_000;

/** The first moment from `from` the home dock's ship is in the state
 * `want` says (scanning the timetable in quarter seconds). */
function whenAtHome(
  want: (w: NonNullable<ReturnType<typeof gangwayAt>>) => boolean,
  from = 0,
): number {
  for (let t = from; t < from + 10 * DEPART_MS; t += 250) {
    updateFleet(t);
    const w = gangwayAt(home);
    if (w && want(w)) return t;
  }
  throw new Error("no such moment");
}

/** Where a herzie standing at (x, z) on `map` is in the sky. */
function sky(map: string, x: number, z: number): THREE.Vector3 {
  if (map === "airship")
    return new THREE.Vector3(x, 0, z).applyMatrix4(
      fleet.matrices[townSave.ship],
    );
  const [ox, oy, oz] = home.origin;
  return new THREE.Vector3(x + ox, standY(home, x, z) + oy, z + oz);
}
const out = { x: 0, z: 0 };
/** Step from where the save has the herzie by (dx, dz), as Player does:
 * kept where it may stand, then through the gangway if it's there. */
function step(dx: number, dz: number): void {
  const going = { vx: dx * 60, vz: dz * 60 };
  const { x, z } = townSave;
  if (townSave.map === "airship") {
    keepOnDeck(townSave.ship, x, z, x + dx, z + dz, out);
    townSave.x = out.x;
    townSave.z = out.z;
    crossAshore(townSave.ship, going);
  } else {
    keepOnIsland(home, reach, x, z, x + dx, z + dz, out);
    townSave.x = out.x;
    townSave.z = out.z;
    crossAboard(home, going);
  }
}

/** On the pier, a couple of steps short of the plank's foot, facing it. */
function onPier(): void {
  goToMap("home", {
    x: p.foot.x - p.dx * 2,
    z: p.foot.z - p.dz * 2,
    heading: Math.atan2(p.dx, p.dz),
  });
}

beforeEach(() => {
  setWildsService(
    { startsAt: 0, endsAt: 100 * DEPART_MS, departEveryMs: DEPART_MS },
    0,
  );
  townLive.glide = null;
});

describe("walking on and off a sky ship", () => {
  it("walks up the plank, aboard through the gangway, and back ashore", () => {
    updateFleet(whenAtHome((w) => w.boarding && w.open));
    onPier();
    const s = 1 / 60; // a step of a frame at walking pace, 60 u/s → 1/60 u
    let last = sky("home", townSave.x, townSave.z);
    for (let i = 0; i < 2000 && townSave.map === "home"; i++) {
      last = sky("home", townSave.x, townSave.z);
      // Every step on the island side is one its server takes.
      expect(inTownBounds("home", townSave.x, townSave.z)).toBe(true);
      step(p.dx * s * 3.6, p.dz * s * 3.6);
    }
    expect(townSave.map).toBe("airship");
    // Just inside the gangway, where the step left the plank: no jump.
    expect(onDeck(townSave.x, townSave.z)).toBe(true);
    expect(
      sky("airship", townSave.x, townSave.z).distanceTo(last),
    ).toBeLessThan(0.2);
    // Still going inboard: across the deck (−x), at the pace it was.
    expect(arriving.vx).toBeLessThan(-3);
    expect(Math.abs(arriving.vz)).toBeLessThan(0.5);

    // And back out the way it came.
    last = sky("airship", townSave.x, townSave.z);
    for (let i = 0; i < 2000 && townSave.map === "airship"; i++) {
      last = sky("airship", townSave.x, townSave.z);
      step(s * 3.6, 0);
    }
    expect(townSave.map).toBe("home");
    expect(sky("home", townSave.x, townSave.z).distanceTo(last)).toBeLessThan(
      0.2,
    );
    // On the plank, near its top, as high as the deck; out of the island's
    // edge but somewhere its server lets you be.
    const along = alongPlank(p, townSave.x, townSave.z);
    expect(along).toBeGreaterThan(p.length - 0.3);
    expect(Math.hypot(townSave.x, townSave.z)).toBeGreaterThan(reach);
    expect(inTownBounds("home", townSave.x, townSave.z)).toBe(true);
    expect(standY(home, townSave.x, townSave.z)).toBeGreaterThan(p.top - 0.2);
  });

  it("keeps you on the plank, not off its side into the sky", () => {
    updateFleet(whenAtHome((w) => w.boarding && w.open));
    goToMap("home", {
      x: p.foot.x + p.dx * 3,
      z: p.foot.z + p.dz * 3,
      heading: 0,
    });
    for (let i = 0; i < 120; i++) step(p.dz * 0.05, -p.dx * 0.05);
    expect(alongPlank(p, townSave.x, townSave.z)).toBeCloseTo(3, 3);
    expect(Math.abs(acrossPlank(p, townSave.x, townSave.z))).toBeLessThan(0.51);
    expect(townSave.map).toBe("home");
  });

  it("lets you up it at a slant, sliding along its side, never back", () => {
    // Walked in across it, 30–60° off its line, from either side: on at
    // its foot, then pressed against its far edge all the way up. Every
    // position goes through f32, as the physics hands it back, so the
    // edge it's clamped to is off by a few millionths half the time.
    const s = 3.6 / 60;
    for (const side of [1, -1])
      for (const deg of [30, 45, 60]) {
        updateFleet(whenAtHome((w) => w.boarding && w.open));
        const a = (deg * Math.PI) / 180;
        const ux = Math.cos(a) * p.dx + side * Math.sin(a) * p.dz;
        const uz = Math.cos(a) * p.dz - side * Math.sin(a) * p.dx;
        // On at its foot from one side, across its line a little way up.
        const from = 0.3 - 0.4 / Math.tan(a);
        goToMap("home", {
          x: p.foot.x + p.dx * from - side * 0.4 * p.dz,
          z: p.foot.z + p.dz * from + side * 0.4 * p.dx,
          heading: Math.atan2(ux, uz),
        });
        let along = alongPlank(p, townSave.x, townSave.z);
        for (let i = 0; i < 600 && townSave.map === "home"; i++) {
          const { x, z } = townSave;
          step(ux * s, uz * s);
          if (townSave.map !== "home") break;
          townSave.x = Math.fround(townSave.x);
          townSave.z = Math.fround(townSave.z);
          // Never further than the step, and never back down it.
          expect(Math.hypot(townSave.x - x, townSave.z - z)).toBeLessThan(
            s + 1e-4,
          );
          const now = alongPlank(p, townSave.x, townSave.z);
          expect(now).toBeGreaterThan(along - 1e-4);
          along = now;
        }
        expect(townSave.map).toBe("airship");
        townSave.ship = 0;
      }
  });

  it("shuts the gangway on a ship about to leave, and sees you off its plank", () => {
    // Out on the plank while it's open...
    const open = whenAtHome((w) => w.boarding && w.open);
    updateFleet(open);
    goToMap("home", {
      x: p.foot.x + p.dx * 3.5,
      z: p.foot.z + p.dz * 3.5,
      heading: 0,
    });
    // ...till it closes: as the plank starts in, ahead of the countdown.
    const closing = whenAtHome((w) => !w.open, open);
    updateFleet(closing);
    const st = fleet.poses[0].state;
    expect(st.kind === "docked" && st.until !== null).toBe(true);
    if (st.kind === "docked" && st.until !== null)
      expect(st.until - closing).toBeGreaterThan(PLANK_IN_BY_S * 1000);
    // No further up it, and nobody aboard.
    for (let i = 0; i < 200; i++) step(p.dx * 0.05, p.dz * 0.05);
    expect(townSave.map).toBe("home");
    expect(alongPlank(p, townSave.x, townSave.z)).toBeCloseTo(3.5, 3);
    // Seen down to the pier.
    seeOffPlank(home, reach);
    const g = townLive.glide;
    expect(g).not.toBeNull();
    if (g) expect(Math.hypot(g.x, g.z)).toBeLessThan(reach);
  });
});
