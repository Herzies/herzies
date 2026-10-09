import { describe, expect, it } from "vitest";
import { EntityBuffer, ServerClock } from "./town-interpolation.js";
import {
  decodeSnapshot,
  decodeStateFrame,
  encodeSnapshot,
  encodeStateFrame,
  quantizeState,
  signTownTicket,
  TOWN_TICK_MS,
  type TownState,
  type TownTicketPayload,
  verifyTownTicket,
} from "./town-net.js";

const state = (x: number, z: number, speed = 4.5, heading = 0): TownState => ({
  x,
  z,
  heading,
  speed,
  flags: 0,
});

describe("movement frames", () => {
  it("round-trips a state to within the wire's precision", () => {
    const s = { x: -12.344, z: 39.99, heading: 7.5, speed: 4.5, flags: 1 };
    const out = decodeStateFrame(encodeStateFrame(70000, s));
    expect(out?.seq).toBe(70000 & 0xffff);
    expect(out?.state.x).toBeCloseTo(s.x, 2);
    expect(out?.state.z).toBeCloseTo(s.z, 2);
    expect(out?.state.heading).toBeCloseTo(7.5 - Math.PI * 2, 3);
    expect(out?.state.speed).toBeCloseTo(4.5, 1);
    expect(out?.state.flags).toBe(1);
  });

  it("clamps rather than wrapping out-of-range values", () => {
    const out = decodeStateFrame(encodeStateFrame(0, state(9999, -9999, 99)));
    expect(out?.state.x).toBeCloseTo(327.67);
    expect(out?.state.z).toBeCloseTo(-327.67);
    expect(out?.state.speed).toBeCloseTo(12.75);
  });

  it("matches quantizeState exactly", () => {
    const s = state(1.23456, -7.891, 3.33, 2.2);
    expect(decodeStateFrame(encodeStateFrame(1, s))?.state).toEqual(
      quantizeState(s),
    );
  });

  it("rejects frames of the wrong size or kind", () => {
    expect(decodeStateFrame(new ArrayBuffer(3))).toBeNull();
    expect(decodeStateFrame(encodeSnapshot(0, []))).toBeNull();
    expect(decodeSnapshot(encodeStateFrame(0, state(0, 0)))).toBeNull();
    const truncated = encodeSnapshot(1, [
      { id: 1, age: 0, state: state(0, 0) },
    ]).slice(0, 15);
    expect(decodeSnapshot(truncated)).toBeNull();
  });

  it("round-trips a snapshot", () => {
    const entries = [
      { id: 3, age: 12, state: quantizeState(state(1, 2)) },
      { id: 65535, age: 255, state: quantizeState(state(-3, 4, 0, 1)) },
    ];
    const out = decodeSnapshot(encodeSnapshot(1_760_000_000_123.5, entries));
    expect(out?.serverTime).toBe(1_760_000_000_123.5);
    expect(out?.entries).toEqual(entries);
  });
});

describe("tickets", () => {
  const payload: TownTicketPayload = {
    uid: "u1",
    name: "eddie",
    look: { seed: "HERZ-2CCV", stage: 2, equipped: { head: "cap" } },
    exp: 2000,
  };

  it("verifies a ticket it signed", async () => {
    const t = await signTownTicket(payload, "s3cret");
    expect(await verifyTownTicket(t, "s3cret", 1000)).toEqual(payload);
  });

  it("rejects a wrong secret, an expired ticket, and tampering", async () => {
    const t = await signTownTicket(payload, "s3cret");
    expect(await verifyTownTicket(t, "other", 1000)).toBeNull();
    expect(await verifyTownTicket(t, "s3cret", 2000)).toBeNull();
    const forged = await signTownTicket({ ...payload, name: "mallory" }, "x");
    const spliced = `${forged.split(".")[0]}.${t.split(".")[1]}`;
    expect(await verifyTownTicket(spliced, "s3cret", 1000)).toBeNull();
    expect(await verifyTownTicket("garbage", "s3cret", 1000)).toBeNull();
    expect(await verifyTownTicket("a.b!c", "s3cret", 1000)).toBeNull();
  });
});

