import { describe, expect, it } from "vitest";
import { emptyMap, type TownMap } from "../map";
import { DISC, type Disc, DiscField, type DiscHooks, nextHand } from "./discs";
import { DUMMY, type DummyState, dummiesOf } from "./dummy";
import type { Vec3 } from "./waves";

function withDummy(x = 0, z = 0): DummyState {
  const map: TownMap = emptyMap(40, "test", "Test");
  const col = 20 + Math.floor(x);
  const row = 20 + Math.floor(z);
  const r = map.objects[row];
  map.objects[row] = `${r.slice(0, col)}D${r.slice(col + 1)}`;
  return dummiesOf(map)[0];
}

const DT = 1 / 120;

/** Steps `field` until nothing's in flight (or `max` seconds), with the
 * hand at `hand()` (it may move). Counts what happens. */
function fly(
  field: DiscField,
  dummies: DummyState[],
  hand: (t: number) => Vec3,
  max = 4,
) {
  const got = {
    hits: 0,
    catches: 0,
    strikes: 0,
    caughtAt: -1,
    path: [] as Vec3[],
  };
  let t = 0;
  const hooks: DiscHooks = {
    handAt: (_d: Disc, out: Vec3) => {
      const h = hand(t);
      out[0] = h[0];
      out[1] = h[1];
      out[2] = h[2];
      return out;
    },
    onHit: () => {
      got.hits++;
      return "hit";
    },
    onStrike: () => {
      got.strikes++;
    },
    onCatch: () => {
      got.catches++;
      got.caughtAt = t;
    },
  };
  while (t < max && field.discs.some((d) => d.alive)) {
    t += DT;
    field.step(DT, dummies, hooks);
    const d = field.discs.find((x) => x.alive);
    if (d) got.path.push([...d.pos] as Vec3);
  }
  return got;
}

const OWNER = {};
const FROM: Vec3 = [0, 1.2, 0];

