// Dev only (not in the build's inputs): the 3D Town with made-up visitors
// and a player, without logging in. `pnpm vite:dev`, then open
// /town-sandbox.html. `?shadows=0` turns the sun's shadows off, `?ao=0`
// the ambient occlusion, and `?bench=1` times the renderer (`?bench=frame`
// whole frames, composer included; see bench).
// `?time=` sets the hour, and `&speed=` runs the clock on from there,
// that many hours a second (to watch the light and shadows move);
// `?day=` the day of the year (0–365). The sliders top right set both.
// `?net=local` joins the multiplayer Town on `wrangler dev` (in
// packages/town-server, with TOWN_TICKET_SECRET=dev-town-secret in .dev.vars);
// `&name=` and `&server=ws://…` to taste. Open it twice to see each other.
// Duels too: in each tab, click the other's name, then "Challenge to duel"
// (within 8 u); `&title=` wears a title (a titles.ts id, e.g.
// `&title=duel-10`), shown over the name and on the duel's cards.
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
// with the default prism skin is the full Prismatic set), and `?back=` gives
// it a cloak (troubadour-mantle, groove-cape, drumhide-cloak, tailwind-cloak).
// The Items panel, bottom left, tries anything on: click an item to wear it
// in its slot, again to take it off (`?stage=` sets the starting stage).
// `?home=1` starts at Home (town/homeMode); H goes Home and back, walking
// leaves it. `?crystal=0.6` puts a Crystal by the spawn, 60% charged (`2`
// for overcharged; `&tier=` its size, `&crystalOpen=1` opens its window);
// E on it plays a made-up payout (`&finds=` how many,
// `&xp=` how much). `drop()` drops something round you as listening does
// (`drop("ghost")` that item; `drop(5)` five), `loot(3)` tosses test loot
// (Settings > Debug), `take()` has the server take
// the oldest back (a spirit's sweep), and `?ground=boombox` gives the
// herzie a ground accessory to fade in at Home.
// `?wilds=20` runs Sofia III to the Wilds, its first run leaving home in
// 20 s (`&every=` seconds between departures from each dock, default
// 120); `&dock=1` starts you at the end of the home Sky Dock's pier.
// `?map=wilds&loot=1` puts a cache and two dropped cards in front of you
// (`&lootItem=` the locked one; `&cacheAt=`, `&hold=rival`: see below); E
// at the Crafting Station (or `&craftingOpen=1`) opens its window, with a
// made-up bag of bits and `&class=`'s instruments. `?map=wilds&zone=1`
// joins a made-up free-for-all (nobody else in it), for the HUD's lines
// under the now-playing box: safe camp or PvP zone, and the cache's hold.
// `?map=tower&chest=1` stands a cleared Warden's floor (10) with its chest
// on the compass, as the room would tell it: walk onto the star and it
// opens and tosses out made-up loot (nothing's granted); the next floor's
// turns up a few seconds later.
import "./globals.css";
import {
  basicAttack,
  CLASS_DEFS,
  CRYSTAL_KEY,
  type CrystalState,
  crystalCapacity,
  crystalUpgradeCost,
  getItem,
  getItemIcon,
  ITEMS,
  type ItemUnit,
  isHerzieClass,
  SH,
  signTownTicket,
  totalXpForLevel,
  WILDS_DEPART_DEFAULT_S,
  WILDS_LEG_MS,
} from "@herzies/shared";
import { TOWER_CHEST, towerChestRolls } from "@herzies/shared/tower";
import {
  WILDS_CACHE_HOLD_MS,
  WILDS_CACHE_HOLD_RADIUS,
} from "@herzies/shared/wilds-loot";
import type { RootState } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CraftingPanel } from "./components/CraftingPanel";
import { HuntCrystalPanel } from "./components/HuntCrystalPanel";
import { CrystalPanel } from "./components/CrystalPanel";
import { Notices } from "./components/Notices";
import { NowPlayingBox } from "./components/NowPlayingBox";
import { PlayerBars } from "./components/PlayerBars";
import type { EventCard } from "./components/TownScene";
import { TownVitals } from "./components/TownVitals";
import { berthOf } from "./components/town/airship/berth";
import { fleet } from "./components/town/airship/fleet";
import { SkyDockHud } from "./components/town/airship/SkyDockHud";
import { setWildsService } from "./components/town/airship/service";
import { BossHud } from "./components/town/BossHud";
import { BossResults } from "./components/town/BossResults";
import { CRYSTAL, crystalsOf } from "./components/town/Crystal";
import { setCave } from "./components/town/cave";
import {
  bubbleDuration,
  type ChatBubbles,
} from "./components/town/chatBubbles";
import {
  debugDropLoot,
  handleBossMessage,
} from "./components/town/combat/fight";
import { setLootRoom } from "./components/town/combat/lootFeed";
import {
  sampleBossResults,
  setBossResults,
} from "./components/town/combat/results";
import { setArmed, setMySkills } from "./components/town/combat/skills";
import { combat } from "./components/town/combat/state";
import { getCrystal, setCrystal } from "./components/town/crystalState";
import { localHours } from "./components/town/DayCycle";
import { homeDropFeed } from "./components/town/dropSpots";
import { DuelHud } from "./components/town/duel/DuelHud";
import { setOwnedEmotes } from "./components/town/emotes";
import { setTowerOpen } from "./components/town/gates";
import { Hotbar } from "./components/town/Hotbar";
import { homeMode } from "./components/town/homeMode";
import { assignHotbar } from "./components/town/hotbarSlots";
import { LocationTitle } from "./components/town/LocationTitle";
import { cellAt, objectAt } from "./components/town/map";
import { TOWN_MAPS_LOCAL } from "./components/town/maps";
import { setTownTicketSource, townNet } from "./components/town/net/townNet";
import {
  goToMap,
  HOME_MAP,
  spotsOf,
  type TownSpot,
  townLive,
  townSave,
} from "./components/town/runtime";
import { dayOfYear } from "./components/town/Seasons";
import { CastBar, SkillHud } from "./components/town/SkillHud";
import TownCanvas from "./components/town/TownCanvas";
import { setVitals } from "./components/town/vitals";
import { weatherOverride } from "./components/town/weather";
import { CRAFTING_KEY } from "./components/town/wilds/craftingSpot";
import { HUNT_CRYSTAL_KEY } from "./components/town/wilds/huntCrystalSpot";
import {
  handleWildsLootMessage,
  huntNow,
  wildsLoot,
} from "./components/town/wilds/loot";
import { handleWildsMessage } from "./components/town/wilds/store";
import { CacheHud, WildsHud } from "./components/town/wilds/WildsHud";
import { HerzieStageContext, overlayHerzieStage } from "./lib/overlayStage";
import { herzies } from "./tauri-bridge";

