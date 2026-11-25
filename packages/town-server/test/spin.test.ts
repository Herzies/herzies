import { MULTISPIN, multispinOffset } from "@herzies/shared/skills";
import { describe, expect, it } from "vitest";
import { Spin } from "../src/spin";

const T0 = 1_000_000;
const here = () => ({ x: 0, z: 0 });

describe("Multispin's records", () => {
  it("follow multispinOffset round their Slinger, wherever it stands", () => {
    const spin = new Spin(T0, T0 + 8_000, 3);
    // A small body right where record 1 is 300 ms in, round a Slinger at
    // (5, 5).
    const at = multispinOffset(1, 3, 300);
    const touches = spin.touches(T0 + 300, () => ({ x: 5, z: 5 }), [
      { key: "b", x: 5 + at.x, z: 5 + at.z, r: 0.01 },
    ]);
    expect(touches.map((t) => t.record)).toContain(1);
  });

  it("can't pass through a body between two slow steps", () => {
    const spin = new Spin(T0, T0 + 8_000, 1);
    // A quarter turn in: one look a second would miss it.
    const at = multispinOffset(0, 1, MULTISPIN.turnMs / 4);
    const touches = spin.touches(T0 + 1_000, here, [
      { key: "b", x: at.x, z: at.z, r: 0.01 },
    ]);
    expect(touches).toHaveLength(1);
  });

  it("touches the same body again only after rehitMs", () => {
    const spin = new Spin(T0, T0 + 8_000, 1);
    // Wide enough to cover the whole orbit: always touching.
    const body = { key: "boss", x: 0, z: 0, r: MULTISPIN.radius + 1 };
    const at: number[] = [];
    for (let t = T0 + 50; t <= T0 + 2_000; t += 50)
      for (const touch of spin.touches(t, here, [body])) at.push(touch.at);
    expect(at.length).toBe(Math.ceil(2_000 / MULTISPIN.rehitMs));
    for (let i = 1; i < at.length; i++)
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(MULTISPIN.rehitMs);
  });

  it("stops at its end", () => {
    const spin = new Spin(T0, T0 + 1_000, 1);
    const body = { key: "boss", x: 0, z: 0, r: MULTISPIN.radius + 1 };
    spin.touches(T0 + 900, here, [body]);
    expect(spin.over(T0 + 1_000)).toBe(true);
    expect(spin.touches(T0 + 5_000, here, [body])).toEqual([]);
  });

  it("touches a body hugging its Slinger as each record sweeps past its bearing", () => {
    const spin = new Spin(T0, T0 + 8_000, 3);
    // Well inside the ring, where no record ever overlaps it.
    const hugging = { key: "mob", x: 0, z: 0.2, r: 0.1 };
    const at: number[] = [];
    for (let t = T0 + 50; t <= T0 + MULTISPIN.turnMs; t += 50)
      for (const touch of spin.touches(t, here, [hugging])) at.push(touch.at);
    // Each record once a turn.
    expect(at).toHaveLength(3);
    // Out past the ring, nothing.
    const out = new Spin(T0, T0 + 8_000, 3);
    const far = { key: "far", x: 0, z: MULTISPIN.radius + 1, r: 0.1 };
    for (let t = T0 + 50; t <= T0 + MULTISPIN.turnMs; t += 50)
      expect(out.touches(t, here, [far])).toEqual([]);
  });
});
