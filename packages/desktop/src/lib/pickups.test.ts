import { afterEach, describe, expect, it, vi } from "vitest";
import { onLogActivity } from "./activity";
import { clearNotices, useNotices } from "./notices";
import { announcePickup, pickupLine, resetPickups } from "./pickups";

// The store, read without React.
vi.mock("react", () => ({
  useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
}));
const shown = () => useNotices().map((n) => n.text);

afterEach(() => {
  resetPickups();
  clearNotices();
});

describe("pickupLine", () => {
  it("names one find", () => {
    expect(pickupLine(["Ghost"])).toBe('Picked up "Ghost"');
  });
  it("counts the same find", () => {
    expect(pickupLine(["Ghost", "Ghost", "Ghost"])).toBe(
      'Picked up "Ghost" ×3',
    );
  });
  it("names the latest of a mixed run", () => {
    expect(pickupLine(["Ghost", "Stars", "Blood Moon"])).toBe(
      'Picked up "Blood Moon" and 2 more',
    );
  });
});

describe("announcePickup", () => {
  it("keeps a run on one line, and starts a new one after a pause", () => {
    announcePickup("Ghost", { now: 1_000 });
    announcePickup("Stars", { now: 1_110 });
    announcePickup("Clouds", { now: 1_220 });
    expect(shown()).toEqual(['Picked up "Clouds" and 2 more']);
    announcePickup("Ghost", { now: 9_000 });
    expect(shown()).toEqual([
      'Picked up "Clouds" and 2 more',
      'Picked up "Ghost"',
    ]);
  });

  it("takes a refused pickup back out of the line", () => {
    announcePickup("Ghost", { now: 1_000 });
    const stars = announcePickup("Stars", { now: 1_100 });
    stars.refuse();
    expect(shown()).toEqual(['Picked up "Ghost"']);
    // Settles once.
    stars.refuse();
    expect(shown()).toEqual(['Picked up "Ghost"']);
  });

  it("takes the line down when everything in it was refused", () => {
    const a = announcePickup("Ghost", { now: 1_000 });
    const b = announcePickup("Ghost", { now: 1_100 });
    a.refuse();
    expect(shown()).toEqual(['Picked up "Ghost"']);
    b.refuse();
    expect(shown()).toEqual([]);
  });

  it("logs only what the server confirmed", () => {
    const logged: string[] = [];
    const off = onLogActivity((m) => logged.push(m));
    const a = announcePickup("Ghost", { now: 1_000 });
    const b = announcePickup("Stars", { now: 1_100 });
    expect(logged).toEqual([]);
    a.confirm();
    b.refuse();
    b.confirm();
    expect(logged).toEqual(['Picked up "Ghost"']);
    off();
  });
});
