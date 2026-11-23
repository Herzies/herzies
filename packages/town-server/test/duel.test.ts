import { classDef } from "@herzies/shared/boss-fight";
import { HERZIE_BODY, hitDamage, WAVE_HAND_HEIGHT } from "@herzies/shared/combat";
import {
  DUEL,
  duelCountdownMs,
  duelDamage,
  duelMaxHp,
} from "@herzies/shared/duel";
import { RIMSHOT, SKILL_DEFS } from "@herzies/shared/skills";
import type { ServerMessage } from "@herzies/shared/town-net";
import { describe, expect, it } from "vitest";
import { rng, TUNING } from "../src/boss";
import {
  DUEL_AFTERCAST_MS,
  type DuelEffects,
  type DuelPeer,
  DuelRuntime,
  HOLD_EASE_MS,
} from "../src/duel";
import { type Outbound, statsOf } from "../src/fight";
import { type Role, realTicket } from "./herzies";

const T0 = 5_000_000;
/** When a duel accepted at T0 fights. */
const FIGHT = T0 + duelCountdownMs(true);

type Msg<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

/** A room's worth of herzies, as the runtime asks after them. */
function room(rand: () => number = rng(7), map: "home" | "bossroom" = "home") {
  const peers = new Map<string, DuelPeer>();
  const rt = new DuelRuntime(
    map,
    "home:test",
    {
      byUid: (uid) => peers.get(uid) ?? null,
      byId: (id) => [...peers.values()].find((p) => p.id === id) ?? null,
    },
    rand,
  );
  const add = (
    uid: string,
    id: number,
    x: number,
    z: number,
    role: Role = "bard",
    level = 20,
  ) => {
    const t = realTicket(uid, role, level);
    peers.set(uid, {
      uid,
      id,
      x,
      z,
      away: false,
      combat: {
        look: t.look,
        st: t.st,
        sk: t.sk,
        lv: t.lv,
        cls: t.cls,
      },
    });
  };
  /** Walk `uid` to (x, z), as the room hears it. */
  const move = (uid: string, x: number, z: number, now: number) => {
    const p = peers.get(uid);
    if (p) Object.assign(p, { x, z });
    rt.onState(uid, x, z, now);
  };
  return { rt, peers, add, move };
}

/** `a` (id 1, at the origin) and `b` (id 2, 4 east) accept a duel at T0:
 * the ring at (2, 0), their marks at A and B. */
function dueling(
  roles: [Role, Role] = ["bard", "bard"],
  rand?: () => number,
  level = 20,
) {
  const w = room(rand);
  w.add("a", 1, 0, 0, roles[0], level);
  w.add("b", 2, 4, 0, roles[1], level);
  w.rt.ask("a", 2, T0);
  const start = w.rt.answer("b", 1, true, false, T0);
  for (const p of start.place) w.move(p.uid, p.x, p.z, T0);
  return { ...w, start };
}

const A = { x: -4, z: 0 };
const B = { x: 8, z: 0 };

