import { describe, expect, it } from "vitest";
import { CLASS_DEFS, CLASS_IDS } from "./classes.js";
import {
  buildCreatureModel,
  CAST_ARM,
  creaturePoseOffsets,
  DRAW,
  HELD_ARM,
  MAIN_HELD,
  type Sphere,
} from "./creature-renderer.js";
import { type Equipped, getItem } from "./items.js";

const USER = "held-test-user";
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
        if (equipped.main_hand === "compact-discs") {
          // Stacked down the spine, past a stubby arm's reach: it gets well
          // over halfway, and the disc's caught the rest of the way.
          const from = Math.hypot(
            ...spheres[a].center.map((v, k) => v - handle[k]),
          );
          expect(gap).toBeLessThan(from * 0.6);
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