const params = new URLSearchParams(location.search);
// The townsfolk of the island you start on (?map=wilds: Madas in its camp).
const START_MAP = TOWN_MAPS_LOCAL.get(params.get("map") as never) ?? HOME_MAP;
const { spots: SPOTS, spare: SPARE_SPOTS } = spotsOf(START_MAP);
// Start on another island: ?map=tower .
if (params.has("map")) goToMap(params.get("map") as string);
if (params.has("wilds")) {
  const every = Number(params.get("every") ?? WILDS_DEPART_DEFAULT_S) * 1000;
  const first = Date.now() + Number(params.get("wilds") || 20) * 1000;
  const startsAt = first - (every / 2 - WILDS_LEG_MS);
  setWildsService({
    startsAt,
    endsAt: startsAt + 7_200_000,
    departEveryMs: every,
  });
}
if (params.get("dock") === "1") {
  const b = berthOf(HOME_MAP);
  if (b)
    goToMap("home", {
      x: b.pierEnd.x - Math.sin(b.out) * 3,
      z: b.pierEnd.z - Math.cos(b.out) * 3,
      heading: b.out,
    });
}

const startHour = params.has("time") ? Number(params.get("time")) : null;
const speed = Number(params.get("speed") ?? 0);
/** The time of day and year shown, as the sliders (see SkyControls) last
 * set them: null for the local clock and calendar. With `&speed=`, the
 * clock runs on from the hour last set. */
const sky = {
  hour: startHour,
  setAt: performance.now(),
  day: params.has("day") ? Number(params.get("day")) : null,
};
const sandboxHour = () => {
  if (sky.hour === null) return localHours();
  if (speed <= 0) return sky.hour;
  return (sky.hour + ((performance.now() - sky.setAt) / 1000) * speed) % 24;
};
const sandboxSeason = () => sky.day ?? dayOfYear();
// The weather: ?rain=0.6 (&storm=1) to look at it; else the clock's.
if (params.has("rain")) {
  weatherOverride.rain = Number(params.get("rain"));
  weatherOverride.storm = params.get("storm") === "1";
}

