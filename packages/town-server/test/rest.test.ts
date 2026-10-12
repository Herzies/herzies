import { describe, expect, it } from "vitest";
import { MAX_REST_GAP_MS, RestMeter } from "../src/rest";

describe("RestMeter", () => {
  it("counts only the time spent sitting", () => {
    const m = new RestMeter();
    m.tick(false, 0);
    m.tick(true, 1_000); // sat down
    m.tick(false, 11_000); // stood up after 10s
    m.tick(false, 20_000);
    expect(m.take()).toBeCloseTo(10);
    expect(m.take()).toBe(0);
  });

  it("credits a still-seated herzie when asked", () => {
    const m = new RestMeter();
    m.tick(true, 0);
    m.tick(true, 30_000);
    expect(m.take()).toBeCloseTo(30);
  });

  it("caps one stretch, so a hibernation gap isn't handed out", () => {
    const m = new RestMeter();
    m.tick(true, 0);
    m.tick(true, 3_600_000);
    expect(m.take()).toBeCloseTo(MAX_REST_GAP_MS / 1000);
  });

  it("ignores a clock that went backwards", () => {
    const m = new RestMeter();
    m.tick(true, 10_000);
    m.tick(true, 5_000);
    expect(m.take()).toBe(0);
  });
});
