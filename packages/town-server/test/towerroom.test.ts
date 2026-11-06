/**
 * The Tower through a real Durable Object: the move guard in a fight room.
 * Walking is checked in real time (the room stamps frames as they arrive),
 * so these tests walk at a herzie's pace.
 */
import {
  encodeStateFrame,
  type ServerMessage,
  signTownTicket,
  TOWN_MAPS,
  TOWN_PROTOCOL,
  TOWN_SPRINT_SPEED,
} from "@herzies/shared/town-net";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { armed } from "./arms";

const SECRET = "test-secret";
const FRAME_MS = 1000 / 15;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function enter(uid: string) {
  const res = await exports.default.fetch(
    `https://town.test/v1/town/tower?shard=0&i=${uid}`,
    { headers: { upgrade: "websocket" } },
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status}`);
  ws.accept();
  (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
  const messages: ServerMessage[] = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") messages.push(JSON.parse(e.data));
  });
  const { spawn } = TOWN_MAPS.tower;
  ws.send(
    JSON.stringify({
      t: "hello",
      v: TOWN_PROTOCOL,
      ticket: await signTownTicket(
        armed({
          uid,
          name: uid,
          look: { seed: `HERZ-${uid}`, stage: 2 },
          cls: "bard",
          exp: Date.now() / 1000 + 600,
          hp: { hp: 5_000, maxHp: 5_000, down: false },
          st: [0, 0, 0, 0],
          lv: 60,
          tower: {
            event: "evt-tower-test",
            until: Date.now() / 1000 + 600,
            floor: 1,
          },
        }),
        SECRET,
      ),
      at: { x: spawn.x, z: spawn.z, heading: 0, speed: 0, flags: 0 },
    }),
  );
  let seq = 0;
  const frame = (x: number, z: number) =>
    ws.send(encodeStateFrame(++seq, { x, z, heading: 0, speed: 0, flags: 0 }));
  return { ws, messages, frame };
}

describe("the Tower's room", () => {
  it("won't let a herzie mid-floor step onto the spawn from across the island", async () => {
    const c = await enter("0000aaaa-0000-4000-8000-00000000beef");
    for (let i = 0; i < 40 && !c.messages.some((m) => m.t === "welcome"); i++)
      await sleep(50);
    expect(c.messages.some((m) => m.t === "welcome")).toBe(true);
    // Walk across, a sprint's step a frame: every frame passes.
    const { spawn } = TOWN_MAPS.tower;
    let x: number = spawn.x;
    const to = -spawn.x;
    while (x < to) {
      x = Math.min(to, x + TOWN_SPRINT_SPEED * (FRAME_MS / 1000));
      c.frame(x, spawn.z);
      await sleep(FRAME_MS);
    }
    await sleep(200);
    expect(c.messages.filter((m) => m.t === "correct")).toHaveLength(0);
    // Then straight back onto the spawn, ~25 m in one frame: a respawn in
    // town, a teleport out of every attack here.
    c.frame(spawn.x, spawn.z);
    await sleep(300);
    const corrected = c.messages.filter((m) => m.t === "correct");
    expect(corrected).toHaveLength(1);
    const back = corrected[0] as Extract<ServerMessage, { t: "correct" }>;
    expect(back.x).toBeCloseTo(to, 0);
    c.ws.close();
  }, 15_000);
});
