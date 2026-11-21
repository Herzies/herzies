/**
 * A duel through a real Durable Object: two herzies in Town challenge,
 * accept, count down, trade a hit, drop and come back, and one yields. On
 * Home's shard 0, which room.test.ts leaves alone (its rooms are shards 1
 * up). The room keeps its own clock, so this waits out the real countdown
 * (about 3 s).
 */
import { HERZIE_BODY, WAVE_HAND_HEIGHT } from "@herzies/shared/combat";
import { TITLES } from "@herzies/shared/titles";
import {
  encodeCastFrame,
  type ServerMessage,
  signTownTicket,
  TOWN_PROTOCOL,
} from "@herzies/shared/town-net";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { realTicket } from "./herzies";

const SECRET = "test-secret";
const TITLE = TITLES[0].id;

async function connect(shard: number) {
  const res = await exports.default.fetch(
    `https://town.test/v1/town/home?shard=${shard}`,
    { headers: { upgrade: "websocket" } },
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status}`);
  ws.accept();
  (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
  const messages: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") messages.push(JSON.parse(e.data));
    for (const w of waiters.splice(0)) w();
  });
  const next = async <T extends ServerMessage["t"]>(
    t: T,
    where: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
  ) => {
    for (let i = 0; i < 200; i++) {
      const idx = messages.findIndex(
        (m) => m.t === t && where(m as Extract<ServerMessage, { t: T }>),
      );
      if (idx >= 0)
        return messages.splice(idx, 1)[0] as Extract<ServerMessage, { t: T }>;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    throw new Error(`no ${t} message`);
  };
  return { ws, messages, next };
}

async function join(shard: number, uid: string, x: number, title?: string) {
  const c = await connect(shard);
  const t = { ...realTicket(uid, "bard", 20), ...(title ? { ti: title } : {}) };
  c.ws.send(
    JSON.stringify({
      t: "hello",
      v: TOWN_PROTOCOL,
      ticket: await signTownTicket(t, SECRET),
      at: { x, z: 0, heading: 0, speed: 0, flags: 0 },
    }),
  );
  const welcome = await c.next("welcome");
  return { ...c, id: welcome.you, welcome };
}

const send = (ws: WebSocket, m: unknown) => ws.send(JSON.stringify(m));

describe("a duel in a room", () => {
  it("is asked, accepted, counted down, fought, dropped, resumed and yielded", async () => {
    const a = await join(0, "duel-a", 0, TITLE);
    const b = await join(0, "duel-b", 4, "not-a-title");
    // Titles under names: a real one shows, a made-up one doesn't.
    expect(b.welcome.players).toEqual([
      expect.objectContaining({ id: a.id, title: TITLE }),
    ]);
    const joined = await a.next("join");
    expect(joined.player.title).toBeUndefined();

    send(a.ws, { t: "duel", op: "ask", to: b.id });
    expect(await b.next("duelAsk")).toMatchObject({ from: a.id, lv: 20, cls: "bard" });
    expect(await a.next("duelAsked")).toMatchObject({ to: b.id });

    send(b.ws, { t: "duel", op: "answer", from: a.id, yes: true });
    const countdown = await a.next("duel", (d) => d.phase === "countdown");
    expect(countdown).toMatchObject({ a: a.id, b: b.id, intro: true, x: 2, z: 0 });
    await b.next("duel", (d) => d.phase === "countdown");
    // Each is put on its mark.
    expect(await a.next("correct")).toEqual({ t: "correct", ...countdown.marks.a });
    expect(await b.next("correct")).toEqual({ t: "correct", ...countdown.marks.b });

    // FIGHT! (after the VS card and the 3-2-1).
    const fight = await a.next("duel", (d) => d.phase === "fight");
    expect(fight.startsAt).toBe(countdown.startsAt);

    // A wave from a's mark at b's lands on b.
    const from = countdown.marks.a;
    const to = countdown.marks.b;
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    a.ws.send(
      encodeCastFrame({
        seq: 1,
        yaw: Math.atan2(to.x - from.x, to.z - from.z),
        pitch: Math.atan2(HERZIE_BODY.chest - WAVE_HAND_HEIGHT, dist),
      }),
    );
    const hit = await a.next("duelHit");
    expect(hit).toMatchObject({ target: b.id, crit: false });
    expect(hit.damage).toBeGreaterThan(0);
    const hp = await b.next("duelHp");
    expect(hp).toMatchObject({ id: b.id, hp: hp.maxHp - hit.damage });

    // b's connection drops: it stays standing, and a hears it may be back.
    b.ws.close(1000);
    const away = await a.next("duelAway");
    expect(away).toMatchObject({ id: b.id });
    expect(away.until).toBeGreaterThan(Date.now());
    expect(a.messages.some((m) => m.t === "leave")).toBe(false);

    // It comes back under the same id, to the duel still on.
    const back = await join(0, "duel-b", 4);
    expect(back.id).toBe(b.id);
    expect(back.welcome.duels).toEqual([
      expect.objectContaining({ id: fight.id, phase: "fight" }),
    ]);
    expect(await back.next("correct")).toEqual({ t: "correct", ...to });
    expect(await a.next("duelAway", (m) => m.until === null)).toMatchObject({
      id: b.id,
    });

    send(back.ws, { t: "duel", op: "yield" });
    const end = await a.next("duelEnd");
    expect(end).toMatchObject({
      id: fight.id,
      winner: a.id,
      loser: b.id,
      why: "yield",
    });
    expect(end.tally).toContainEqual({ id: a.id, damage: hit.damage, hits: 1 });
    expect(end.rematchUntil).toBeGreaterThan(Date.now());
    expect((await back.next("duelEnd")).why).toBe("yield");
  });
});