describe("a thrown disc", () => {
  it("goes out to its reach and comes back to the hand", () => {
    const f = new DiscField();
    f.throw(FROM, [0, 0, 1], { mine: true, owner: OWNER, hand: "held-l" });
    expect(f.isOut(OWNER, "held-l")).toBe(true);
    const got = fly(f, [], () => FROM);
    expect(got.catches).toBe(1);
    expect(f.isOut(OWNER, "held-l")).toBe(false);
    const far = Math.max(...got.path.map((p) => p[2]));
    expect(far).toBeGreaterThan(DISC.range);
    expect(far).toBeLessThan(DISC.range + DISC.overshoot + 0.01);
  });

  it("comes back to a hand that moved", () => {
    const f = new DiscField();
    f.throw(FROM, [0, 0, 1], { mine: true, owner: OWNER, hand: "held-l" });
    // Strafing sideways the whole time, 5 units a second.
    const hand = (t: number): Vec3 => [5 * t, 1.2, 0];
    const got = fly(f, [], hand);
    expect(got.catches).toBe(1);
    // Its last step before the catch was next to where the hand had got
    // to (metres from where it was thrown), not where it was thrown from.
    const last = got.path[got.path.length - 1];
    const h = hand(got.caughtAt);
    expect(h[0]).toBeGreaterThan(5);
    expect(
      Math.hypot(last[0] - h[0], last[1] - h[1], last[2] - h[2]),
    ).toBeLessThan(1);
  });

  it("bows out to its own hand's side on the way back", () => {
    const side = (hand: "held-l" | "held-r") => {
      const f = new DiscField();
      f.throw(FROM, [0, 0, 1], { mine: true, owner: OWNER, hand });
      const got = fly(f, [], () => FROM);
      // Facing +z, the thrower's right is −x.
      return Math.min(...got.path.map((p) => p[0])) < -1
        ? "right"
        : Math.max(...got.path.map((p) => p[0])) > 1
          ? "left"
          : "straight";
    };
    expect(side("held-l")).toBe("right");
    expect(side("held-r")).toBe("left");
  });

  it("hits only on the way out, and comes back sooner off a hit", () => {
    const dummy = withDummy(0, 8);
    const f = new DiscField();
    const dir: Vec3 = [
      dummy.x - FROM[0],
      DUMMY.chest - FROM[1],
      dummy.z - FROM[2],
    ];
    f.throw(FROM, dir, {
      mine: true,
      owner: OWNER,
      hand: "held-l",
      target: dummy,
    });
    const got = fly(f, [dummy], () => FROM);
    // Its way back passes right through the dummy again: still one hit.
    expect(got.hits).toBe(1);
    expect(got.catches).toBe(1);

    const open = new DiscField();
    open.throw(FROM, [0, 0, 1], { mine: true, owner: OWNER, hand: "held-l" });
    const full = fly(open, [], () => FROM);
    expect(got.caughtAt).toBeLessThan(full.caughtAt * 0.6);
  });

  it("stops short at a wall, clinks, and comes back", () => {
    const f = new DiscField();
    f.throw(FROM, [0, 0, 1], {
      mine: true,
      owner: OWNER,
      hand: "held-l",
      reach: 5,
      strike: "wall",
    });
    const clinked = { at: -1 };
    for (let t = 0; t < 0.3 && clinked.at < 0; t += DT) {
      f.step(DT, [], { handAt: (_d, out) => out, onHit: () => "hit" });
      if (f.sparks.some((s) => s.alive && s.kind === "clink")) clinked.at = t;
    }
    expect(clinked.at).toBeGreaterThan(0);
    const got = fly(f, [], () => FROM);
    expect(Math.max(...got.path.map((p) => p[2]))).toBeLessThan(5.01);
    expect(got.catches).toBe(1);
  });

  it("strikes what it was thrown at (the boss) at the end of its reach", () => {
    const f = new DiscField();
    f.throw(FROM, [0, 0, 1], {
      mine: true,
      owner: OWNER,
      hand: "held-l",
      reach: 10,
      strike: "target",
    });
    const got = fly(f, [], () => FROM);
    expect(got.strikes).toBe(1);
    expect(got.catches).toBe(1);
  });

  it("lands on the server's beat: out at DISC.speed", () => {
    const dummy = withDummy(0, 12);
    const f = new DiscField();
    f.throw(FROM, [0, DUMMY.chest - FROM[1], dummy.z], {
      mine: true,
      owner: OWNER,
      hand: "held-l",
      target: dummy,
    });
    let t = 0;
    let hitAt = -1;
    while (t < 2 && hitAt < 0) {
      t += DT;
      f.step(DT, [dummy], {
        handAt: (_d, out) => out,
        onHit: () => {
          hitAt = t;
          return "hit";
        },
      });
    }
    const dist = 12 - DUMMY.radius - DISC.hitRadius;
    expect(hitAt).toBeGreaterThan(0);
    expect(Math.abs(hitAt - dist / DISC.speed)).toBeLessThan(0.03);
  });
});

describe("throwing with both hands", () => {
  it("throws the main hand first, then the other, then waits", () => {
    const f = new DiscField();
    expect(nextHand(f, OWNER)).toBe("held-l");
    f.throw(FROM, [0, 0, 1], { mine: true, owner: OWNER, hand: "held-l" });
    expect(nextHand(f, OWNER)).toBe("held-r");
    f.throw(FROM, [0, 0, 1], { mine: true, owner: OWNER, hand: "held-r" });
    expect(nextHand(f, OWNER)).toBe(null);
    // Someone else's hands are their own.
    expect(nextHand(f, {})).toBe("held-l");
  });

  it("someone else's throw never waits on our idea of their catch", () => {
    const f = new DiscField();
    const them = {};
    f.throw(FROM, [0, 0, 1], { mine: false, owner: them, hand: "held-l" });
    f.throw(FROM, [1, 0, 0], { mine: false, owner: them, hand: "held-l" });
    expect(f.discs.filter((d) => d.alive)).toHaveLength(1);
    expect(f.discs.find((d) => d.alive)?.dir[0]).toBe(1);
  });

  it("recalls everything of one owner's at once", () => {
    const f = new DiscField();
    const them = {};
    f.throw(FROM, [0, 0, 1], { mine: true, owner: OWNER, hand: "held-l" });
    f.throw(FROM, [0, 0, 1], { mine: true, owner: OWNER, hand: "held-r" });
    f.throw(FROM, [0, 0, 1], { mine: false, owner: them, hand: "held-l" });
    f.recall(OWNER);
    expect(f.isOut(OWNER, "held-l")).toBe(false);
    expect(f.isOut(OWNER, "held-r")).toBe(false);
    expect(f.isOut(them, "held-l")).toBe(true);
  });
});
