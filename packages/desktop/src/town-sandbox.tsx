// Dev only (not in the build's inputs): the 3D Town with made-up visitors
// and a player, without logging in. `pnpm vite:dev`, then open
// /town-sandbox.html. `?shadows=0` turns the sun's shadows off, `?ao=0`
// the ambient occlusion, and `?bench=1` times the renderer (`?bench=frame`
// whole frames, composer included; see bench).
// `?time=` sets the hour, and `&speed=` runs the clock on from there,
// that many hours a second (to watch the light and shadows move).
// `?net=local` joins the multiplayer Town on `wrangler dev` (in
// packages/town-server, with TOWN_TICKET_SECRET=dev-town-secret in .dev.vars);
// `&name=` and `&server=ws://…` to taste. Open it twice to see each other.
// `?map=bossroom` (with `?net=local`) joins the boss's cave on `wrangler dev`
// (`&lobby=20` makes it a raid that locks 20 s after loading; `&per=` sets
// its health per herzie)
// with a made-up boss (and `&cave=open` opens the cave's door in town); the
// HUD is drawn over it. `&boss=<hp>` sets the boss's health, `&hp=<n>` yours.
// `?map=tower` (with `?net=local`) climbs the Tower on `wrangler dev`, in a
// room of your own (`&floor=` to start higher, `&level=` your herzie's
// level); `&tower=open` opens its door in town.
// `?music=1` plays music, as it were: stand still and the herzie dances.
// `?class=record_slinger` (or bard, percussionist) hands the player that
// class's gear, basic attack and skill (Q; `&skill=` its level; the cave's
// server hears of the class too).
// `?color=`, `?head=` and `?spirit=` dress the player (`?head=rainbow-headband`
// with the default prism skin is the full Prismatic set).
import "./globals.css";
import {
  attackStyle,
  CLASS_DEFS,
  type ItemUnit,
  isHerzieClass,
  signTownTicket,
} from "@herzies/shared";
import type { RootState } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Notices } from "./components/Notices";
import type { EventCard } from "./components/TownScene";
import { TownVitals } from "./components/TownVitals";
import { BossHud } from "./components/town/BossHud";
import { BossResults } from "./components/town/BossResults";
import { setCave } from "./components/town/cave";
import {
  bubbleDuration,
  type ChatBubbles,
} from "./components/town/chatBubbles";
import {
  sampleBossResults,
  setBossResults,
} from "./components/town/combat/results";
import { setMySkills } from "./components/town/combat/skills";
import { combat } from "./components/town/combat/state";
import { setTowerOpen } from "./components/town/gates";
import { Hotbar } from "./components/town/Hotbar";
import { assignHotbar } from "./components/town/hotbarSlots";
import { setTownTicketSource, townNet } from "./components/town/net/townNet";
import {
  goToMap,
  HOME_MAP,
  spotsOf,
  type TownSpot,
  townLive,
  townSave,
} from "./components/town/runtime";
import { SkillHud } from "./components/town/SkillHud";
import TownCanvas from "./components/town/TownCanvas";
import { setVitals } from "./components/town/vitals";

const params = new URLSearchParams(location.search);
const { spots: SPOTS, spare: SPARE_SPOTS } = spotsOf(HOME_MAP);
// Start on another island: ?map=arena .
if (params.has("map")) goToMap(params.get("map") as string);

const startHour = params.has("time") ? Number(params.get("time")) : null;
const speed = Number(params.get("speed") ?? 0);
const startedAt = performance.now();
const sandboxHour =
  startHour !== null && speed > 0
    ? () => (startHour + ((performance.now() - startedAt) / 1000) * speed) % 24
    : startHour;

const card = (type: string, title: string): EventCard => ({
  type,
  title,
  description: null,
  status: "live",
  at: null,
  // The residents open; the rest are scenery.
  openKey: type === "boboku" || type === "medea" ? type : null,
  eventId: `sandbox-${type}`,
});

const spots: TownSpot[] = [
  ["merchant", "Good ol' George"],
  ["treat_trader", "Nandor"],
  ["boss_fight", "The boss"],
  ["song_hunt", "Orphiez"],
  ["boboku", "Boboku"],
  ["medea", "Medea"],
]
  // Only those the map has a spot for (the boss lives in its cave now).
  .filter(([type]) => SPOTS[type])
  .map(([type, title]) => ({
    key: type,
    card: card(type, title),
    at: SPOTS[type],
    standing: true,
    status: "in town",
  }));
// `?visitors=6` fills the spare spots too: the most the Town shows.
const extra = Math.max(0, Number(params.get("visitors") ?? 4) - spots.length);
SPARE_SPOTS.slice(0, extra).forEach((at, i) => {
  spots.push({
    key: `spare${i}`,
    card: card(`spare${i}`, `Visitor ${i + 1}`),
    at,
    standing: true,
    status: "in town",
  });
});