describe("ServerClock", () => {
  it("draws about a tick and a half behind on a steady link", () => {
    const clock = new ServerClock();
    for (let i = 0; i < 300; i++) {
      const server = 10_000 + i * TOWN_TICK_MS;
      clock.observe(server, server + 5_000 + 40);
    }
    const now = 10_000 + 300 * TOWN_TICK_MS + 5_040;
    const behind = now - 5_040 - clock.renderTime(now);
    expect(behind).toBeGreaterThanOrEqual(TOWN_TICK_MS * 1.5 - 1);
    expect(behind).toBeLessThan(TOWN_TICK_MS * 2);
  });

  it("draws further behind when packets arrive unevenly", () => {
    const steady = new ServerClock();
    const jittery = new ServerClock();
    for (let i = 0; i < 300; i++) {
      const server = i * TOWN_TICK_MS;
      steady.observe(server, server + 40);
      jittery.observe(server, server + 40 + ((i * 37) % 120));
    }
    expect(jittery.delay).toBeGreaterThan(steady.delay + 50);
  });
});

describe("EntityBuffer", () => {
  it("interpolates between states", () => {
    const b = new EntityBuffer();
    b.push(0, state(0, 0));
    b.push(100, state(1, 0));
    const s = b.sample(50);
    expect(s?.x).toBeCloseTo(0.5);
  });

  it("turns the short way round", () => {
    const b = new EntityBuffer();
    b.push(0, state(0, 0, 0, 0.1));
    b.push(100, state(0, 0, 0, Math.PI * 2 - 0.1));
    expect(b.sample(50)?.heading).toBeCloseTo(0, 5);
  });

  it("ignores states that arrive out of order", () => {
    const b = new EntityBuffer();
    b.push(100, state(1, 0));
    b.push(50, state(9, 9));
    expect(b.sample(100)?.x).toBe(1);
  });

  it("jumps across a teleport instead of sliding", () => {
    const b = new EntityBuffer();
    b.push(0, state(0, 0));
    b.push(66, state(30, 0));
    expect(b.sample(33)?.x).toBe(0);
    expect(b.sample(66)?.x).toBe(30);
  });

  it("starts walking promptly after standing still a long time", () => {
    const b = new EntityBuffer();
    b.push(0, state(0, 0, 0));
    b.push(10_000, state(0.3, 0));
    // Still at the old spot until a tick before the new state, not
    // creeping across the ten-second gap.
    expect(b.sample(5_000)?.x).toBe(0);
    expect(b.sample(10_000 - TOWN_TICK_MS)?.x).toBe(0);
    expect(b.sample(10_000)?.x).toBeCloseTo(0.3);
  });

  it("extrapolates a walker briefly, then stops it", () => {
    const b = new EntityBuffer();
    b.push(0, state(0, 0));
    b.push(100, state(0.45, 0));
    expect(b.sample(150)?.x).toBeCloseTo(0.675);
    const late = b.sample(1_000);
    expect(late?.x).toBeCloseTo(0.45 + 0.45 * 2.5);
    expect(late?.speed).toBe(0);
  });

  it("holds a herzie that stopped", () => {
    const b = new EntityBuffer();
    b.push(0, state(0, 0));
    b.push(100, state(0.45, 0, 0));
    expect(b.sample(500)?.x).toBeCloseTo(0.45);
  });

  it("forgets old states", () => {
    const b = new EntityBuffer();
    for (let t = 0; t < 10_000; t += 66) b.push(t, state(t / 1000, 0));
    b.sample(9_900);
    expect(
      (b as unknown as { samples: unknown[] }).samples.length,
    ).toBeLessThan(25);
  });
});
