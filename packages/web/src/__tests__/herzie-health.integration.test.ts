/**
 * Integration tests for herzie health (00101): lazy regen, the lower-only
 * report from the Town server, knock-out and respawn.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
} from "./integration-helpers";

const admin = () => getAdminClient();

async function player(level = 1) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, { level });
  return user;
}

async function rpc<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await admin().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

type Vitals = {
  hp: number;
  maxHp: number;
  stored: number | null;
  hpAt: number | null;
  down: boolean;
};

describe("herzie health", () => {
  afterAll(cleanupTestData);

  it("starts full, with max HP from the level", async () => {
    const { userId } = await player(10);
    const v = await rpc<Vitals>("herzie_vitals", { p_user: userId });
    expect(v).toMatchObject({ hp: 182, maxHp: 182, stored: null, down: false });
  });

  it("a report lowers HP and stamps it; regen waits out the delay", async () => {
    const { userId } = await player(59); // 574 max
    const v = await rpc<Vitals>("set_herzie_hp", { p_user: userId, p_hp: 100 });
    expect(v.hp).toBeCloseTo(100, 0);
    expect(v.stored).toBe(100);
    expect(v.down).toBe(false);
    const again = await rpc<Vitals>("herzie_vitals", { p_user: userId });
    expect(again.hp).toBeLessThan(101);
  });

  it("regens after the delay, about a full bar in five minutes", async () => {
    const { userId } = await player(59);
    await rpc("set_herzie_hp", { p_user: userId, p_hp: 0.5 });
    // Pretend the report was a minute and five seconds ago.
    await admin()
      .from("herzies")
      .update({ hp: 100, hp_at: new Date(Date.now() - 65_000).toISOString() })
      .eq("user_id", userId);
    const v = await rpc<Vitals>("herzie_vitals", { p_user: userId });
    // 60 regen-seconds at 574/300 a second ≈ 115.
    expect(v.hp).toBeGreaterThan(205);
    expect(v.hp).toBeLessThan(225);
  });

  it("a report can never heal", async () => {
    const { userId } = await player(59);
    await rpc("set_herzie_hp", { p_user: userId, p_hp: 100 });
    const v = await rpc<Vitals>("set_herzie_hp", { p_user: userId, p_hp: 395 });
    expect(v.hp).toBeLessThan(105);
  });

  it("a report above a stale stored value still lowers from HP now", async () => {
    const { userId } = await player(59);
    await admin()
      .from("herzies")
      .update({ hp: 10, hp_at: new Date(Date.now() - 305_000).toISOString() })
      .eq("user_id", userId);
    // 300s of regen after the delay: effectively full, so 200 is a real hit.
    const v = await rpc<Vitals>("set_herzie_hp", { p_user: userId, p_hp: 200 });
    expect(v.stored).toBeCloseTo(200, 0);
  });

  it("hitting 0 knocks the herzie down, and down does not regen", async () => {
    const { userId } = await player();
    const v = await rpc<Vitals>("set_herzie_hp", { p_user: userId, p_hp: 0 });
    expect(v).toMatchObject({ hp: 0, down: true });
    await admin()
      .from("herzies")
      .update({ hp_at: new Date(Date.now() - 3_600_000).toISOString() })
      .eq("user_id", userId);
    const later = await rpc<Vitals>("herzie_vitals", { p_user: userId });
    expect(later).toMatchObject({ hp: 0, down: true });
    // Reports and rests are ignored while down.
    const rested = await rpc<Vitals>("rest_herzie", {
      p_user: userId,
      p_bonus: 50,
    });
    expect(rested.hp).toBe(0);
  });

  it("respawn brings a down herzie back with half its health", async () => {
    const { userId } = await player(59);
    await rpc("set_herzie_hp", { p_user: userId, p_hp: 0 });
    const v = await rpc<Vitals>("respawn_herzie", { p_user: userId });
    expect(v.down).toBe(false);
    expect(v.hp).toBe(287); // ceil(574 * 0.5)
  });

  it("respawn is a no-op for a herzie that isn't down", async () => {
    const { userId } = await player(59);
    await rpc("set_herzie_hp", { p_user: userId, p_hp: 300 });
    const v = await rpc<Vitals>("respawn_herzie", { p_user: userId });
    expect(v.hp).toBeLessThan(305);
    expect(v.hp).toBeGreaterThan(290);
  });

  it("bench rest adds HP, capped at max, without restarting the regen delay", async () => {
    const { userId } = await player(59);
    await rpc("set_herzie_hp", { p_user: userId, p_hp: 100 });
    const v = await rpc<Vitals>("rest_herzie", { p_user: userId, p_bonus: 50 });
    expect(v.hp).toBeCloseTo(150, 0);
    const huge = await rpc<Vitals>("rest_herzie", {
      p_user: userId,
      p_bonus: 9999,
    });
    expect(huge.hp).toBe(574);
  });
});
