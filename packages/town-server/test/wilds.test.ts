import { classDef } from "@herzies/shared/boss-fight";
import {
  HERZIE_BODY,
  hitDamage,
  WAVE_HAND_HEIGHT,
} from "@herzies/shared/combat";
import { DUEL } from "@herzies/shared/duel";
import { RIMSHOT, SKILL_DEFS } from "@herzies/shared/skills";
import { TOWN_MAPS, type ServerMessage } from "@herzies/shared/town-net";
import { WILDS_SAFE_CAMP } from "@herzies/shared/wilds";
import {
  WILDS_PVP,
  wildsDamage,
  wildsMaxHp,
  wildsRegenStep,
  wildsSonicCap,
} from "@herzies/shared/wilds-pvp";
import { describe, expect, it } from "vitest";
import { rng } from "../src/boss";
import type { Outbound } from "../src/fight";
import { type WildsEffects, WildsPvpRuntime } from "../src/wilds";
import { type Role, realTicket } from "./herzies";

const T0 = 5_000_000;
/** Everyone's arrival protection is over. */
const OPEN = T0 + WILDS_PVP.shieldMs;
/** Out in the free-for-all, well clear of the camp (and each other's
 * spots within a wave's reach). */
const A = { x: 30, z: 0 };
const B = { x: 34, z: 0 };
/** In the camp. */
const CAMP = { x: WILDS_SAFE_CAMP.x, z: WILDS_SAFE_CAMP.z };

type Msg<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

/** A Wilds room's worth of herzies, as the runtime hears of them. */
function wilds(rand: () => number = rng(7)) {
  const rt = new WildsPvpRuntime(rand);
  const ids = new Map<string, number>();
  const join = (
    uid: string,
    at: { x: number; z: number },
    role: Role = "bard",
    level = 20,
    now = T0,
  ): WildsEffects => {
    const id = ids.get(uid) ?? ids.size + 1;
    ids.set(uid, id);
    const t = realTicket(uid, role, level);
    return rt.join(
      {
        uid,
        id,
        name: `Herzie ${uid}`,
        x: at.x,
        z: at.z,
        combat: { look: t.look, st: t.st, sk: t.sk, lv: t.lv, cls: t.cls },
      },
      now,
    );
  };
  const move = (uid: string, at: { x: number; z: number }, now: number) =>
    rt.onState(uid, at.x, at.z, now);
  return { rt, ids, join, move };
}

/** What was said of kind `t`: to the whole room, or to `to` alone. */
function said<T extends ServerMessage["t"]>(
  from: Outbound[] | WildsEffects,
  t: T,
  to?: string,
): Msg<T>[] {
  const out = "out" in from ? from.out : from;
  return out
    .filter(
      (o) =>
        o.msg.t === t &&
        (to === undefined ? o.to === "all" : o.to !== "all" && o.to.uid === to),
    )
    .map((o) => o.msg as Msg<T>);
}

/** Step 50 ms at a time from `from` to `until`, collecting what's said. */
function run(rt: WildsPvpRuntime, from: number, until: number): WildsEffects {
  const e: WildsEffects = { out: [], place: [], downs: [] };
  for (let t = from; t <= until; t += 50) {
    const s = rt.step(t);
    e.out.push(...s.out);
    e.place.push(...s.place);
    e.downs.push(...s.downs);
  }
  return e;
}

/** A cast's yaw and pitch from `from` at a herzie standing at `to`. */
function aim(from: { x: number; z: number }, to: { x: number; z: number }) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return {
    yaw: Math.atan2(dx, dz),
    pitch: Math.atan2(HERZIE_BODY.chest - WAVE_HAND_HEIGHT, Math.hypot(dx, dz)),
  };
}

/** `by` (at `from`) casts at the herzie at `to` at `now`. */
function castAt(
  rt: WildsPvpRuntime,
  by: string,
  from: { x: number; z: number },
  to: { x: number; z: number },
  now: number,
) {
  const { yaw, pitch } = aim(from, to);
  return rt.cast(by, yaw, pitch, now);
}

/** `a` keeps casting at `b` (every 700 ms, letting each land) until `b`
 * is down; what was said, and when it went down. */