/** What was said of kind `t`: to the whole room, or to `to` alone. */
function said<T extends ServerMessage["t"]>(
  from: Outbound[] | DuelEffects,
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
function run(rt: DuelRuntime, from: number, until: number): DuelEffects {
  const e: DuelEffects = { out: [], place: [], results: [] };
  for (let t = from; t <= until; t += 50) {
    const s = rt.step(t);
    e.out.push(...s.out);
    e.results.push(...s.results);
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

/** What a level-20 Bard's hit with every roll at `r` does to another. */
function bardHit(r: number, fightMs: number): number {
  const t = realTicket("x", "bard", 20);
  const stats = statsOf(t.st);
  return duelDamage({
    amount: hitDamage(stats, () => r).amount,
    mult: 1,
    def: classDef("bard", stats.def),
    fightMs,
    maxHp: duelMaxHp(20),
  });
}

describe("challenges", () => {
  it("asks the herzie, and tells the challenger it's out", () => {
    const w = room();
    w.add("a", 1, 0, 0);
    w.add("b", 2, 4, 0);
    const e = w.rt.ask("a", 2, T0);
    expect(said(e, "duelAsk", "b")).toEqual([
      { t: "duelAsk", from: 1, lv: 20, cls: "bard", ttl: DUEL.askTtlMs },
    ]);
    expect(said(e, "duelAsked", "a")).toEqual([
      { t: "duelAsked", to: 2, ttl: DUEL.askTtlMs },
    ]);
  });

  it("refuses itself, the gone, the far, the busy and the away", () => {
    const w = room();
    w.add("a", 1, 0, 0);
    w.add("b", 2, 4, 0);
    w.add("c", 3, 30, 0);
    w.add("d", 4, 2, 2);
    const why = (from: string, to: number) =>
      said(w.rt.ask(from, to, T0), "duelNo", from)[0]?.why;
    expect(why("a", 1)).toBe("self");
    expect(why("a", 9)).toBe("gone");
    expect(why("a", 3)).toBe("far");
    // Just inside the reach, with the slack for interpolation.
    w.move("c", DUEL.challengeRange + DUEL.rangeSlack - 0.1, 0, T0);
    expect(why("a", 3)).toBeUndefined();
    // c is answering a's challenge: d can't ask it too.
    expect(why("d", 3)).toBe("busy");
    const b = w.peers.get("b");
    if (b) b.away = true;
    expect(why("d", 2)).toBe("away");
  });

  it("refuses anyone already in a duel, either side", () => {
    const w = dueling();
    w.add("c", 3, A.x + 2, 0);
    expect(said(w.rt.ask("c", 1, T0 + 10), "duelNo", "c")[0]?.why).toBe("busy");
    expect(said(w.rt.ask("a", 3, T0 + 10), "duelNo", "a")[0]?.why).toBe("busy");
  });

  it("isn't allowed off the duel maps", () => {
    const w = room(rng(1), "bossroom");
    w.add("a", 1, 0, 0);
    w.add("b", 2, 4, 0);
    expect(said(w.rt.ask("a", 2, T0), "duelNo", "a")[0]?.why).toBe("here");
  });

  it("holds a challenger to its pace, and to a herzie's declines", () => {
    const w = room();
    w.add("a", 1, 0, 0);
    w.add("b", 2, 4, 0);
    w.add("c", 3, -4, 0);
    w.rt.ask("a", 2, T0);
    // Too soon after its last: told how long.
    expect(said(w.rt.ask("a", 3, T0 + 1_000), "duelNo", "a")[0]).toMatchObject({
      why: "cooldown",
      retryIn: DUEL.askGapMs - 1_000,
    });

    // b says no: a waits out the decline's cooldown before asking b again.
    const no = w.rt.answer("b", 1, false, false, T0 + 2_000);
    expect(said(no, "duelNo", "a")[0]?.why).toBe("declined");
    expect(said(w.rt.ask("a", 2, T0 + 10_000), "duelNo", "a")[0]).toMatchObject({
      why: "cooldown",
      retryIn: DUEL.declineCooldownMs - 8_000,
    });
    // c, meanwhile, it may.
    expect(said(w.rt.ask("a", 3, T0 + 10_000), "duelAsk", "c")).toHaveLength(1);

    // A second no (an automatic one) within the window: the long wait.
    const t2 = T0 + 2_000 + DUEL.declineCooldownMs;
    expect(said(w.rt.ask("a", 2, t2), "duelAsk", "b")).toHaveLength(1);
    const auto = w.rt.answer("b", 1, false, true, t2 + 100);
    expect(said(auto, "duelNo", "a")[0]?.why).toBe("auto");
    const t3 = t2 + 100 + DUEL.declineCooldownMs + 1;
    expect(said(w.rt.ask("a", 2, t3), "duelNo", "a")[0]).toMatchObject({
      why: "cooldown",
      retryIn: DUEL.declinePenaltyMs - DUEL.declineCooldownMs - 1,
    });
  });

  it("runs out unanswered, and counts as a decline", () => {
    const w = room();
    w.add("a", 1, 0, 0);
    w.add("b", 2, 4, 0);
    w.rt.ask("a", 2, T0);
    expect(w.rt.live).toBe(true);
    const e = run(w.rt, T0, T0 + DUEL.askTtlMs);
    expect(said(e, "duelNo", "a")[0]?.why).toBe("expired");
    expect(said(e, "duelAskGone", "b")).toEqual([{ t: "duelAskGone", from: 1 }]);
    expect(w.rt.live).toBe(false);
    const later = w.rt.ask("a", 2, T0 + DUEL.askTtlMs + 6_000);
    expect(said(later, "duelNo", "a")[0]?.why).toBe("cooldown");
  });

  it("replaces an earlier challenge, and can be withdrawn", () => {
    const w = room();
    w.add("a", 1, 0, 0);
    w.add("b", 2, 4, 0);
    w.add("c", 3, -4, 0);
    w.rt.ask("a", 2, T0);
    const next = w.rt.ask("a", 3, T0 + DUEL.askGapMs);
    expect(said(next, "duelAskGone", "b")).toEqual([{ t: "duelAskGone", from: 1 }]);
    expect(said(w.rt.cancel("a"), "duelAskGone", "c")).toEqual([
      { t: "duelAskGone", from: 1 },
    ]);
    // Gone: answering it does nothing.
    expect(w.rt.answer("c", 1, true, false, T0 + 6_000).out).toEqual([]);
  });

  it("asking back a herzie that asked you is a yes", () => {
    const w = room();
    w.add("a", 1, 0, 0);
    w.add("b", 2, 4, 0);
    w.rt.ask("a", 2, T0);
    expect(said(w.rt.ask("b", 1, T0 + 500), "duel")).toHaveLength(1);
    expect(w.rt.dueling("a") && w.rt.dueling("b")).toBe(true);
  });

  it("needs the two still near enough at the accept", () => {
    const w = room();
    w.add("a", 1, 0, 0);
    w.add("b", 2, 4, 0);
    w.rt.ask("a", 2, T0);
    w.move("b", DUEL.acceptRange + DUEL.rangeSlack + 1, 0, T0 + 3_000);
    const e = w.rt.answer("b", 1, true, false, T0 + 3_000);
    expect(said(e, "duelNo", "a")).toEqual([{ t: "duelNo", with: 2, why: "far" }]);
    expect(said(e, "duelNo", "b")).toEqual([{ t: "duelNo", with: 1, why: "far" }]);
    expect(w.rt.dueling("a")).toBe(false);
  });
});

describe("the countdown", () => {
  it("rings the two, puts them on their marks and tells the room", () => {
    const { start } = dueling();
    const [d] = said(start, "duel");
    expect(d).toMatchObject({
      id: 1,
      a: 1,
      b: 2,
      x: 2,
      z: 0,
      phase: "countdown",
      intro: true,
      at: T0,
      startsAt: FIGHT,
      suddenAt: FIGHT + DUEL.regulationMs,
      endsAt: FIGHT + DUEL.hardCapMs,
      marks: { a: A, b: B },
    });
    expect(d.hp.map((h) => h.hp)).toEqual(d.hp.map((h) => h.maxHp));
    expect(start.place).toEqual([
      { uid: "a", ...A },
      { uid: "b", ...B },
    ]);
  });

  it("holds them on their marks, putting a stray right after the ease", () => {
    const { rt } = dueling();
    expect(rt.hold("a", 0, 0, T0 + 100)).toEqual({ ...A, correct: false });
    expect(rt.hold("a", 0, 0, T0 + HOLD_EASE_MS)).toEqual({ ...A, correct: true });
    // Not every frame.
    expect(rt.hold("a", 0, 0, T0 + HOLD_EASE_MS + 50)?.correct).toBe(false);
    // Standing on it (turning, aiming): nothing to say.
    expect(rt.hold("a", A.x + 0.2, A.z, T0 + 2_000)?.correct).toBe(false);
    // Once it's on, they move freely.
    rt.step(FIGHT);
    expect(rt.hold("a", 0, 0, FIGHT + 10)).toBeNull();
  });

  it("ignores casts and skills until FIGHT!, then says so", () => {
    const { rt } = dueling();
    const { yaw, pitch } = aim(A, B);
    expect(rt.cast("a", yaw, pitch, T0 + 1_000)).toBe("ignored");
    expect(rt.skill("a", "soothing-drones", yaw, pitch, T0 + 1_000).result).toBe(
      "ignored",
    );
    const e = run(rt, T0, FIGHT);
    expect(said(e, "duel").map((d) => d.phase)).toEqual(["fight"]);
    expect(rt.cast("a", yaw, pitch, FIGHT + 10)).toBe("hit");
  });

  it("is called off if one leaves before the fight", () => {
    const { rt } = dueling();
    const e = rt.gone("b", T0 + 1_000);
    const [end] = said(e, "duelEnd");
    expect(end).toMatchObject({ why: "cancelled", winner: null, ms: 0 });
    expect(end.rematchUntil).toBeUndefined();
    expect(e.results).toEqual([]);
    expect(rt.dueling("a")).toBe(false);
  });

  it("a yield before the fight calls it off too", () => {
    const { rt } = dueling();
    const e = rt.yield("a", T0 + 1_000);
    expect(said(e, "duelEnd")[0]?.why).toBe("cancelled");
    expect(e.results).toEqual([]);
  });
});

describe("the fight", () => {
  it("lands a cast on the opponent alone, after its flight", () => {
    const { rt, add, move } = dueling();
    add("c", 3, 2, 0);
    rt.step(FIGHT);
    // A bystander right in the line of fire.
    move("c", 2, 0, FIGHT);
    const { yaw, pitch } = aim(A, B);
    expect(rt.cast("a", yaw, pitch, FIGHT + 10)).toBe("hit");
    expect(said(rt.step(FIGHT + 50), "duelHit", "a")).toEqual([]);
    const e = run(rt, FIGHT + 100, FIGHT + 1_000);
    const [hit] = said(e, "duelHit", "a");
    expect(hit.target).toBe(2);
    expect(hit.damage).toBeGreaterThan(0);
    const [hp] = said(e, "duelHp");
    expect(hp).toMatchObject({ id: 2, hp: hp.maxHp - hit.damage });
    expect(e.out.every((o) => o.to === "all" || o.to.uid !== "c")).toBe(true);
  });

  it("misses what it doesn't aim at", () => {
    const { rt } = dueling();
    rt.step(FIGHT);
    expect(rt.cast("a", -Math.PI / 2, 0, FIGHT + 10)).toBe("miss");
    expect(said(run(rt, FIGHT + 50, FIGHT + 1_000), "duelHit", "a")).toEqual([]);
  });

  it("holds casts to the budget", () => {
    const { rt } = dueling();
    rt.step(FIGHT);
    const { yaw, pitch } = aim(A, B);
    const results = [0, 1, 2].map(() => rt.cast("a", yaw, pitch, FIGHT + 10));
    expect(results).toEqual(["hit", "hit", "cooldown"]);
    expect(rt.cast("a", yaw, pitch, FIGHT + 10 + TUNING.castEveryMs)).toBe("hit");
  });

  it("a melee blow reaches only up close", () => {
    const { rt, move } = dueling(["percussionist", "bard"]);
    rt.step(FIGHT);
    const facing = aim(A, B).yaw;
    expect(rt.cast("a", facing, 0, FIGHT + 10)).toBe("miss");
    move("a", B.x - 1.5, 0, FIGHT + 20);
    expect(rt.cast("a", facing, 0, FIGHT + 30)).toBe("hit");
    expect(said(rt.step(FIGHT + 50), "duelHit", "a")).toHaveLength(1);
  });

  it("a bystander can't hurt a duelist, nor heal or buff one", () => {
    const { rt, add, move } = dueling();
    add("c", 3, 6, 0);
    rt.step(FIGHT);
    move("c", 6, 0, FIGHT);
    const { yaw, pitch } = aim({ x: 6, z: 0 }, B);
    expect(rt.cast("c", yaw, pitch, FIGHT + 10)).toBe("ignored");
    expect(rt.skill("c", "haste", yaw, pitch, FIGHT + 10).result).toBe("ignored");
    expect(said(run(rt, FIGHT, FIGHT + 1_000), "duelHp")).toEqual([]);
  });

  it("Taunt and Resurrect mean nothing; Drones heal the Bard alone", () => {
    const tank = dueling(["bard", "percussionist"]);
    tank.rt.step(FIGHT);
    expect(tank.rt.skill("b", "taunt", 0, 0, FIGHT + 10)).toMatchObject({
      result: "refused",
      reason: "duel",
      readyAt: 0,
    });
    expect(tank.rt.skill("a", "resurrect", 0, 0, FIGHT + 10)).toMatchObject({
      result: "refused",
      reason: "duel",
    });

    // b hurts a; a's Drones heal a alone.
    const { rt } = dueling();
    rt.step(FIGHT);
    const { yaw, pitch } = aim(B, A);
    rt.cast("b", yaw, pitch, FIGHT + 20);
    expect(said(run(rt, FIGHT + 50, FIGHT + 1_000), "duelHp")[0]?.id).toBe(1);
    const drones = rt.skill("a", "soothing-drones", 0, 0, FIGHT + 1_100);
    expect(drones.result).toBe("used");
    const [healed] = said(drones.out, "duelHp");
    expect(healed).toMatchObject({ id: 1 });
    expect(healed.hp).toBe(healed.maxHp);
    expect(rt.skill("a", "soothing-drones", 0, 0, FIGHT + 1_200).result).toBe(
      "cooldown",
    );
  });

  it("Haste is its own, and comes off at the end", () => {
    const { rt } = dueling();
    rt.step(FIGHT);
    const haste = rt.skill("a", "haste", 0, 0, FIGHT + 10);
    expect(said(haste.out, "buff")).toEqual([
      expect.objectContaining({ id: 1, buff: "haste" }),
    ]);
    const end = rt.yield("b", FIGHT + 1_000);
    expect(said(end, "buffOff")).toEqual([{ t: "buffOff", id: 1, buff: "haste" }]);
  });

  it("a Cymbrella's dome blocks the opponent's hits on its caster", () => {
    const { rt } = dueling(["bard", "percussionist"]);
    rt.step(FIGHT);
    const dome = rt.skill("b", "cymbrella", 0, 0, FIGHT + 10);
    expect(dome.result).toBe("used");
    expect(said(dome.out, "buff")[0]).toMatchObject({ id: 2, buff: "cymbrella" });
    const { yaw, pitch } = aim(A, B);
    rt.cast("a", yaw, pitch, FIGHT + 500);
    const e = run(rt, FIGHT + 550, FIGHT + 1_500);
    expect(said(e, "duelHit", "a")).toEqual([
      { t: "duelHit", target: 2, damage: 0, crit: false, blocked: true },
    ]);
    expect(said(e, "duelHp")).toEqual([]);
  });

  it("a Rimshot stuns, shorter each time in the window, holding the stunned", () => {
    // Every roll low: the stun always lands.
    const { rt, move } = dueling(["percussionist", "bard"], () => 0.01);
    rt.step(FIGHT);
    move("a", 6, 0, FIGHT);
    const castMs = SKILL_DEFS.rimshot.castMs ?? 0;
    const base = RIMSHOT.stunMs * DUEL.stunScale;
    expect(rt.skill("a", "rimshot", 0, 0, FIGHT + 50).result).toBe("used");
    // Its hands are busy winding up.
    expect(rt.cast("a", 0, 0, FIGHT + 60)).toBe("ignored");
    const first = run(rt, FIGHT + 100, FIGHT + 50 + castMs);
    expect(said(first, "duelStun")).toEqual([
      { t: "duelStun", id: 2, until: FIGHT + 50 + castMs + base },
    ]);
    expect(said(first, "duelHp").map((h) => h.id)).toEqual([2]);
    // Stunned: its casts are dropped and it's held where it stood.
    const now = FIGHT + 50 + castMs + 100;
    const { yaw, pitch } = aim(B, { x: 6, z: 0 });
    expect(rt.cast("b", yaw, pitch, now)).toBe("ignored");
    expect(rt.hold("b", B.x + 3, 0, now)).toMatchObject(B);
    expect(rt.hold("b", B.x, 0, FIGHT + 50 + castMs + base)).toBeNull();

    // Again within RIMSHOT.drWindowMs: half as long.
    const again = FIGHT + 50 + SKILL_DEFS.rimshot.cooldownMs;
    expect(rt.skill("a", "rimshot", 0, 0, again).result).toBe("used");
    const second = run(rt, again + 50, again + castMs);
    expect(said(second, "duelStun")).toEqual([
      { t: "duelStun", id: 2, until: again + castMs + base / 2 },
    ]);
  });

  it("outside the ring too long is a loss; back in, the timer stops", () => {
    const { rt, move } = dueling();
    rt.step(FIGHT);
    const outside = { x: 2 - DUEL.ringRadius - 1, z: 0 };
    move("a", outside.x, 0, FIGHT + 100);
    expect(said(run(rt, FIGHT + 100, FIGHT + 200), "duelOut", "a")).toEqual([
      { t: "duelOut", until: FIGHT + 100 + DUEL.outOfBoundsMs },
    ]);
    // Hits from out there do nothing.
    const { yaw, pitch } = aim(outside, B);
    expect(rt.cast("a", yaw, pitch, FIGHT + 300)).toBe("miss");
    move("a", 0, 0, FIGHT + 1_000);
    expect(said(rt.step(FIGHT + 1_000), "duelOut", "a")).toEqual([
      { t: "duelOut", until: null },
    ]);
    move("a", outside.x, 0, FIGHT + 2_000);
    const e = run(rt, FIGHT + 2_000, FIGHT + 2_000 + DUEL.outOfBoundsMs + 100);
    expect(said(e, "duelEnd")[0]).toMatchObject({
      why: "bounds",
      winner: 2,
      loser: 1,
    });
    expect(e.results[0]).toMatchObject({ why: "bounds", winner: "b" });
  });

  it("brings one to its knees: a defeat, reported", () => {
    const { rt } = dueling();
    rt.step(FIGHT);
    const { yaw, pitch } = aim(A, B);
    let end: Msg<"duelEnd"> | undefined;
    let results: DuelEffects["results"] = [];
    let at = FIGHT;
    for (; at < FIGHT + 60_000 && !end; at += 50) {
      if ((at - FIGHT) % 450 === 0) rt.cast("a", yaw, pitch, at);
      const e = rt.step(at);
      end = said(e, "duelEnd")[0];
      results = e.results;
    }
    expect(end).toMatchObject({ why: "defeat", winner: 1, loser: 2 });
    expect(end?.rematchUntil).toBeGreaterThan(0);
    const [r] = results;
    expect(r).toMatchObject({ a: "a", b: "b", winner: "a", why: "defeat" });
    expect(r.damage.a).toBe(r.maxHp.b);
    expect(r.damage.b).toBe(0);
    // The loser dealt nothing: no credit.
    expect(r.credited).toBe(false);
    expect(r.id).toBe(`home:test:${T0}:1`);
    expect(rt.dueling("a")).toBe(false);
    expect(rt.justEnded("a", at)).toBe(true);
  });

  it("goes into sudden death, and hits harder there", () => {
    const { rt } = dueling(["bard", "bard"], () => 0.5);
    const { yaw, pitch } = aim(A, B);
    const hitAt = (t: number) => {
      rt.cast("a", yaw, pitch, t);
      return said(run(rt, t, t + 1_000), "duelHit", "a")[0]?.damage;
    };
    rt.step(FIGHT);
    const plain = hitAt(FIGHT + 10_000);
    expect(plain).toBe(bardHit(0.5, 10_500));
    const late = run(rt, FIGHT + 11_050, FIGHT + DUEL.regulationMs + 100);
    expect(said(late, "duel").map((d) => d.phase)).toEqual(["fight"]);
    const sudden = hitAt(FIGHT + DUEL.regulationMs + 1_000);
    expect(sudden).toBe(bardHit(0.5, DUEL.regulationMs + 1_500));
    expect(sudden).toBeGreaterThan(plain);
  });

  it("at the hard cap the higher share of health wins, or it's a draw", () => {
    const level = dueling();
    const draw = run(level.rt, FIGHT, FIGHT + DUEL.hardCapMs);
    expect(said(draw, "duelEnd")[0]).toMatchObject({ why: "draw", winner: null });
    expect(draw.results[0]).toMatchObject({
      why: "draw",
      winner: null,
      credited: false,
    });

    const ahead = dueling();
    ahead.rt.step(FIGHT);
    const { yaw, pitch } = aim(A, B);
    ahead.rt.cast("a", yaw, pitch, FIGHT + 10);
    const time = run(ahead.rt, FIGHT + 50, FIGHT + DUEL.hardCapMs);
    expect(said(time, "duelEnd")[0]).toMatchObject({
      why: "time",
      winner: 1,
      loser: 2,
      ms: DUEL.hardCapMs,
    });
  });

  it("a yield is a loss, and both may then ask for a rematch", () => {
    const { rt } = dueling();
    rt.step(FIGHT);
    const e = rt.yield("b", FIGHT + 5_000);
    const [end] = said(e, "duelEnd");
    expect(end).toMatchObject({ why: "yield", winner: 1, loser: 2, ms: 5_000 });
    expect(end.rematchUntil).toBe(FIGHT + 5_000 + DUEL.rematchMs);
    expect(e.results[0]).toMatchObject({ why: "yield", winner: "a", ms: 5_000 });

    const first = rt.rematch("a", FIGHT + 6_000);
    expect(said(first, "duelRematch", "b")).toEqual([{ t: "duelRematch", by: 1 }]);
    const both = rt.rematch("b", FIGHT + 7_000);
    const [d] = said(both, "duel");
    expect(d).toMatchObject({ phase: "countdown", intro: false, id: 2 });
    expect(d.startsAt - d.at).toBe(duelCountdownMs(false));
    expect(both.place).toHaveLength(2);
  });

  it("a rematch asked too late doesn't happen", () => {
    const { rt } = dueling();
    rt.step(FIGHT);
    rt.yield("b", FIGHT + 5_000);
    const late = rt.rematch("a", FIGHT + 5_001 + DUEL.rematchMs);
    expect(said(late, "duelNo", "a")).toEqual([
      { t: "duelNo", with: 2, why: "expired" },
    ]);
  });

  it("casts arriving just after the end are dropped, not struck", () => {
    const { rt } = dueling();
    rt.step(FIGHT);
    rt.yield("a", FIGHT + 1_000);
    expect(rt.justEnded("a", FIGHT + 1_000 + DUEL_AFTERCAST_MS - 1)).toBe(true);
    expect(rt.justEnded("a", FIGHT + 1_000 + DUEL_AFTERCAST_MS)).toBe(false);
    expect(rt.cast("a", 0, 0, FIGHT + 1_100)).toBe("ignored");
  });
});

describe("connections", () => {
  it("a drop mid-fight waits for it; back in time, the duel goes on", () => {
    const { rt } = dueling();
    rt.step(FIGHT);
    const gone = rt.gone("b", FIGHT + 1_000);
    expect(said(gone, "duelAway")).toEqual([
      { t: "duelAway", id: 2, until: FIGHT + 1_000 + DUEL.reconnectMs },
    ]);
    expect(rt.holds("b")).toBe(true);
    // Still standing there, and still hittable.
    const { yaw, pitch } = aim(A, B);
    expect(rt.cast("a", yaw, pitch, FIGHT + 2_000)).toBe("hit");
    expect(said(run(rt, FIGHT + 2_050, FIGHT + 3_000), "duelHit", "a")).toHaveLength(1);
    const back = rt.back("b", FIGHT + 4_000);
    expect(said(back, "duelAway")).toEqual([{ t: "duelAway", id: 2, until: null }]);
    expect(rt.holds("b")).toBe(false);
    expect(rt.states()[0]).toMatchObject({ phase: "fight", a: 1, b: 2 });
    const e = run(rt, FIGHT + 4_000, FIGHT + 4_000 + DUEL.reconnectMs);
    expect(said(e, "duelEnd")).toEqual([]);
  });

  it("not back in time is a loss, and no rematch", () => {
    const { rt } = dueling();
    rt.step(FIGHT);
    rt.gone("b", FIGHT + 1_000);
    const e = run(rt, FIGHT + 1_000, FIGHT + 1_000 + DUEL.reconnectMs);
    const [end] = said(e, "duelEnd");
    expect(end).toMatchObject({ why: "left", winner: 1, loser: 2 });
    expect(end.rematchUntil).toBeUndefined();
    expect(rt.holds("b")).toBe(false);
    expect(e.results[0]).toMatchObject({ why: "left", winner: "a" });
  });

  it("both gone: a draw", () => {
    const { rt } = dueling();
    rt.step(FIGHT);
    rt.gone("b", FIGHT + 1_000);
    const e = rt.gone("a", FIGHT + 2_000);
    expect(said(e, "duelEnd")[0]).toMatchObject({ why: "draw", winner: null });
    expect(e.results[0]).toMatchObject({ why: "draw", winner: null });
    expect(rt.holds("b")).toBe(false);
  });

  it("a leaver's challenges go with it", () => {
    const w = room();
    w.add("a", 1, 0, 0);
    w.add("b", 2, 4, 0);
    w.rt.ask("a", 2, T0);
    w.peers.delete("b");
    const e = w.rt.gone("b", T0 + 100);
    expect(said(e, "duelNo", "a")).toEqual([{ t: "duelNo", with: 2, why: "gone" }]);
    expect(w.rt.live).toBe(false);
  });
});

describe("stats", () => {
  it("are the ticket's at the accept: a renewed one changes nothing", () => {
    const { rt, peers } = dueling(["bard", "bard"], () => 0.5);
    // Both tickets renewed mid-duel, forty levels stronger.
    const strong = realTicket("a", "bard", 60);
    for (const p of peers.values())
      p.combat = { ...p.combat, st: strong.st, lv: 60 };
    rt.step(FIGHT);
    const { yaw, pitch } = aim(A, B);
    rt.cast("a", yaw, pitch, FIGHT + 10);
    const [hit] = said(run(rt, FIGHT + 50, FIGHT + 1_000), "duelHit", "a");
    expect(hit.damage).toBe(bardHit(0.5, 500));
    expect(rt.states()[0].hp.map((h) => h.maxHp)).toEqual([
      duelMaxHp(20),
      duelMaxHp(20),
    ]);
  });

  it("duel health is the level's, whatever the Stamina", () => {
    const { rt } = dueling(["percussionist", "bard"]);
    const [a, b] = rt.states()[0].hp;
    expect(a.maxHp).toBe(b.maxHp);
    expect(a.maxHp).toBeLessThan(
      realTicket("a", "percussionist", 20).hp?.maxHp ?? 0,
    );
  });
});

describe("balance", () => {
  const ROLES: Role[] = ["bard", "record_slinger", "percussionist"];
  const pairs = ROLES.flatMap((r, i) =>
    ROLES.slice(i).map((o) => [r, o] as [Role, Role]),
  );

  /** Two herzies of `level` up close (where a Percussionist's stick
   * reaches), each in `casting` landing every basic cast at the cast
   * budget's pace: how long the fight runs (ms). */
  function fightMs(
    roles: [Role, Role],
    level: number,
    seed: number,
    casting: readonly ("a" | "b")[] = ["a", "b"],
  ): number {
    const { rt, move } = dueling(roles, rng(seed), level);
    rt.step(FIGHT);
    const near = { x: B.x - 1.5, z: 0 };
    move("a", near.x, near.z, FIGHT);
    const at = { a: aim(near, B), b: aim(B, near) };
    for (let t = FIGHT; t < FIGHT + DUEL.hardCapMs; t += 10) {
      if ((t - FIGHT) % TUNING.castEveryMs < 10)
        for (const who of casting) rt.cast(who, at[who].yaw, at[who].pitch, t);
      const [end] = said(rt.step(t), "duelEnd");
      if (end) return end.ms;
    }
    return Number.POSITIVE_INFINITY;
  }

  it("every pairing of the classes takes 15 to 30 s, at level 20 and 40", () => {
    for (const level of [20, 40])
      for (const roles of pairs)
        for (const seed of [1, 2]) {
          const ms = fightMs(roles, level, seed);
          expect(ms, `${roles.join(" v ")} at ${level}`).toBeGreaterThanOrEqual(
            15_000,
          );
          expect(ms, `${roles.join(" v ")} at ${level}`).toBeLessThanOrEqual(
            30_000,
          );
        }
  });

  it("neither class of a pairing wins by much more than a third", () => {
    for (const level of [20, 40])
      for (const [x, y] of pairs.filter(([x, y]) => x !== y))
        for (const seed of [1, 2]) {
          const xKills = fightMs([x, y], level, seed, ["a"]);
          const yKills = fightMs([x, y], level, seed, ["b"]);
          const ratio = xKills / yKills;
          expect(ratio, `${x} v ${y} at ${level}`).toBeGreaterThanOrEqual(0.75);
          expect(ratio, `${x} v ${y} at ${level}`).toBeLessThanOrEqual(1.33);
        }
  });
});
