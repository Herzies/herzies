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

  it("keeps counting across a hibernation, from the saved start", () => {
    const before = new RestMeter();
    before.tick(true, 0); // sat down; the room saves \`since\`
    expect(before.since).toBe(0);
    // The room hibernates and wakes with a fresh meter from the socket.
    const after = new RestMeter(before.since);
    after.tick(false, 25_000); // stood up
    expect(after.take()).toBeCloseTo(25);
    expect(after.since).toBeNull();
  });

  it("a flush restarts the stretch, so a rebuilt meter can't repeat it", () => {
    const m = new RestMeter();
    m.tick(true, 0);
    m.tick(true, 30_000); // the sweep's flush
    expect(m.take()).toBeCloseTo(30);
    const woken = new RestMeter(m.since);
    woken.tick(false, 40_000);
    expect(woken.take()).toBeCloseTo(10);
  });

  it("ignores a clock that went backwards", () => {
    const m = new RestMeter();
    m.tick(true, 10_000);
    m.tick(true, 5_000);
    expect(m.take()).toBe(0);
  });
});
