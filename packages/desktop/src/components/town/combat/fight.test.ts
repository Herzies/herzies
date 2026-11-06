import { describe, expect, it } from "vitest";
import { bossFight, handleBossMessage, resetBossFight } from "./fight";
import { entityAt, setBuff, setSelfAt, skills } from "./skills";
import { beginSlam, pendingSlam } from "./slams";

const clock = { toLocal: (t: number) => t, you: () => 7 };

describe("the client's fight state", () => {
  it("a Rimshot the server refused never lands", () => {
    resetBossFight();
    beginSlam(7, 0, 0, performance.now(), (o) => o);
    expect(pendingSlam(7)).toBeTruthy();
    handleBossMessage(
      { t: "skillDenied", skill: "rimshot", seq: 1, readyAt: 0 } as never,
      clock,
    );
    expect(pendingSlam(7)).toBeFalsy();
  });

  it("leaving an island drops a practice's buffs and slams", () => {
    setBuff(7, {
      id: "haste",
      value: 0.3,
      until: performance.now() + 9e5,
    } as never);
    beginSlam(7, 0, 0, performance.now(), (o) => o);
    resetBossFight();
    expect(skills.buffs.size).toBe(0);
    expect(pendingSlam(7)).toBeFalsy();
  });

  it("a new id for you leaves no frozen copy behind", () => {
    resetBossFight();
    setSelfAt(-1, 1, 1, 2);
    setSelfAt(7, 1, 1, 2);
    expect(entityAt.has(-1)).toBe(false);
    setSelfAt(9, 1, 1, 2);
    expect(entityAt.has(7)).toBe(false);
    expect(entityAt.has(9)).toBe(true);
  });

  it("back into a room with no fight on, the old fight is over", () => {
    bossFight.on = true;
    handleBossMessage({ t: "welcome", you: 3, players: [] } as never, clock);
    expect(bossFight.on).toBe(false);
    expect(bossFight.you).toBe(3);
  });
});