/** "18:30". */
const clockText = (h: number) =>
  `${Math.floor(h)}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;
/** A day of the year as a date: "31 Oct". */
const dateText = (d: number) =>
  new Date(2025, 0, 1 + Math.floor(d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });

/** Sliders for the time of day and of year, top right: "Now" and
 * "Today" go back to the clock and calendar. */
function SkyControls() {
  const [hour, setHour] = useState(sky.hour);
  const [day, setDay] = useState(sky.day);
  // With the clock running (`&speed=`), keep the slider up with it.
  const [, tick] = useState(0);
  useEffect(() => {
    if (speed <= 0 && hour !== null) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [hour]);
  const shown = sandboxHour();
  const pickHour = (h: number | null) => {
    sky.hour = h;
    sky.setAt = performance.now();
    setHour(h);
  };
  const pickDay = (d: number | null) => {
    sky.day = d;
    setDay(d);
  };
  const button = (on: boolean) =>
    `rounded px-1.5 py-0.5 ${on ? "bg-white/30" : "bg-white/10"}`;
  return (
    <div className="pointer-events-auto absolute top-3 right-3 z-10 flex items-center gap-2 rounded bg-black/50 px-2 py-1 text-[11px] text-white/80">
      <button
        type="button"
        className={button(hour === null)}
        onClick={() => pickHour(null)}
      >
        Now
      </button>
      <input
        type="range"
        min={0}
        max={24}
        step={0.05}
        value={shown}
        onChange={(e) => pickHour(Number(e.target.value))}
      />
      <span className="w-10 text-right">{clockText(shown)}</span>
      <button
        type="button"
        className={`${button(day === null)} ml-2`}
        onClick={() => pickDay(null)}
      >
        Today
      </button>
      <input
        type="range"
        min={0}
        max={365}
        step={1}
        value={day ?? Math.floor(dayOfYear())}
        onChange={(e) => pickDay(Number(e.target.value))}
      />
      <span className="w-12 text-right">
        {day === null ? "today" : dateText(day)}
      </span>
    </div>
  );
}

const card = (type: string, title: string): EventCard => ({
  type,
  title,
  description: null,
  status: "live",
  at: null,
  // The residents open; the rest are scenery.
  openKey:
    type === "boboku" || type === "medea" || type === "market" ? type : null,
  eventId: `sandbox-${type}`,
});

const spots: TownSpot[] = [
  ["merchant", "Good ol' George"],
  ["treat_trader", "Nandor"],
  ["boss_fight", "The boss"],
  ["song_hunt", "Orphiez"],
  ["boboku", "Boboku"],
  ["medea", "Medea"],
  ["market", "Plutus"],
  ["nakata", "Nakata"],
  ["skipper", "Blåmann"],
  ["madas", "Madas"],
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
// `?visitors=6` fills the spare spots too: the most the Town shows (on an
// island visitors stand on).
const extra =
  START_MAP === HOME_MAP
    ? Math.max(0, Number(params.get("visitors") ?? 4) - spots.length)
    : 0;
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
    ...(params.get("ground") && {
      ground_left: params.get("ground") as string,
    }),
    ...(params.get("back") && { back: params.get("back") as string }),
    ...(params.get("feet") && { feet: params.get("feet") as string }),
    ...(params.get("body") && { body: params.get("body") as string }),
    ...(params.get("face") && { face: params.get("face") as string }),
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
  // `?gear=none`: the class without its instrument (a punch or body slam).
  const bare = params.get("gear") === "none";
  const [main, off] = CLASS_DEFS[cls].equipment;
  if (!bare) {
    player.equipped.main_hand = main;
    if (off) player.equipped.off_hand = off;
  }
  const a = basicAttack({
    cls,
    stage: player.stage,
    mainHand: player.equipped.main_hand,
  });
  combat.attack = a.style;
  combat.blow = a.blow;
  setArmed(!bare, main);
  // And its skills (Q and the hotbar), at `?skill=` level.
  setMySkills(
    CLASS_DEFS[cls].skills.map((skillId) => ({
      skillId,
      level: Number(params.get("skill") ?? 1),
    })),
    CLASS_DEFS[cls].skills,
  );
} else {
  // No class: a punch from stage 3, a body slam before.
  const a = basicAttack({ cls: null, stage: player.stage, mainHand: null });
  combat.attack = a.style;
  combat.blow = a.blow;
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

// `?emotes=wave`: the emotes owned (comma-separated), on the Alt bar and in
// the ticket.
const sandboxEmotes = (params.get("emotes") ?? "").split(",").filter(Boolean);
setOwnedEmotes(sandboxEmotes);

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
          ...(params.get("title") ? { ti: params.get("title") as string } : {}),
          ...(sandboxEmotes.length ? { em: sandboxEmotes } : {}),
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
Object.assign(window, { townNet: net, townSave, townLive, fleet });

// --- The Wilds' loot ---------------------------------------------------------------
// `?map=wilds&loot=1`: a cache a little way ahead (`&cacheAt=` units, 4 by
// default: you start in its ring) and two dropped cards either side (the
// left one someone else's for a minute yet), as the room would tell them.
// E by a card you may take asks for it (it goes nowhere without a room).
// The room's hold on the cache is faked here: stand in the ring 10 s and
// it opens; `&hold=rival` has someone else in it already, 3 s in, who
// stays (contested while you're in too, theirs in a few seconds if you
// step out). So is the Hunt Crystal: as if one herzie were listening, it
// fills in `&hunt=` seconds (3 by default) once a cache is opened, and the
// next turns up when it's full; with `&hunt=` given, it starts dull, with
// no cache out yet.
if (params.get("loot") === "1") {
  const ctx = {
    toLocal: (t: number) => t,
    you: () => wildsLoot.you,
    map: () => townSave.map,
    me: () => townSave,
  };
  handleWildsLootMessage({ t: "welcome", you: 1, players: [] }, ctx);
  const fx = Math.sin(townSave.heading);
  const fz = Math.cos(townSave.heading);
  const at = (ahead: number, side: number) => ({
    x: townSave.x + fx * ahead + fz * side,
    z: townSave.z + fz * ahead - fx * side,
  });
  const t = performance.now();
  const spot = at(Number(params.get("cacheAt") ?? 4), 0);
  const fillMs = Number(params.get("hunt") ?? 3) * 1000;
  const dull = params.has("hunt");
  /** The crystal from empty at `now`, one listening. */
  const filling = (now: number) =>
    handleWildsLootMessage(
      {
        t: "wildsHunt",
        hunt: { charge: 0, rate: 1 / fillMs, at: now, listeners: 1 },
      },
      ctx,
    );
  handleWildsLootMessage(
    {
      t: "wildsLoot",
      drops: [
        {
          id: "sandbox-locked",
          item: params.get("lootItem") ?? "wildwood-lute",
          level: 2,
          ...at(1.2, 2),
          firstFor: 2,
          firstUntil: t + 60_000,
          expiresAt: t + 120_000,
        },
        {
          id: "sandbox-free",
          item: "storm-hide",
          level: 0,
          ...at(1.2, -2),
          firstFor: null,
          firstUntil: 0,
          expiresAt: t + 120_000,
        },
      ],
      cache: dull ? null : { id: "sandbox-cache-0", ...spot },
      hold: null,
      hunt: dull
        ? { charge: 0, rate: 1 / fillMs, at: t, listeners: 1 }
        : { charge: 1, rate: 0, at: t, listeners: 1 },
    },
    ctx,
  );
  const rivalIn = params.get("hold") === "rival";
  let k = 0;
  let mine: number | null = null;
  let rival: number | null = rivalIn ? 3_000 : null;
  let last = performance.now();
  let told = "";
  setInterval(() => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    const c = wildsLoot.cache;
    if (!c) {
      // Full: the hunt's on.
      if (huntNow(now) < 1) return;
      handleWildsLootMessage(
        {
          t: "wildsHunt",
          hunt: { charge: 1, rate: 0, at: now, listeners: 1 },
        },
        ctx,
      );
      handleWildsLootMessage(
        { t: "wildsCache", cache: { id: `sandbox-cache-${++k}`, ...spot } },
        ctx,
      );
      return;
    }
    const inside =
      Math.hypot(townSave.x - c.x, townSave.z - c.z) <= WILDS_CACHE_HOLD_RADIUS;
    mine = inside ? mine : null;
    const stepped = inside && mine === null;
    if (stepped) mine = 0;
    const contested = mine !== null && rival !== null;
    if (!contested && mine !== null && !stepped) mine += dt;
    if (!contested && mine === null && rival !== null) rival += dt;
    const state = `${mine !== null}|${rival !== null}|${contested}`;
    if (state !== told) {
      told = state;
      const holders: { id: number; ms: number }[] = [];
      if (rival !== null) holders.push({ id: 2, ms: rival });
      if (mine !== null) holders.push({ id: 1, ms: mine });
      handleWildsLootMessage(
        { t: "wildsHold", id: c.id, holders, contested, at: now },
        ctx,
      );
    }
    const by =
      (mine ?? 0) >= WILDS_CACHE_HOLD_MS
        ? 1
        : (rival ?? 0) >= WILDS_CACHE_HOLD_MS
          ? 2
          : null;
    if (by === null) return;
    handleWildsLootMessage(
      { t: "wildsCache", cache: null, by, byName: "Rival" },
      ctx,
    );
    mine = null;
    rival = rivalIn ? 3_000 : null;
    told = "";
    filling(now);
  }, 100);
}
// `?map=tower&chest=1`: floor 10 cleared, its chest standing. The room's
// part is faked: on the star (after the chest's landed) it opens, and its
// loot follows as `town-vitals`' reply would, a moment later.
if (params.get("map") === "tower" && params.get("chest") === "1") {
  const clock = { toLocal: (t: number) => t, you: () => null };
  const pool = ITEMS.filter((i) => i.rarity !== "common" && getItemIcon(i));
  const standOn = (floor: number, chest: boolean) =>
    handleBossMessage(
      {
        t: "floor",
        floor,
        level: floor,
        you: Number(params.get("level") ?? 10),
        mobs: [],
        cleared: true,
        ...(chest ? { chest: TOWER_CHEST.at } : {}),
      },
      clock,
    );
  let floor = 10;
  let since = performance.now();
  standOn(floor, true);
  setInterval(() => {
    const now = performance.now();
    if (
      since === 0 ||
      now - since < TOWER_CHEST.settleMs ||
      Math.hypot(townSave.x - TOWER_CHEST.at.x, townSave.z - TOWER_CHEST.at.z) >
        TOWER_CHEST.reach
    )
      return;
    since = 0;
    standOn(floor, false);
    const drops = Array.from({ length: towerChestRolls(floor) }, () => ({
      id: "",
      item: pool[Math.floor(Math.random() * pool.length)].id,
    }));
    setTimeout(
      () => handleBossMessage({ t: "loot", drops, at: TOWER_CHEST.at }, clock),
      600,
    );
    setTimeout(() => {
      floor += 10;
      since = performance.now();
      standOn(floor, true);
    }, 6_000);
  }, 100);
}
// `?map=wilds&zone=1`: in the Wilds' free-for-all, as the room's welcome
// would have it (casts and skills then go to a server there isn't).
const zone = params.get("zone") === "1";
if (zone)
  handleWildsMessage(
    { t: "welcome", you: 1, players: [] },
    { toLocal: (t) => t, map: () => townSave.map },
  );
// `?craftingOpen=1`: the Crafting Station's window, with a bag of bits and
// the class's (`?class=`) instruments.
const craftingUnits: ItemUnit[] = [
  ...(
    [
      ["tonewood", 14],
      ["sky-string", 7],
      ["storm-hide", 2],
      ["resonite", 1],
    ] as const
  ).flatMap(([itemId, n]) =>
    Array.from({ length: n }, (_, i) => ({
      id: `sandbox-${itemId}-${i}`,
      itemId,
      upgradeLevel: 0,
      equippedSlot: null,
    })),
  ),
  ...(isHerzieClass(cls) ? CLASS_DEFS[cls].equipment : []).map((itemId, i) => ({
    id: `sandbox-instrument-${i}`,
    itemId,
    upgradeLevel: 2 + i * 4,
    equippedSlot: null,
  })),
];

// --- Home ----------------------------------------------------------------------
// Framed as the app's small window frames Home: the feet about where Home's
// stage stands them.
// `?big=1`: as in the big window (main.tsx).
homeMode.setFrame(
  params.get("big") === "1"
    ? {
        feetY: Math.round(window.innerHeight * 0.72),
        viewHeight: Math.ceil(SH * 5 * 1.35),
        zoom: Math.min(1.6, Math.max(1, window.innerHeight / 520)),
        big: true,
      }
    : {
        feetY: Math.round(window.innerHeight - 150),
        viewHeight: Math.ceil(SH * 5 * 1.35),
        zoom: 1,
      },
);
homeMode.set(params.get("home") === "1");
homeMode.onExitRequest(() => homeMode.set(false));
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyH" && !e.repeat && !combat.on) homeMode.set(!homeMode.on);
});
// What drops: pretend pending drops, picked up as if the server agreed.
const SANDBOX_DROPS = [
  "headphones",
  "ghost",
  "clouds",
  "stars",
  "blood-moon",
  "spirit-orb",
  "sleptwell",
  "rainbow-headband",
];
let dropSeq = 0;
Object.assign(window, {
  drop(what?: string | number) {
    const n = typeof what === "number" ? what : 1;
    const next = [...homeDropFeed.drops];
    for (let i = 0; i < n; i++) {
      const itemId =
        typeof what === "string"
          ? what
          : SANDBOX_DROPS[Math.floor(Math.random() * SANDBOX_DROPS.length)];
      next.push({
        id: `sandbox-drop-${Date.now()}-${dropSeq++}`,
        itemId,
        droppedAt: new Date().toISOString(),
      });
    }
    homeDropFeed.set(next);
  },
  /** Settings > Debug > "Drop Test Loot": `loot(3)` tosses three. */
  loot(n = 1) {
    debugDropLoot(n);
  },
  take() {
    homeDropFeed.set(homeDropFeed.drops.slice(1));
  },
  homeMode,
});
// `?room=2`: the bag has room for two more things (each pickup takes one).
let bagRoom = Number(params.get("room") ?? Number.POSITIVE_INFINITY);
// Set again whenever the bag changes, as the app does.
const setBagRoom = () =>
  setLootRoom((_, alsoTaking) => alsoTaking.length + 1 <= bagRoom, bagRoom);
setBagRoom();
// `?lag=400`: the server takes this long to answer a pickup.
const lagMs = Number(params.get("lag") ?? 0);
// `?refuse=full` (or `gone`): the server turns every pickup down, whatever
// the app thought of the room — the app's idea of the bag was wrong.
const refuseAs = params.get("refuse");
herzies.collectDrop = async (dropId: string) => {
  // Off the ground at once, as the app does (optimistically), then the
  // server's answer.
  if (bagRoom < 1 && !refuseAs) return "bag-full";
  // Into the bag and off the ground (the app's state update lands a moment
  // later), then the server's answer.
  const was = homeDropFeed.drops.find((d) => d.id === dropId);
  homeDropFeed.set(homeDropFeed.drops.filter((d) => d.id !== dropId));
  bagRoom -= 1;
  setTimeout(setBagRoom, 30);
  if (lagMs > 0) await new Promise((r) => setTimeout(r, lagMs));
  console.log(`[town-sandbox] pickup ${dropId}: ${refuseAs ?? "collected"}`);
  if (refuseAs === "full") {
    // Back out of the bag and on the ground, as the app puts it.
    bagRoom += 1;
    setTimeout(setBagRoom, 30);
    if (was) homeDropFeed.set([...homeDropFeed.drops, was]);
    return "bag-full";
  }
  if (refuseAs === "gone") return "gone";
  return "collected";
};

// ?crystal=<charge>: a Crystal by the spawn, and a made-up payout.
const crystalParam = params.get("crystal");
if (crystalParam !== null) {
  const charge = Number(crystalParam) || 0;
  const [sc, sr] = cellAt(HOME_MAP, ...HOME_MAP.spawn.at);
  const placed = crystalsOf(HOME_MAP).length > 0;
  // The nearest clear grass cell 3–5 cells off the spawn.
  outer: for (let r = placed ? 6 : 3; r <= 5; r++)
    for (let dc = -r; dc <= r; dc++)
      for (const dr of [-r, r]) {
        const col = sc + dc;
        const row = sr + dr;
        if (
          objectAt(HOME_MAP, col, row) !== "." ||
          HOME_MAP.terrain[row]?.[col] !== "g"
        )
          continue;
        const line = HOME_MAP.objects[row];
        HOME_MAP.objects[row] =
          `${line.slice(0, col)}${CRYSTAL}${line.slice(col + 1)}`;
        break outer;
      }
  const xp = Number(params.get("xp") ?? 3400);
  const finds = Number(params.get("finds") ?? 7);
  const tier = Number(params.get("tier") ?? 0);
  const crystal: CrystalState = {
    enabled: true,
    fill: charge * crystalCapacity(tier),
    capacity: crystalCapacity(tier),
    xp,
    dropsWaiting: finds,
    tier,
    attunes: 0,
    shards: Number(params.get("shards") ?? 4),
  };
  setCrystal(crystal);
  const pool = [
    "stars",
    "clouds",
    "headphones",
    "ghost",
    "blood-moon",
    "rainbow-headband",
    "sleptwell",
  ];
  herzies.attuneCrystal = async (attunes: number) => {
    const items = Array.from({ length: finds }, (_, i) => {
      const id = pool[(i * 3 + attunes) % pool.length];
      const def = getItem(id);
      return {
        itemId: id,
        name: def?.name ?? id,
        rarity: def?.rarity ?? "common",
      };
    });
    const after = {
      ...crystal,
      fill: 0,
      xp: 0,
      dropsWaiting: 0,
      attunes: attunes + 1,
    };
    // Out onto the ground, as the app does with the server's list.
    const pendingDrops = [
      ...homeDropFeed.drops,
      ...items.map((it) => ({
        id: `sandbox-crystal-${Date.now()}-${dropSeq++}`,
        itemId: it.itemId,
        droppedAt: new Date().toISOString(),
      })),
    ];
    homeDropFeed.set(pendingDrops);
    return {
      ok: true as const,
      xp,
      levelBefore: 7,
      levelAfter: 9,
      items,
      dropsLeft: 0,
      groundFull: false,
      crystal: after,
      pendingDrops,
    };
  };
  herzies.upgradeCrystal = async () => {
    const now = getCrystal() ?? crystal;
    const cost = crystalUpgradeCost(now.tier) ?? 0;
    await new Promise((r) => setTimeout(r, 350));
    const next = {
      ...now,
      tier: now.tier + 1,
      capacity: crystalCapacity(now.tier + 1),
      shards: now.shards - cost,
    };
    return { ok: true as const, cost, crystal: next };
  };
}

/** The herzie stage hosted inside a window, as OverlayWindow does. */
function SandboxOverlayStage({ children }: { children: React.ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    overlayHerzieStage.setHost(host.current);
  }, []);
  const value = useMemo(
    () => ({ stage: overlayHerzieStage, inOverlay: true, skySlot: null }),
    [],
  );
  return (
    <HerzieStageContext.Provider value={value}>
      <div ref={host} className="pointer-events-none absolute inset-0" />
      <div className="relative z-[2] flex flex-col">{children}</div>
    </HerzieStageContext.Provider>
  );
}

/**
 * The sandbox's Town, with chat bubbles driven from the console:
 * `say("bot-seed-3", "hello")` (a friend code, or a bot's seed; the player's
 * own seed for yours).
 */
type SandboxLook = typeof player;

/** Every equipable item, by name. */
const PICKABLE = ITEMS.filter((i) => i.equipable && i.equipSlot).sort((a, b) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
);

/** The slot an item goes in on the herzie (a ground item on the left). */
const wornSlot = (equipSlot: string) =>
  equipSlot === "ground" ? "ground_left" : equipSlot;

/** Bottom left: a list of every equipable item to put on the player and
 * take off again, a filter, and the stage. */
function ItemPicker({
  look,
  onChange,
}: {
  look: SandboxLook;
  onChange: (next: SandboxLook) => void;
}) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState("");
  const equipped = look.equipped as Record<string, string | string[]>;
  const isOn = (id: string, slot: string) => {
    const v = equipped[wornSlot(slot)];
    return Array.isArray(v) ? v.includes(id) : v === id;
  };
  const toggle = (id: string, slot: string) => {
    const key = wornSlot(slot);
    const next: Record<string, string | string[]> = { ...equipped };
    if (slot === "modifier") {
      const mods = (next.modifier as string[] | undefined) ?? [];
      next.modifier = mods.includes(id)
        ? mods.filter((m) => m !== id)
        : [...mods, id];
    } else if (next[key] === id) delete next[key];
    else next[key] = id;
    onChange({ ...look, equipped: next as Record<string, string> });
  };
  const q = filter.trim().toLowerCase();
  const shown = PICKABLE.filter(
    (i) =>
      !q ||
      i.name.toLowerCase().includes(q) ||
      i.id.includes(q) ||
      i.equipSlot?.startsWith(q),
  );
  const button = (on: boolean) =>
    `rounded px-1.5 py-0.5 ${on ? "bg-white/30" : "bg-white/10"}`;
  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-30 flex max-h-[70vh] w-[230px] flex-col rounded bg-black/60 p-2 text-[11px] text-white/85">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={button(open)}
          onClick={() => setOpen((o) => !o)}
        >
          Items
        </button>
        {[1, 2, 3].map((st) => (
          <button
            key={st}
            type="button"
            className={button(look.stage === st)}
            onClick={() => onChange({ ...look, stage: st })}
          >
            {st}
          </button>
        ))}
        <button
          type="button"
          className={`${button(false)} ml-auto`}
          onClick={() => onChange({ ...look, equipped: {} })}
        >
          Clear
        </button>
      </div>
      {open && (
        <>
          <input
            className="mt-1.5 rounded bg-white/10 px-1.5 py-0.5 outline-none"
            placeholder="Filter (name, id or slot)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="mt-1.5 overflow-y-auto">
            {shown.map((i) => {
              const slot = i.equipSlot ?? "";
              const on = isOn(i.id, slot);
              return (
                <button
                  key={i.id}
                  type="button"
                  title={i.id}
                  className={`flex w-full justify-between gap-2 rounded px-1 py-0.5 text-left ${on ? "bg-white/25" : "hover:bg-white/10"}`}
                  onClick={() => toggle(i.id, slot)}
                >
                  <span className="truncate">{i.name}</span>
                  <span className="shrink-0 text-white/45">{slot}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Sandbox() {
  const [look, setLook] = useState(player);
  const [bubbles, setBubbles] = useState<ChatBubbles>(new Map());
  const [crystalOpen, setCrystalOpen] = useState(
    params.get("crystalOpen") === "1",
  );
  const [huntOpen, setHuntOpen] = useState(params.get("huntOpen") === "1");
  const [craftingOpen, setCraftingOpen] = useState(
    params.get("craftingOpen") === "1",
  );
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
      <LocationTitle />
      {net ? (
        <DuelHud
          me={{
            name: params.get("name") ?? "You",
            title: params.get("title"),
          }}
        />
      ) : null}
      <Notices />
      <SkillHud />
      <Hotbar
        units={hotbarUnits}
        className="bottom-3 left-1/2 -translate-x-1/2"
      />
      <CastBar className="bottom-[3.75rem] left-1/2 -translate-x-1/2" />
      <TownCanvas
        spots={spots}
        player={look}
        playerName={params.get("name") ?? "You"}
        playerTitle={params.get("title")}
        net={net}
        bubbles={bubbles}
        paused={false}
        hour={sandboxHour}
        season={sandboxSeason}
        shadows={params.get("shadows") !== "0"}
        ao={params.get("ao") !== "0"}
        onCreated={params.has("bench") ? bench : undefined}
        onReady={() => homeMode.setReady(true)}
        homeDrops
        // ?sp=&cc=&cd=&tm= : sonic power, crit chance, crit damage and
        // Timing, to try the dummies with.
        stats={{
          sonicPower: Number(params.get("sp") ?? 0),
          stamina: 0,
          euphony: 0,
          timing: Number(params.get("tm") ?? 0),
          def: 0,
          luck: 0,
          critChance: Number(params.get("cc") ?? 0),
          critDamage: Number(params.get("cd") ?? 0),
          moveSpeed: 0,
        }}
        onOpen={(key) => {
          console.log("[town-sandbox] open", key);
          if (key === CRYSTAL_KEY) setCrystalOpen(true);
          if (key === CRAFTING_KEY) setCraftingOpen(true);
          if (key === HUNT_CRYSTAL_KEY) setHuntOpen(true);
        }}
        onNearChange={(s) => console.log("[town-sandbox] near", s?.key ?? null)}
      />
      {/* After the canvas, as in TownWorld: it has no z-index of its own,
          so the herzie stage can draw over it. */}
      <BossResults />
      {crystalOpen ? (
        <div className="absolute top-12 right-3 z-40 flex w-[300px] flex-col rounded-xl border border-white/15 p-3">
          {/* The glass on a layer of its own: a blur on the window itself
              would make the stage's fixed canvas sit relative to it. */}
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-black/70 backdrop-blur-md" />
          {/* Its own stage, as the app's windows give theirs. */}
          <SandboxOverlayStage>
            <CrystalPanel />
          </SandboxOverlayStage>
          <button
            type="button"
            className="btn mt-2"
            onClick={() => setCrystalOpen(false)}
          >
            Close
          </button>
        </div>
      ) : null}
      {craftingOpen ? (
        <div className="absolute top-12 right-3 z-40 flex max-h-[calc(100%-4rem)] w-[320px] flex-col rounded-xl border border-white/15 p-3">
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-black/70 backdrop-blur-md" />
          <div className="relative flex min-h-0 flex-1 flex-col">
            <CraftingPanel
              units={craftingUnits}
              herzieClass={isHerzieClass(cls) ? cls : null}
            />
          </div>
          <button
            type="button"
            className="btn relative mt-2"
            onClick={() => setCraftingOpen(false)}
          >
            Close
          </button>
        </div>
      ) : null}
      {huntOpen ? (
        <div className="absolute top-12 right-3 z-40 flex w-[300px] flex-col rounded-xl border border-white/15 p-3">
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-black/70 backdrop-blur-md" />
          <SandboxOverlayStage>
            <HuntCrystalPanel paused={false} />
          </SandboxOverlayStage>
          <button
            type="button"
            className="btn mt-2"
            onClick={() => setHuntOpen(false)}
          >
            Close
          </button>
        </div>
      ) : null}
      {/* Top left as in the Town: the player card's bars, what's playing,
          and the stacked list under it (TownWorld). */}
      <div className="pointer-events-none absolute top-3 left-3 z-30 flex w-[174px] flex-col gap-2">
        <PlayerBars
          level={7}
          progress={0.3}
          xp={totalXpForLevel(7) + 400}
          className="w-[160px]"
        />
        <NowPlayingBox
          nowPlaying={null}
          multipliers={null}
          tint="bg-black/45 backdrop-blur-md"
        />
        <div className="flex flex-col self-start">
          {zone ? <WildsHud /> : <CacheHud />}
          <SkyDockHud />
        </div>
      </div>
      <SkyControls />
      <ItemPicker look={look} onChange={setLook} />
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  root.style.height = "100vh";
  createRoot(root).render(<Sandbox />);
}