function bringDown(
  w: { rt: WildsPvpRuntime; ids: Map<string, number> },
  a: string,
  b: string,
  from: { x: number; z: number },
  to: { x: number; z: number },
  start: number,
) {
  const e: WildsEffects = { out: [], place: [], downs: [] };
  let t = start;
  for (let i = 0; i < 100; i++) {
    const c = castAt(w.rt, a, from, to, t);
    e.out.push(...c.out);
    const s = run(w.rt, t, t + 650);
    e.out.push(...s.out);
    e.place.push(...s.place);
    e.downs.push(...s.downs);
    t += 700;
    if (said(s, "pvp").some((m) => m.id === w.ids.get(b) && m.down))
      return { e, downAt: t - 700, t };
  }
  throw new Error("never went down");
}

describe("the Wilds' free-for-all", () => {
  it("hurts anyone out of the camp, and nobody from it or in it", () => {
    const w = wilds();
    w.join("a", A);
    w.join("b", B);
    const cast = castAt(w.rt, "a", A, B, OPEN);
    expect(cast.result).toBe("hit");
    const e = run(w.rt, OPEN, OPEN + 500);
    const [hit] = said(e, "pvpHit", "a");
    expect(hit.target).toBe(2);
    expect(hit.damage).toBeGreaterThan(0);
    const max = wildsMaxHp(20);
    expect(said(e, "pvp")).toEqual([
      { t: "pvp", id: 2, hp: max - hit.damage, maxHp: max, by: 1 },
    ]);

    // b steps into the camp: a's casts meet nobody.
    w.move("b", CAMP, OPEN + 1_000);
    expect(castAt(w.rt, "a", A, CAMP, OPEN + 2_000).result).toBe("miss");
    // Nor do b's, out of it (a stands outside).
    expect(castAt(w.rt, "b", CAMP, A, OPEN + 2_000).result).toBe("miss");
    expect(said(run(w.rt, OPEN + 2_000, OPEN + 3_000), "pvpHit", "a")).toEqual(
      [],
    );
  });

  it("drops a blow that lands on someone who reached the camp", () => {
    const w = wilds();
    // Just outside the camp, on its island side, and further in.
    const inward = -Math.sign(WILDS_SAFE_CAMP.x);
    const edge = {
      x: WILDS_SAFE_CAMP.x + inward * (WILDS_SAFE_CAMP.r + 1),
      z: 0.5,
    };
    const far = { x: edge.x + inward * 20, z: 0.5 };
    w.join("a", far);
    w.join("b", edge);
    expect(castAt(w.rt, "a", far, edge, OPEN).result).toBe("hit");
    // In before the wave gets there (20 units: ~770 ms).
    w.move("b", { x: edge.x - inward * 2, z: 0.5 }, OPEN + 100);
    expect(said(run(w.rt, OPEN, OPEN + 1_500), "pvpHit", "a")).toEqual([]);
  });

  it("protects arrivals 5 s, or until they attack", () => {
    const w = wilds();
    const joined = w.join("a", A);
    expect(said(joined, "pvp")).toEqual([
      {
        t: "pvp",
        id: 1,
        hp: wildsMaxHp(20),
        maxHp: wildsMaxHp(20),
        shield: OPEN,
      },
    ]);
    // A newcomer hears of a's protection.
    const b = w.join("b", B, "bard", 20, T0 + 1_000);
    expect(said(b, "pvp", "b")).toEqual([
      expect.objectContaining({ id: 1, shield: OPEN }),
    ]);
    // a may not touch b yet; attacking (from outside the camp) ends its
    // own protection, not b's.
    const attack = castAt(w.rt, "a", A, B, T0 + 2_000);
    expect(attack.result).toBe("miss");
    expect(said(attack.out, "pvp")).toEqual([
      { t: "pvp", id: 1, hp: wildsMaxHp(20), maxHp: wildsMaxHp(20) },
    ]);
    // So b may touch a.
    expect(castAt(w.rt, "b", B, A, T0 + 2_800).result).toBe("hit");
  });

  it("doesn't protect a herzie again for leaving and coming back", () => {
    // The exploit: the app drops its socket while its window is hidden, and
    // each hello used to be an arrival (5 s fresh), so hiding and showing
    // the window over and over kept a herzie out of reach for good.
    const w = wilds();
    w.join("a", A);
    w.join("b", B);
    const pvpOf = (e: WildsEffects, id: number) =>
      said(e, "pvp").find((m) => m.id === id);
    // Back a second later: what's left of its protection, not a new one.
    w.rt.gone("b", T0 + 1_000);
    expect(pvpOf(w.join("b", B, "bard", 20, T0 + 2_000), 2)).toMatchObject({
      shield: OPEN,
    });
    // Out once that's over, back at once, twice over: never protected.
    for (const t of [OPEN + 500, OPEN + 2_000]) {
      w.rt.gone("b", t);
      const back = w.join("b", B, "bard", 20, t + 400);
      expect(pvpOf(back, 2)).not.toHaveProperty("shield");
      expect(castAt(w.rt, "a", A, B, t + 450).result).toBe("hit");
    }
    // Protection given up by attacking doesn't come back with a reconnect.
    const c = wilds();
    c.join("a", A);
    c.join("b", B);
    expect(castAt(c.rt, "b", B, A, T0 + 1_000).result).toBe("miss");
    c.rt.gone("b", T0 + 1_500);
    expect(pvpOf(c.join("b", B, "bard", 20, T0 + 2_000), 2)).not.toHaveProperty(
      "shield",
    );
    expect(castAt(c.rt, "a", A, B, T0 + 2_100).result).toBe("hit");
  });

  it("protects a herzie back after a while as a new arrival", () => {
    const w = wilds();
    w.join("a", A);
    w.join("b", B);
    const left = OPEN + 1_000;
    w.rt.gone("b", left);
    const back = left + WILDS_PVP.keepMs;
    expect(
      said(w.join("b", B, "bard", 20, back), "pvp").find((m) => m.id === 2),
    ).toMatchObject({ shield: back + WILDS_PVP.shieldMs });
    expect(castAt(w.rt, "a", A, B, back + 100).result).toBe("miss");
  });

  it("takes a herzie down, then stands it up in the camp 6 s later", () => {
    const w = wilds();
    w.join("a", A);
    w.join("b", B);
    w.join("near", { x: 30, z: 20 });
    w.join("far", { x: -40, z: 0 });
    const max = wildsMaxHp(20);
    const { e, downAt, t } = bringDown(w, "a", "b", A, B, OPEN);
    // No hit took more than 30% of b's health.
    for (const h of said(e, "pvpHit", "a"))
      expect(h.damage).toBeLessThanOrEqual(DUEL.maxHitFraction * max);
    const down = said(e, "pvp").find((m) => m.down);
    expect(down).toMatchObject({ id: 2, hp: 0, by: 1 });
    expect(down?.down).toBeGreaterThan(downAt);
    expect(down?.down).toBeLessThanOrEqual(downAt + 700 + WILDS_PVP.respawnMs);
    // The line: to the two of them and anyone near, not across the island.
    const feed = {
      t: "pvpFeed",
      by: 1,
      byName: "Herzie a",
      victim: 2,
      victimName: "Herzie b",
    };
    expect(said(e, "pvpFeed", "a")).toEqual([feed]);
    expect(said(e, "pvpFeed", "b")).toEqual([feed]);
    expect(said(e, "pvpFeed", "near")).toEqual([feed]);
    expect(said(e, "pvpFeed", "far")).toEqual([]);
    // And the room hears of it, for b's dropped card (where it fell).
    expect(e.downs).toEqual([
      { victim: "b", victimId: 2, killer: "a", at: { x: B.x, z: B.z } },
    ]);
    expect(w.rt.isDown("b")).toBe(true);
    expect(w.rt.isDown("a")).toBe(false);

    // Down: held where it fell, can't act, can't be hurt.
    const held = w.rt.hold("b", 50, 0, t + 1_000);
    expect(held).toMatchObject({ x: B.x, z: B.z, correct: true });
    expect(castAt(w.rt, "b", B, A, t).result).toBe("ignored");
    expect(castAt(w.rt, "a", A, B, t + 400).result).toBe("miss");

    // Up in the camp, full health, protected.
    const up = run(w.rt, t, (down?.down ?? 0) + 100);
    const { spawn } = TOWN_MAPS.wilds;
    expect(up.place).toEqual([{ uid: "b", x: spawn.x, z: spawn.z }]);
    const stood = said(up, "pvp").find((m) => m.id === 2);
    expect(stood).toMatchObject({ hp: max, maxHp: max });
    expect(stood?.down).toBeUndefined();
    expect(stood?.shield).toBe((down?.down ?? 0) + WILDS_PVP.shieldMs);
    expect(w.rt.hold("b", spawn.x, spawn.z, (down?.down ?? 0) + 200)).toBe(
      null,
    );
  });

  it("holds a big herzie's Sonic Power to its victim's level + 10", () => {
    // A rand that never crits, and rolls the top of the spread.
    const w = wilds(() => 0.999);
    w.join("big", A, "record_slinger", 60);
    w.join("small", B, "bard", 10);
    castAt(w.rt, "big", A, B, OPEN);
    const [hit] = said(run(w.rt, OPEN, OPEN + 1_000), "pvpHit", "big");
    const big = realTicket("x", "record_slinger", 60);
    const small = realTicket("y", "bard", 10);
    const sp = big.st?.[0] ?? 0;
    expect(sp).toBeGreaterThan(wildsSonicCap(10));
    const roll = (sonicPower: number) =>
      wildsDamage({
        amount: hitDamage(
          {
            sonicPower,
            critChance: big.st?.[2] ?? 0,
            critDamage: big.st?.[3] ?? 0,
          },
          () => 0.999,
        ).amount,
        mult: DUEL.discShare,
        def: classDef("bard", small.st?.[5] ?? 0),
        maxHp: wildsMaxHp(10),
      });
    expect(hit.damage).toBe(roll(wildsSonicCap(10)));
    expect(hit.damage).toBeLessThan(roll(sp));
  });

  it("credits the last hitter when a herzie leaves mid-fight", () => {
    const w = wilds();
    w.join("a", A);
    w.join("b", B);
    w.join("c", { x: 30, z: 4 });
    castAt(w.rt, "a", A, B, OPEN);
    run(w.rt, OPEN, OPEN + 500);
    // Left 3 s after the blow: as good as taken down.
    const left = w.rt.gone("b", OPEN + 3_000);
    const feed = {
      t: "pvpFeed",
      by: 1,
      byName: "Herzie a",
      victim: 2,
      victimName: "Herzie b",
      logged: true,
    };
    expect(said(left, "pvpFeed", "a")).toEqual([feed]);
    expect(said(left, "pvpFeed", "c")).toEqual([feed]);
    expect(left.downs).toEqual([
      { victim: "b", victimId: 2, killer: "a", at: { x: B.x, z: B.z } },
    ]);
    // Back at once: still down until its time is up, then up in the camp.
    const back = w.join("b", B, "bard", 20, OPEN + 4_000);
    expect(said(back, "pvp").find((m) => m.id === 2)).toMatchObject({
      hp: 0,
      down: OPEN + 3_000 + WILDS_PVP.respawnMs,
    });
    expect(run(w.rt, OPEN + 4_000, OPEN + 9_100).place).toEqual([
      { uid: "b", ...TOWN_MAPS.wilds.spawn },
    ]);

    // Leaving once the fight's over counts for nothing.
    const w2 = wilds();
    w2.join("a", A);
    w2.join("b", B);
    castAt(w2.rt, "a", A, B, OPEN);
    run(w2.rt, OPEN, OPEN + 500);
    const calm = w2.rt.gone("b", OPEN + WILDS_PVP.combatMs + 500);
    expect(said(calm, "pvpFeed", "a")).toEqual([]);
    expect(calm.downs).toEqual([]);
  });

  it("keeps a leaver's PvP health 30 s, so a reconnect doesn't heal", () => {
    const w = wilds();
    w.join("a", A);
    w.join("b", B);
    castAt(w.rt, "a", A, B, OPEN);
    const [hit] = said(run(w.rt, OPEN, OPEN + 500), "pvpHit", "a");
    const max = wildsMaxHp(20);
    // Out of combat (no line), not yet healed (no steps run).
    const left = OPEN + WILDS_PVP.combatMs + 1_000;
    w.rt.gone("b", left);
    const back = w.join("b", B, "bard", 20, left + 20_000);
    expect(said(back, "pvp").find((m) => m.id === 2)).toMatchObject({
      hp: max - hit.damage,
    });
    // Gone longer than that: full health again.
    w.rt.gone("b", left + 21_000);
    const later = w.join("b", B, "bard", 20, left + 21_000 + WILDS_PVP.keepMs);
    expect(said(later, "pvp").find((m) => m.id === 2)).toMatchObject({
      hp: max,
    });
  });

  it("heals out of combat, from 10 s after the last blow", () => {
    const w = wilds();
    w.join("a", A);
    w.join("b", B);
    castAt(w.rt, "a", A, B, OPEN);
    const e = run(w.rt, OPEN, OPEN + 500);
    const hurt = said(e, "pvp")[0].hp;
    const landedAt = OPEN + 300;
    // Still in combat: nothing back.
    const during = run(w.rt, OPEN + 550, landedAt + WILDS_PVP.combatMs - 300);
    expect(said(during, "pvp")).toEqual([]);
    const after = run(
      w.rt,
      landedAt + WILDS_PVP.combatMs - 250,
      landedAt + WILDS_PVP.combatMs + 1_000,
    );
    const steps = said(after, "pvp").filter((m) => m.id === 2);
    expect(steps.length).toBeGreaterThanOrEqual(1);
    const max = wildsMaxHp(20);
    expect(hurt).toBeLessThan(max);
    expect(steps[0].hp).toBe(Math.min(max, hurt + wildsRegenStep(max)));
  });

  it("has Taunt and Resurrect do nothing to herzies", () => {
    const w = wilds();
    w.join("tank", A, "percussionist");
    w.join("bard", B, "bard");
    expect(w.rt.skill("tank", "taunt", 0, 0, OPEN)).toMatchObject({
      result: "refused",
      reason: "wilds",
    });
    expect(w.rt.skill("bard", "resurrect", 0, 0, OPEN)).toMatchObject({
      result: "refused",
      reason: "wilds",
    });
  });

  it("shelters only a Cymbrella's owner under its dome", () => {
    const w = wilds();
    w.join("a", A);
    w.join("tank", B, "percussionist");
    const beside = { x: B.x, z: 1.2 };
    w.join("c", beside);
    expect(w.rt.skill("tank", "cymbrella", 0, 0, OPEN).result).toBe("used");
    castAt(w.rt, "a", A, B, OPEN + 100);
    castAt(w.rt, "a", A, beside, OPEN + 800);
    const e = run(w.rt, OPEN + 100, OPEN + 1_500);
    const hits = said(e, "pvpHit", "a");
    expect(hits[0]).toMatchObject({ target: 2, damage: 0, blocked: true });
    expect(hits[1].target).toBe(3);
    expect(hits[1].damage).toBeGreaterThan(0);
  });

  it("stuns with a Rimshot at half a mob's, less each time", () => {
    // Every roll stuns.
    const w = wilds(() => 0);
    w.join("tank", A, "percussionist");
    w.join("b", { x: A.x + 2, z: 0 });
    const castMs = SKILL_DEFS.rimshot.castMs ?? 0;
    w.rt.skill("tank", "rimshot", 0, 0, OPEN);
    const first = said(run(w.rt, OPEN, OPEN + castMs + 50), "pvpStun");
    expect(first).toHaveLength(1);
    const landed = first[0].until - RIMSHOT.stunMs * WILDS_PVP.stunScale;
    expect(landed).toBeGreaterThanOrEqual(OPEN + castMs);
    // Held while stunned.
    expect(w.rt.hold("b", A.x + 5, 0, landed + 100)).not.toBeNull();
    const again = OPEN + SKILL_DEFS.rimshot.cooldownMs;
    w.rt.skill("tank", "rimshot", 0, 0, again);
    const second = said(run(w.rt, again, again + castMs + 50), "pvpStun");
    expect(second).toHaveLength(1);
    const ms = second[0].until - (again + castMs);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual((RIMSHOT.stunMs * WILDS_PVP.stunScale) / 2);
  });

  it("carries a reconnecting herzie on, unprotected and as hurt", () => {
    const w = wilds();
    w.join("a", A);
    w.join("b", B);
    castAt(w.rt, "a", A, B, OPEN);
    run(w.rt, OPEN, OPEN + 500);
    // A second socket for b (no leave in between): same fight.
    const again = w.join("b", B, "bard", 20, OPEN + 600);
    expect(said(again, "pvp")).toEqual([]);
    expect(castAt(w.rt, "a", A, B, OPEN + 1_400).result).toBe("hit");
  });
});
