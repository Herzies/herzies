import { DUEL } from "@herzies/shared/duel";
import type {
  DuelClientOp,
  DuelState,
  ServerMessage,
} from "@herzies/shared/town-net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blockDuels,
  type DuelContext,
  type DuelEvent,
  duel,
  duelFighting,
  duelHeld,
  handleDuelMessage,
  inDuel,
  myOpponent,
  onDuelEvent,
  pruneDuels,
  RING_FADE_MS,
  refusalText,
  resetDuels,
  setDuelFriends,
  setDuelRequests,
} from "./store";

/** The server's clock runs this far behind this machine's. */
const OFFSET = 5_000;
let now = 0;
let sent: DuelClientOp[] = [];
let events: DuelEvent[] = [];
let off: () => void = () => {};

const names: Record<number, { name: string; seed: string; title?: string }> = {
  2: { name: "Ada", seed: "ada-seed", title: "duel-10" },
  3: { name: "Bo", seed: "bo-seed" },
};
const ctx: DuelContext = {
  toLocal: (t) => t + OFFSET,
  you: () => 1,
  who: (id) => names[id],
  send: (op) => sent.push(op),
};
const recv = (m: ServerMessage) => handleDuelMessage(m, ctx);

/** A duel between you (1) and Ada (2), its countdown begun at server
 * time `at`. */
function state(over: Partial<DuelState> = {}): DuelState {
  const at = over.at ?? 1_000;
  const startsAt = at + DUEL.introMs + 3 * DUEL.countMs;
  return {
    id: 9,
    a: 1,
    b: 2,
    x: 0,
    z: 0,
    phase: "countdown",
    intro: true,
    at,
    startsAt,
    suddenAt: startsAt + DUEL.regulationMs,
    endsAt: startsAt + DUEL.hardCapMs,
    marks: { a: { x: -6, z: 0 }, b: { x: 6, z: 0 } },
    hp: [
      { id: 1, hp: 300, maxHp: 300 },
      { id: 2, hp: 280, maxHp: 280 },
    ],
    ...over,
  };
}

beforeEach(() => {
  now = 0;
  sent = [];
  events = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  off = onDuelEvent((e) => events.push(e));
  setDuelRequests("everyone");
  setDuelFriends([]);
  duel.result = null;
  recv({ t: "welcome", you: 1, players: [] });
});
afterEach(() => {
  off();
  resetDuels();
  vi.restoreAllMocks();
});

describe("challenges", () => {
  it("shows a challenge with its time to answer, and chimes", () => {
    now = 100;
    recv({ t: "duelAsk", from: 2, lv: 34, cls: "bard", ttl: 20_000 });
    expect(duel.invite).toMatchObject({
      from: 2,
      lv: 34,
      cls: "bard",
      until: 20_100,
      who: { name: "Ada" },
    });
    expect(events.map((e) => e.k)).toEqual(["ask"]);
    expect(sent).toEqual([]);
  });

  it("turns challenges down unasked as the setting says", () => {
    setDuelRequests("nobody");
    recv({ t: "duelAsk", from: 2, ttl: 20_000 });
    expect(duel.invite).toBeNull();
    expect(sent).toEqual([{ op: "answer", from: 2, yes: false, auto: true }]);
    expect(events).toEqual([]);

    sent = [];
    setDuelRequests("friends");
    setDuelFriends(["ada-seed"]);
    recv({ t: "duelAsk", from: 3, ttl: 20_000 });
    expect(sent).toEqual([{ op: "answer", from: 3, yes: false, auto: true }]);
    recv({ t: "duelAsk", from: 2, ttl: 20_000 });
    expect(duel.invite?.from).toBe(2);
  });

  it("keeps turning down a herzie you blocked", () => {
    blockDuels("bo-seed");
    recv({ t: "duelAsk", from: 3, ttl: 20_000 });
    expect(duel.invite).toBeNull();
    expect(sent[0]).toMatchObject({ from: 3, auto: true });
  });

  it("drops the challenge when it's withdrawn", () => {
    recv({ t: "duelAsk", from: 2, ttl: 20_000 });
    recv({ t: "duelAskGone", from: 3 });
    expect(duel.invite).not.toBeNull();
    recv({ t: "duelAskGone", from: 2 });
    expect(duel.invite).toBeNull();
  });

  it("waits on your challenge, and says neutrally why it came to nothing", () => {
    now = 50;
    recv({ t: "duelAsked", to: 2, ttl: 20_000 });
    expect(duel.outgoing).toMatchObject({ to: 2, until: 20_050 });
    recv({ t: "duelNo", with: 2, why: "expired" });
    expect(duel.outgoing).toBeNull();
    expect(events).toEqual([{ k: "refused", text: '"Ada" didn\'t answer.' }]);
  });

  it("puts a cooldown in minutes and seconds", () => {
    expect(refusalText("cooldown", "Ada", { retryIn: 23_400 })).toBe(
      'You can challenge "Ada" again in 0:24.',
    );
    expect(refusalText("auto", "Ada")).toBe('"Ada" isn\'t accepting duels.');
    expect(refusalText("far", "Ada", { accepting: true })).toMatch(/off/);
    expect(refusalText("cancelled", "Ada")).toBeNull();
  });
});