// Start somewhere else, looking some way: ?x=&z=&heading=&polar= .
for (const k of ["x", "z", "heading", "polar"] as const) {
  if (params.has(k)) townSave[k] = Number(params.get(k));
}
if (params.has("heading")) townSave.azimuth = townSave.heading - Math.PI;
// `?azimuth=` swings the camera round (radians; the heading's opposite is
// behind it), to look at the herzie from the front or side.
if (params.has("azimuth")) townSave.azimuth = Number(params.get("azimuth"));
townLive.music = params.get("music") === "1";
const player = {
  seed: params.get("seed") ?? "sandbox-player",
  stage: Number(params.get("stage") ?? 3),
  equipped: {
    color: params.get("color") ?? "prism",
    head: params.get("head") ?? "headphones",
    spirit: params.get("spirit") ?? "spirit-orb",
  } as Record<string, string>,
};
// `?hotbar=star-candy`: that item on slot 2, with three in a pretend bank.
const hotbarParam = params.get("hotbar");
if (hotbarParam) assignHotbar("2", hotbarParam);
const hotbarUnits: ItemUnit[] = hotbarParam
  ? [0, 1, 2].map((i) => ({
      id: `sandbox-${i}`,
      itemId: hotbarParam,
      upgradeLevel: 0,
      equippedSlot: null,
    }))
  : [];
// The end screen with a made-up table: `?results=victory|defeat`, and
// `&rank=` for your place (past 10 shows under the "…"; 0 for none).
const resultsParam = params.get("results");
if (resultsParam === "victory" || resultsParam === "defeat") {
  setBossResults(
    sampleBossResults(resultsParam, Number(params.get("rank") ?? 7)),
    null,
  );
}
const cls = params.get("class");
if (isHerzieClass(cls)) {
  const [main, off] = CLASS_DEFS[cls].equipment;
  player.equipped.main_hand = main;
  if (off) player.equipped.off_hand = off;
  combat.attack = attackStyle(cls);
  // And its skills (Q and the hotbar), at `?skill=` level.
  setMySkills(
    CLASS_DEFS[cls].skills.map((skillId) => ({
      skillId,
      level: Number(params.get("skill") ?? 1),
    })),
    CLASS_DEFS[cls].skills,
  );
}

/**
 * Times the renderer alone, with the frame loop stopped: a frame's worth of
 * gl.render calls, then a 1x1 readPixels so the GPU has to finish them.
 * Under vsync the frame rate only says "fast enough", so this is what
 * shows the headroom. Waits for the world to settle first (herzies, shader
 * compiles), and prints the result on the page and as `[town-bench]`.
 */
async function bench(state: RootState) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(Number(params.get("warmup") ?? 4000));
  const { gl, scene, camera } = state;
  state.setFrameloop("never");
  const ctx = gl.getContext();
  const info = ctx.getExtension("WEBGL_debug_renderer_info");
  const gpu = info
    ? ctx.getParameter(info.UNMASKED_RENDERER_WEBGL)
    : ctx.getParameter(ctx.RENDERER);
  const pixel = new Uint8Array(4);
  const finish = () =>
    ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, pixel);
  // `?bench=frame`: whole frames (every useFrame, and the ambient
  // occlusion composer, which draws instead of gl.render).
  const whole = params.get("bench") === "frame";
  const render = whole
    ? () => state.advance(performance.now())
    : () => gl.render(scene, camera);
  for (let i = 0; i < 20; i++) render();
  finish();
  const frames = Number(params.get("frames") ?? 300);
  const runs: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    for (let i = 0; i < frames / 5; i++) render();
    finish();
    runs.push((performance.now() - t0) / (frames / 5));
    await wait(50);
  }
  runs.sort((a, b) => a - b);
  const result = {
    shadows: gl.shadowMap.enabled,
    whole,
    gpu,
    size: [ctx.drawingBufferWidth, ctx.drawingBufferHeight],
    msPerFrame: Number(runs[2].toFixed(3)),
    runs: runs.map((r) => Number(r.toFixed(3))),
    calls: gl.info.render.calls,
    triangles: gl.info.render.triangles,
  };
  console.log("[town-bench]", JSON.stringify(result));
  const out = document.createElement("pre");
  out.id = "town-bench";
  out.textContent = JSON.stringify(result, null, 1);
  Object.assign(out.style, {
    position: "fixed",
    top: "8px",
    left: "8px",
    background: "rgba(0,0,0,.7)",
    color: "#fff",
    font: "12px monospace",
    padding: "6px",
    zIndex: "100",
  });
  document.body.append(out);
  state.setFrameloop("always");
}

