import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNotices,
  holdFor,
  MAX_NOTICES,
  NOTICE_FADE_MS,
  notify,
  useNotices,
} from "./notices";

// The store, read without React.
type Seen = readonly { text: string; bump: number }[];
vi.mock("react", () => ({
  useSyncExternalStore: (_s: unknown, get: () => Seen) => get(),
}));
const read = () => useNotices();

describe("notices", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearNotices();
  });
  afterEach(() => vi.useRealTimers());

  it("holds longer for longer text, within bounds", () => {
    expect(holdFor("Hi")).toBe(1_400);
    expect(holdFor("x".repeat(40))).toBe(2_500);
    expect(holdFor("x".repeat(400))).toBe(3_500);
  });

  it("goes by itself once held and faded", () => {
    notify("Already at full health");
    expect(read().map((n) => n.text)).toEqual(["Already at full health"]);
    vi.advanceTimersByTime(holdFor("Already at full health") + NOTICE_FADE_MS);
    expect(read()).toEqual([]);
  });

  it("restarts the same line rather than stacking it", () => {
    notify("Not ready yet");
    vi.advanceTimersByTime(1_000);
    notify("Not ready yet");
    expect(read()).toHaveLength(1);
    expect(read()[0].bump).toBe(1);
    // Still up past where the first would have gone.
    vi.advanceTimersByTime(holdFor("Not ready yet"));
    expect(read()).toHaveLength(1);
  });

  it("keeps a few at most, dropping the oldest", () => {
    for (let i = 0; i < MAX_NOTICES + 2; i++) notify(`n${i}`);
    expect(read().map((n) => n.text)).toEqual(["n2", "n3", "n4"]);
  });

  it("ignores empty text", () => {
    notify("  ");
    expect(read()).toEqual([]);
  });
});