describe("a duel", () => {
  it("starts with whatever was pending cleared, and you in it", () => {
    recv({ t: "duelAsked", to: 3, ttl: 20_000 });
    duel.result = {
      id: 1,
      opponent: 2,
      who: names[2],
      won: true,
      why: "defeat",
      ms: 1,
      hits: 1,
      at: 0,
      rematchUntil: null,
      rematchAsked: true,
      rematchBy: true,
    };
    recv({ t: "duel", ...state() });
    expect(duel.outgoing).toBeNull();
    expect(duel.result).toBeNull();
    expect(inDuel()).toBe(true);
    expect(myOpponent()).toBe(2);
    expect(duel.foe?.name).toBe("Ada");
    expect(events.at(-1)).toMatchObject({ k: "start", mine: true });
  });

  it("holds you until FIGHT! by the server's clock, then lets go", () => {
    const s = state();
    recv({ t: "duel", ...s });
    now = s.startsAt + OFFSET - 1;
    expect(duelHeld()).toBe(true);
    expect(duelFighting()).toBe(false);
    now = s.startsAt + OFFSET;
    expect(duelHeld()).toBe(false);
    expect(duelFighting()).toBe(true);
  });

  it("holds you again while stunned", () => {
    const s = state();
    recv({ t: "duel", ...s, phase: "fight" });
    now = s.startsAt + OFFSET + 100;
    recv({ t: "duelStun", id: 1, until: s.startsAt + 1_000 });
    expect(duelHeld()).toBe(true);
    now = s.startsAt + OFFSET + 1_000;
    expect(duelHeld()).toBe(false);
    // Someone else's stun isn't yours.
    recv({ t: "duelStun", id: 2, until: s.startsAt + 5_000 });
    expect(duelHeld()).toBe(false);
  });

  it("takes a phase's news without starting over", () => {
    const s = state();
    recv({ t: "duel", ...s });
    recv({ t: "duelHp", id: 2, hp: 200, maxHp: 280 });
    events = [];
    recv({ t: "duel", ...s, phase: "fight" });
    expect(events).toEqual([]);
    expect(duel.rooms.get(9)?.phase).toBe("fight");
    expect(duel.rooms.get(9)?.health.get(2)?.hp).toBe(200);
  });

  it("tells health with what it was", () => {
    recv({ t: "duel", ...state() });
    recv({ t: "duelHp", id: 2, hp: 250, maxHp: 280 });
    expect(events.at(-1)).toMatchObject({ k: "hp", id: 2, hp: 250, was: 280 });
  });

  it("ends with your result, and its ring fades after", () => {
    recv({ t: "duel", ...state() });
    now = 10_000;
    recv({
      t: "duelEnd",
      id: 9,
      a: 1,
      b: 2,
      winner: 2,
      loser: 1,
      why: "defeat",
      ms: 47_000,
      tally: [
        { id: 1, damage: 150, hits: 12 },
        { id: 2, damage: 300, hits: 15 },
      ],
      rematchUntil: 30_000,
    });
    expect(inDuel()).toBe(false);
    expect(duel.result).toMatchObject({
      opponent: 2,
      won: false,
      hits: 12,
      ms: 47_000,
      rematchUntil: 30_000,
      at: 10_000,
    });
    expect(duel.rooms.get(9)?.health.get(1)?.hp).toBe(0);
    pruneDuels(10_000 + RING_FADE_MS - 1);
    expect(duel.rooms.has(9)).toBe(true);
    pruneDuels(10_000 + RING_FADE_MS + 1);
    expect(duel.rooms.has(9)).toBe(false);

    recv({ t: "duelRematch", by: 2 });
    expect(duel.result?.rematchBy).toBe(true);
    recv({ t: "duelNo", with: 2, why: "far" });
    expect(duel.result).toMatchObject({ rematchBy: false, rematchUntil: null });
    expect(events.at(-1)).toEqual({
      k: "refused",
      text: 'Too far from "Ada" for a rematch.',
    });
  });

  it("says why a rematch is off, in a rematch's words", () => {
    recv({ t: "duel", ...state() });
    recv({
      t: "duelEnd",
      id: 9,
      a: 1,
      b: 2,
      winner: 1,
      loser: 2,
      why: "defeat",
      ms: 20_000,
      tally: [],
      rematchUntil: 40_000,
    });
    const said = (why: "expired" | "busy" | "gone") => {
      recv({ t: "duelNo", with: 2, why });
      return events.at(-1);
    };
    expect(said("expired")).toEqual({
      k: "refused",
      text: "The rematch window closed.",
    });
    expect(said("busy")).toEqual({ k: "refused", text: '"Ada" is busy.' });
    // Gone from the room: still named as they were in the duel.
    const was = names[2];
    delete names[2];
    try {
      expect(said("gone")).toEqual({ k: "refused", text: '"Ada" left.' });
    } finally {
      names[2] = was;
    }
  });

  it("treats a fresh challenge to your last opponent as a challenge", () => {
    recv({ t: "duel", ...state() });
    recv({
      t: "duelEnd",
      id: 9,
      a: 1,
      b: 2,
      winner: 1,
      loser: 2,
      why: "defeat",
      ms: 20_000,
      tally: [],
    });
    recv({ t: "duelAsked", to: 2, ttl: 20_000 });
    recv({ t: "duelNo", with: 2, why: "expired" });
    expect(events.at(-1)).toEqual({
      k: "refused",
      text: '"Ada" didn\'t answer.',
    });
  });

  it("isn't yours to fight when two others duel", () => {
    recv({ t: "duelAsk", from: 2, ttl: 20_000 });
    recv({ t: "duel", ...state({ a: 2, b: 3 }) });
    expect(inDuel()).toBe(false);
    // Ada's busy now: her challenge is moot.
    expect(duel.invite).toBeNull();
    expect(events.at(-1)).toMatchObject({ k: "start", mine: false });
  });

  it("picks a duel back up after a dropped connection, drawn as it stands", () => {
    recv({
      t: "welcome",
      you: 1,
      players: [],
      duels: [state({ phase: "fight" })],
    });
    expect(inDuel()).toBe(true);
    expect(duel.rooms.get(9)?.seenAt).toBe(Number.NEGATIVE_INFINITY);
    expect(duel.foe?.name).toBe("Ada");
  });
});