function localNet() {
  // A uuid, as real user ids are: the Tower's rooms are named by it.
  const uid = crypto.randomUUID();
  // `?lobby=<s>`: the cave is a raid whose lobby locks this many seconds
  // after the page loads (without it, the fight is on at once).
  const lobby = params.get("lobby");
  const starts =
    lobby !== null ? Math.floor(Date.now() / 1000) + Number(lobby) : undefined;
  // `?until=<s>`: the boss gets away this many seconds after loading (the
  // room then closes, for testing the way back to town).
  const until = params.get("until");
  const escapesAt =
    until !== null ? Math.floor(Date.now() / 1000) + Number(until) : undefined;
  const name = params.get("name") ?? uid;
  const maxHp = 300;
  const hp = Number(params.get("hp") ?? maxHp);
  setVitals({ hp, maxHp, stored: hp, hpAt: Date.now(), down: hp <= 0 });
  setTownTicketSource(async (map) => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const look = {
      seed: player.seed,
      stage: player.stage,
      equipped: player.equipped,
    };
    const bossHp = Number(params.get("boss") ?? 60_000);
    return {
      ticket: await signTownTicket(
        {
          uid,
          name,
          look,
          exp,
          hp: { hp, maxHp, down: hp <= 0 },
          st: [
            Number(params.get("sp") ?? 0),
            0,
            Number(params.get("cc") ?? 0),
            Number(params.get("cd") ?? 0),
          ],
          ...(isHerzieClass(cls)
            ? {
                cls,
                sk: CLASS_DEFS[cls].skills.map(
                  (id) =>
                    [id, Number(params.get("skill") ?? 1)] as [string, number],
                ),
              }
            : {}),
          lv: Number(params.get("level") ?? 10),
          tower:
            map === "tower"
              ? {
                  event: "sandbox",
                  until: exp + 3_000,
                  floor: Number(params.get("floor") ?? 1),
                }
              : undefined,
          // Only the cave needs a boss; the sandbox makes one up.
          boss:
            map === "bossroom"
              ? {
                  event: "sandbox",
                  until: escapesAt ?? exp + 3_000,
                  hp: bossHp,
                  maxHp: bossHp,
                  ...(starts
                    ? {
                        starts,
                        hpPerPlayer: Number(params.get("per") ?? 20_000),
                      }
                    : {}),
                }
              : undefined,
        },
        "dev-town-secret",
      ),
      url: params.get("server") ?? "ws://localhost:8787",
      exp,
      instance: uid,
    };
  });
  const net = townNet();
  net.start();
  net.subscribe(() =>
    console.log("[town-sandbox] net", net.status, net.remotes.size),
  );
  return net;
}
if (params.get("tower") === "open") {
  setTowerOpen({ endsAt: Date.now() + 3_600_000 });
}
if (params.get("cave") === "open") {
  setCave({ kind: "open", endsAt: Date.now() + 3_600_000 });
} else if (params.get("cave") === "soon") {
  setCave({ kind: "soon", startsAt: Date.now() + 7_500_000 });
}
const net = params.get("net") === "local" ? localNet() : null;
// For poking at from the console and browser tests.
Object.assign(window, { townNet: net });

/**
 * The sandbox's Town, with chat bubbles driven from the console:
 * `say("bot-seed-3", "hello")` (a friend code, or a bot's seed; the player's
 * own seed for yours).
 */
function Sandbox() {
  const [bubbles, setBubbles] = useState<ChatBubbles>(new Map());
  useEffect(() => {
    let n = 0;
    Object.assign(window, {
      say: (code: string, text: string) => {
        const key = `say-${n++}`;
        setBubbles((b) => new Map(b).set(code, { key, text }));
        setTimeout(
          () =>
            setBubbles((b) => {
              if (b.get(code)?.key !== key) return b;
              const next = new Map(b);
              next.delete(code);
              return next;
            }),
          bubbleDuration(text),
        );
      },
    });
  }, []);
  return (
    <div style={{ position: "relative", height: "100%" }}>
      <TownVitals
        inFight={
          params.get("map") === "bossroom" || params.get("map") === "tower"
        }
      />
      <BossHud name="The boss" />
      <Notices />
      <SkillHud />
      <Hotbar
        units={hotbarUnits}
        className="bottom-3 left-1/2 -translate-x-1/2"
      />
      <TownCanvas
        spots={spots}
        player={player}
        net={net}
        bubbles={bubbles}
        paused={false}
        hour={sandboxHour}
        shadows={params.get("shadows") !== "0"}
        ao={params.get("ao") !== "0"}
        onCreated={params.has("bench") ? bench : undefined}
        // ?sp=&cc=&cd= : sonic power, crit chance and crit damage, to try
        // the dummies with.
        stats={{
          sonicPower: Number(params.get("sp") ?? 0),
          stamina: 0,
          euphony: 0,
          def: 0,
          luck: 0,
          critChance: Number(params.get("cc") ?? 0),
          critDamage: Number(params.get("cd") ?? 0),
        }}
        onOpen={(key) => console.log("[town-sandbox] open", key)}
        onNearChange={(s) => console.log("[town-sandbox] near", s?.key ?? null)}
      />
      {/* After the canvas, as in TownWorld: it has no z-index of its own,
          so the herzie stage can draw over it. */}
      <BossResults />
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  root.style.height = "100vh";
  createRoot(root).render(<Sandbox />);
}
