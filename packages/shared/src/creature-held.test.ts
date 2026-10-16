import { describe, expect, it } from "vitest";
import { CLASS_DEFS, CLASS_IDS } from "./classes.js";
import {
  buildCreatureModel,
  CAST,
  CAST_ARM,
  castHand,
  creaturePoseOffsets,
  DRAW,
  HELD_ARM,
  heldPoses,
  heldSwing,
  MAIN_HELD,
  OFF_HELD,
  type Sphere,
} from "./creature-renderer.js";
import { type Equipped, getItem } from "./items.js";

const USER = "held-test-user";
/** Which side of the herzie (creature x) the casting arm is on. */
const LIMB_SIDE_OF_CAST = castHand(0.5, 0, CAST_ARM, "strike").dir[0];
const PERCUSSIONIST: Equipped = {
  main_hand: "worn-stick",
  off_hand: "old-cymbal",
};

const centroid = (spheres: Sphere[], offsets: number[][], part: string) => {
  const at = [0, 0, 0];
  let n = 0;
  spheres.forEach((s, i) => {
    if (s.part !== part) return;
    for (let k = 0; k < 3; k++) at[k] += s.center[k] + offsets[i][k];
    n++;
  });
  return at.map((v) => v / n);
};

describe("held class equipment", () => {
  it("puts the main hand's gear in the casting arm", () => {
    expect(HELD_ARM[MAIN_HELD]).toBe(CAST_ARM);
  });

  it("holds nothing at stage 1, which has no arms", () => {
    const { spheres } = buildCreatureModel(USER, 1, PERCUSSIONIST);
    expect(spheres.some((s) => s.part in HELD_ARM)).toBe(false);
  });

  it("gives each held item its own parts, never the arm's", () => {
    for (const stage of [2, 3]) {
      const { spheres } = buildCreatureModel(USER, stage, PERCUSSIONIST);
      expect(spheres.filter((s) => s.part === "arm-l")).toHaveLength(1);
      expect(spheres.filter((s) => s.part === "arm-r")).toHaveLength(1);
      expect(spheres.some((s) => s.part === "held-l")).toBe(true);
      expect(spheres.some((s) => s.part === "held-r")).toBe(true);
    }
  });

  it("draws a disc in each hand from one Compact Discs item", () => {
    const { spheres } = buildCreatureModel(USER, 2, {
      main_hand: "compact-discs",
    });
    expect(spheres.some((s) => s.part === "held-l")).toBe(true);
    expect(spheres.some((s) => s.part === "held-r")).toBe(true);
  });

  it("polishes the cymbal, not its patina or the stick", () => {
    const { spheres } = buildCreatureModel(USER, 3, PERCUSSIONIST);
    const metal = (part: string) =>
      spheres.filter((s) => s.part === part).map((s) => s.finish);
    // Disc and bell shine; the verdigris stays dull.
    expect(metal(OFF_HELD)).toEqual(["metal", "metal", undefined]);
    expect(metal(MAIN_HELD).every((f) => f === undefined)).toBe(true);
  });

  it("keeps a prop the same distance from its arm through a cast", () => {
    const { spheres } = buildCreatureModel(USER, 3, PERCUSSIONIST);
    const rest = creaturePoseOffsets(spheres, 3, {
      idleFrame: 0,
      walkPhase: 0,
      walkWeight: 0,
      drawPhase: 1,
    });
    const gap = (offsets: number[][]) => {
      const arm = centroid(spheres, offsets, CAST_ARM);
      const prop = centroid(spheres, offsets, MAIN_HELD);
      return Math.hypot(...arm.map((v, k) => v - prop[k]));
    };
    const casting = creaturePoseOffsets(spheres, 3, {
      idleFrame: 0,
      walkPhase: 0,
      walkWeight: 0,
      castPhase: 0.5,
      drawPhase: 1,
    });
    // The arm moved…
    const arm = spheres.findIndex((s) => s.part === CAST_ARM);
    expect(Math.hypot(...casting[arm])).toBeGreaterThan(0.01);
    // …and the stick came with it. (A cast stretches the arm a little, so
    // the gap scales with it rather than staying exact.)
    expect(gap(casting)).toBeGreaterThan(gap(rest) * 0.7);
    expect(gap(casting)).toBeLessThan(gap(rest) * 1.6);
  });

  it("holds the cymbal at its side and the stick like a wand, drawn", () => {
    for (const stage of [2, 3]) {
      const { spheres } = buildCreatureModel(USER, stage, PERCUSSIONIST);
      const offsets = creaturePoseOffsets(spheres, stage, {
        idleFrame: 0,
        walkPhase: 0,
        walkWeight: 0,
        drawPhase: 1,
      });
      const poses = heldPoses(spheres, offsets, 1);
      const unit = (v: number[]) => {
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
      };
      // The cymbal (its biggest disc) faces out from its side (the off
      // hand's, +x): edge to the front.
      const cymbal = spheres
        .filter((s) => s.part === OFF_HELD)
        .sort((a, b) => b.radius - a.radius)[0];
      if (!cymbal?.shape) throw new Error("no cymbal");
      const face = unit(
        poses[OFF_HELD].turn(cymbal.shape.axis as [number, number, number]),
      );
      expect(face[0]).toBeGreaterThan(0.9);
      // The stick points forward (−z) and a little down (+y).
      const stick = spheres.find(
        (s) => s.part === MAIN_HELD && s.shape?.kind === "capsule",
      );
      if (!stick?.shape) throw new Error("no stick");
      let along = unit(
        poses[MAIN_HELD].turn(stick.shape.axis as [number, number, number]),
      );
      if (along[2] > 0) along = along.map((x) => -x);
      expect(along[2]).toBeLessThan(-0.85);
      expect(along[1]).toBeGreaterThan(0.1);
      expect(along[1]).toBeLessThan(0.5);
    }
  });

  it("throws a disc with its other hand: that arm moves, not the casting one", () => {
    const { spheres } = buildCreatureModel(USER, 3, {
      main_hand: "compact-discs",
    });
    const pose = (castArm?: string) =>
      creaturePoseOffsets(spheres, 3, {
        idleFrame: 0,
        walkPhase: 0,
        walkWeight: 0,
        castPhase: CAST.release,
        castArm,
        castStyle: "throw",
        drawPhase: 1,
      });
    const rest = creaturePoseOffsets(spheres, 3, {
      idleFrame: 0,
      walkPhase: 0,
      walkWeight: 0,
      drawPhase: 1,
    });
    const moved = (offsets: number[][], part: string) => {
      const i = spheres.findIndex((s) => s.part === part);
      return Math.hypot(...offsets[i].map((v, k) => v - rest[i][k]));
    };
    // (Both lean into it, so both arms move some.)
    const off = pose("arm-r");
    const main = pose();
    expect(moved(off, "arm-r")).toBeGreaterThan(moved(main, "arm-r") * 1.5);
    expect(moved(main, "arm-l")).toBeGreaterThan(moved(off, "arm-l") * 1.5);
  });

  it("throws out front, mirrored by hand, letting go on the cast's beat", () => {
    for (const arm of ["arm-l", "arm-r"]) {
      const out = castHand(CAST.release, 0, arm, "throw");
      // Front is −z in creature space; the hand's past the arm's rest.
      expect(out.dir[2]).toBeLessThan(-0.8);
      expect(out.reach).toBeGreaterThan(1.2);
    }
    const l = castHand(CAST.release, 0, "arm-l", "throw");
    const r = castHand(CAST.release, 0, "arm-r", "throw");
    expect(l.dir[0]).toBeCloseTo(-r.dir[0]);
    // The wind-up crosses the chest: toward the other side.
    const wound = castHand(CAST.drawn, 0, "arm-r", "throw");
    expect(wound.dir[0]).toBeLessThan(0);
  });

  it("sweeps level through the front, landing on the cast's beat", () => {
    const side = Math.sign(castHand(0.5, 0, CAST_ARM, "strike").dir[0]) || 1;
    const wound = castHand(CAST.drawn, 0, CAST_ARM, "strike");
    const struck = castHand(CAST.release, 0, CAST_ARM, "strike");
    const follow = castHand(CAST.held, 0, CAST_ARM, "strike");
    // Cocked out and back by its own shoulder…
    expect(wound.dir[0] * side).toBeGreaterThan(0.5);
    expect(wound.dir[2]).toBeGreaterThan(0.2);
    // …out front and near level as it lands (y is down: never a chop at
    // the ground)…
    expect(struck.dir[2]).toBeLessThan(-0.9);
    expect(Math.abs(struck.dir[1])).toBeLessThan(0.15);
    // …and still out front after: its arm's too short to cross its body
    // (the wrist carries the stick on across).
    expect(follow.dir[2]).toBeLessThan(-0.8);
    expect(castHand(1, 0, CAST_ARM, "strike").reach).toBeCloseTo(1);
    // The other arm swings the mirror of it.
    const other = castHand(CAST.release, 0, "arm-r", "strike");
    expect(other.dir[0]).toBeCloseTo(-struck.dir[0]);
  });

  it("swings the stick like a blade, rigid, and clear of the body", () => {
    for (const stage of [2, 3]) {
      const { spheres } = buildCreatureModel(USER, stage, PERCUSSIONIST);
      const stick = spheres.find(
        (s) => s.part === MAIN_HELD && s.shape?.kind === "capsule",
      );
      const tip = spheres.find((s) => s.part === MAIN_HELD && !s.shape);
      // What the hand mustn't pass through: the head, and the body below
      // it (a stage 2 herzie is all head).
      const trunk = spheres.filter(
        (s) => (s.part === "body" || s.part === "head") && !s.shape,
      );
      const arm = spheres.findIndex((s) => s.part === CAST_ARM);
      if (!stick?.shape || !tip) throw new Error("no stick");
      for (let phase = 0; phase <= 1.0001; phase += 0.05) {
        const motion = {
          idleFrame: 0,
          walkPhase: 0,
          walkWeight: 0,
          drawPhase: 1,
          castPhase: phase,
          castStyle: "strike" as const,
        };
        const offsets = creaturePoseOffsets(spheres, stage, motion);
        const pose = heldPoses(
          spheres,
          offsets,
          1,
          undefined,
          heldSwing(motion),
        )[MAIN_HELD];
        const at = (s: Sphere) => {
          const i = spheres.indexOf(s);
          return s.center.map((v, k) => v + offsets[i][k]);
        };
        // The tip stays on the end of the shaft: the offsets that place it
        // and the turn that aims the shaft agree.
        const along = pose.turn(stick.shape.axis);
        const end = at(stick).map((v, k) => v + along[k]);
        expect(Math.hypot(...end.map((v, k) => v - at(tip)[k]))).toBeLessThan(
          stick.radius * 0.05,
        );
        // The swinging hand never passes through the body.
        const hand = at(spheres[arm]);
        for (const t of trunk) {
          const gap = Math.hypot(...hand.map((v, k) => v - at(t)[k]));
          // (Its middle may graze the surface: arms are set into it.)
          expect(gap).toBeGreaterThan(t.radius * 0.95);
        }
        // Rolled over after the blow, the stick lies across the body.
        if (Math.abs(phase - CAST.held) < 0.026) {
          const n = Math.hypot(...along);
          expect((along[0] / n) * Math.sign(LIMB_SIDE_OF_CAST)).toBeLessThan(
            -0.3,
          );
        }
        if (Math.abs(phase - CAST.release) < 0.026) {
          // As it lands, the stick reaches out ahead, level or raised (y
          // is down) — not at the ground.
          const n = Math.hypot(...along);
          expect(along[2] / n).toBeLessThan(-0.6);
          expect(along[1] / n).toBeLessThan(0.05);
        }
      }
    }
  });

  it("bumps the whole body forward, arms and all, and back", () => {
    for (const stage of [1, 2]) {
      const { spheres } = buildCreatureModel(USER, stage);
      const at = (castPhase?: number) =>
        creaturePoseOffsets(spheres, stage, {
          idleFrame: 0,
          walkPhase: 0,
          walkWeight: 0,
          castPhase,
          castStyle: "bump",
        });
      const rest = at();
      const hit = at(CAST.release);
      const body = spheres.findIndex(
        (s) => s.part === "body" || s.part === "head",
      );
      // Forward is −z.
      expect(hit[body][2]).toBeLessThan(rest[body][2] - 0.05);
      // An arm goes with the body rather than reaching out on its own.
      const arm = spheres.findIndex((s) => s.part === CAST_ARM);
      if (arm >= 0) {
        expect(hit[arm][2] - rest[arm][2]).toBeCloseTo(
          hit[body][2] - rest[body][2],
          1,
        );
      }
      const done = at(0.999);
      expect(done[body][2]).toBeCloseTo(rest[body][2], 1);
    }
  });

  it("jolts the catching arm back, then lets it go", () => {
    const { spheres } = buildCreatureModel(USER, 3, {
      main_hand: "compact-discs",
    });
    const at = (catchPhase?: number) =>
      creaturePoseOffsets(spheres, 3, {
        idleFrame: 0,
        walkPhase: 0,
        walkWeight: 0,
        drawPhase: 1,
        catchPhase,
        catchArm: "arm-r",
      });
    const i = spheres.findIndex((s) => s.part === "arm-r");
    const rest = at();
    expect(at(0.25)[i][2]).toBeGreaterThan(rest[i][2]);
    expect(at(1)[i][2]).toBeCloseTo(rest[i][2], 1);
  });

  const GEAR: Equipped[] = [
    PERCUSSIONIST,
    { main_hand: "lute" },
    { main_hand: "compact-discs" },
  ];
  const posed = (spheres: Sphere[], drawPhase: number) => {
    const offsets = creaturePoseOffsets(spheres, 3, {
      idleFrame: 0,
      walkPhase: 0,
      walkWeight: 0,
      drawPhase,
    });
    return spheres.map((s, i) => s.center.map((v, k) => v + offsets[i][k]));
  };

  it("slings its gear on its back, touching it, at rest", () => {
    for (const equipped of GEAR) {
      const { spheres } = buildCreatureModel(USER, 3, equipped);
      const body = spheres.find((s) => s.part === "body");
      if (!body) throw new Error("no body");
      const props = spheres.filter((s) => s.part in HELD_ARM);
      for (const s of props)
        expect(s.center[2]).toBeGreaterThan(body.center[2]);
      // The nearest of it is against the body, not floating off it.
      const gap = Math.min(
        ...props.map(
          (s) =>
            Math.hypot(...s.center.map((v, k) => v - body.center[k])) -
            body.radius -
            s.radius,
        ),
      );
      expect(gap).toBeLessThan(body.radius * 0.15);
    }
  });

  it("draws it into its hands", () => {
    for (const equipped of GEAR) {
      const { spheres } = buildCreatureModel(USER, 3, equipped);
      const at = posed(spheres, 1);
      for (const [part, arm] of Object.entries(HELD_ARM)) {
        const i = spheres.findIndex((s) => s.part === part);
        if (i < 0) continue;
        const socket = spheres[i].held;
        if (!socket) throw new Error("no socket");
        // The palm (at the arm's end) holds the prop where it was built.
        const a = spheres.findIndex((s) => s.part === arm);
        const hand = at[a];
        const prop = centroid(
          spheres,
          spheres.map((s, k) => at[k].map((v, n) => v - s.center[n])),
          part,
        );
        const reach = Math.hypot(...prop.map((v, k) => v - hand[k]));
        expect(reach).toBeLessThan(spheres[a].radius * 4);
      }
    }
  });

  it("keeps it rigid and never jumps, all the way through the draw", () => {
    for (const equipped of GEAR) {
      const { spheres } = buildCreatureModel(USER, 3, equipped);
      const held = spheres
        .map((_, i) => i)
        .filter((i) => spheres[i].part in HELD_ARM);
      const span = (at: number[][]) =>
        Math.hypot(...at[held[0]].map((v, k) => v - at[held[1]][k]));
      const restSpan = span(posed(spheres, 0));
      let prev = posed(spheres, 0);
      const steps = new Map<number, number[]>(held.map((i) => [i, []]));
      for (let p = 0.01; p <= 1.0001; p += 0.01) {
        const now = posed(spheres, p);
        for (const i of held) {
          steps
            .get(i)
            ?.push(Math.hypot(...now[i].map((v, k) => v - prev[i][k])));
        }
        // Same part: its spheres hold their places on it.
        if (spheres[held[0]].part === spheres[held[1]].part)
          expect(Math.abs(span(now) - restSpan)).toBeLessThan(1e-6);
        prev = now;
      }
      // Quick mid-swing, but no pop (the socket swap snapping it across, or
      // its turn flipping round the other way): a hundredth of the draw
      // never moves any of it 0.6 of the body, nor spikes past both steps
      // either side of it — eased motion speeds up and slows down smoothly.
      const body = spheres.find((s) => s.part === "body");
      if (!body) throw new Error("no body");
      for (const run of steps.values()) {
        run.forEach((step, k) => {
          expect(step).toBeLessThan(body.radius * 0.6);
          const near = Math.max(run[k - 1] ?? 0, run[k + 1] ?? 0);
          expect(step).toBeLessThan(near * 3 + 0.02);
        });
      }
    }
  });

  it("leaves it on the back until the hand has it", () => {
    for (const equipped of GEAR) {
      const { spheres } = buildCreatureModel(USER, 3, equipped);
      const rest = posed(spheres, 0);
      const before = posed(spheres, DRAW.grab * 0.99);
      const body = spheres.findIndex((s) => s.part === "body");
      const ride = before[body].map((v, k) => v - rest[body][k]);
      spheres.forEach((s, i) => {
        if (!(s.part in HELD_ARM)) return;
        for (let k = 0; k < 3; k++)
          expect(before[i][k]).toBeCloseTo(rest[i][k] + ride[k], 6);
      });
    }
  });

  it("reaches the handle on its back when it takes hold", () => {
    for (const equipped of GEAR) {
      const { spheres } = buildCreatureModel(USER, 3, equipped);
      const at = posed(spheres, DRAW.grab);
      const body = spheres.findIndex((s) => s.part === "body");
      const ride = at[body].map((v, k) => v - spheres[body].center[k]);
      for (const [part, arm] of Object.entries(HELD_ARM)) {
        const socket = spheres.find((s) => s.part === part)?.held;
        if (!socket) continue;
        const a = spheres.findIndex((s) => s.part === arm);
        // The off hand draws a beat later: catch it at its own grab.
        const when =
          part === MAIN_HELD
            ? at
            : posed(spheres, DRAW.stagger + DRAW.grab * (1 - DRAW.stagger));
        const handle = socket.handle.map((v, k) => v + ride[k]);
        const gap = Math.hypot(...when[a].map((v, k) => v - handle[k]));
        if (equipped.main_hand !== "lute") {
          // Stacked down the spine (the discs, or the stick under the
          // cymbal), past a stubby arm's reach: it gets well over halfway,
          // and the prop's caught the rest of the way.
          const from = Math.hypot(
            ...spheres[a].center.map((v, k) => v - handle[k]),
          );
          expect(gap).toBeLessThan(from * 0.65);
          continue;
        }
        // The palm is just past the arm's middle: the arm's own size away.
        expect(gap).toBeLessThan(spheres[a].radius * 1.8);
      }
    }
  });

  it("slings every class's gear on its back", () => {
    for (const id of CLASS_IDS) {
      const equipped: Equipped = {};
      for (const item of CLASS_DEFS[id].equipment) {
        const slot = getItem(item)?.equipSlot;
        if (slot !== "main_hand" && slot !== "off_hand")
          throw new Error(`${item} isn't held`);
        equipped[slot] = item;
      }
      const { spheres } = buildCreatureModel(USER, 3, equipped);
      const body = spheres.find((s) => s.part === "body");
      if (!body) throw new Error("no body");
      const props = spheres.filter((s) => s.part in HELD_ARM);
      // Built (a new class's gear needs a builder) and slung, every piece.
      expect(props.length, id).toBeGreaterThan(0);
      for (const s of props) {
        expect(s.held, id).toBeDefined();
        expect(s.center[2], id).toBeGreaterThan(body.center[2]);
      }
    }
  });
});
