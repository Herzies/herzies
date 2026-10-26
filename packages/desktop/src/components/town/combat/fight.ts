import {
  getItemIcon,
  ITEMS,
  isSkillId,
  SKILL_DEFS,
  type SkillId,
} from "@herzies/shared";
import { BOSS_STAND } from "@herzies/shared/combat";
import { MOB, towerXpPerKill } from "@herzies/shared/tower";
import type {
  BossTelegraph,
  FightState,
  LootDrop,
  RaidState,
  ServerMessage,
  SkillRefusal,
  TowerFloor,
  TowerMob,
} from "@herzies/shared/town-net";
import { TOWN_TICK_MS } from "@herzies/shared/town-net";
import { useSyncExternalStore } from "react";
import { logActivity } from "../../../lib/activity";
import { notify } from "../../../lib/notices";
import {
  sfxChannel,
  sfxDown,
  sfxHurt,
  sfxImpact,
  sfxPortal,
  sfxRevive,
  sfxSlam,
  sfxTaunt,
  sfxWarn,
} from "../sfx";
import { setHpNow, setRegenFrozen } from "../vitals";
import {
  pushDamageNumber,
  pushHealNumber,
  pushHurtNumber,
} from "./DamageNumbers";
import { setBossResults } from "./results";
import {
  clearBuff,
  emitSkills,
  entityAt,
  noteSkillCast,
  resetSkills,
  setBuff,
  setChannel,
  setReadyAt,
  skills,
} from "./skills";
import { combat, shake } from "./state";
import { waveField } from "./waves";

/**
 * The boss fight as the client holds it: what the Town server last said,
 * on the client's own clock. Written by {@link handleBossMessage} from the
 * socket, read by the frame loop (the boss, the floor shapes) and, through
 * {@link useBossFight}, by the HUD.
 */

/** A shape on the floor, with its times on this machine's clock
 * (`performance.now()` ms). */
export type FloorShape = BossTelegraph & {
  /** When it appeared, and when it lands, locally. */
  from: number;
  lands: number;
  /** When it landed (null: still coming), and whether it hit you. */
  resolvedAt: number | null;
};

export type Closing = {
  why: "victory" | "escaped" | "sealed" | "wiped";
  /** performance.now() ms the room shuts. */
  at: number;
};

export const bossFight = {
  /** In the boss room, in a fight. */
  on: false,
  event: "",
  hp: 0,
  maxHp: 1,
  phase: 1 as 1 | 2 | 3,
  shapes: [] as FloorShape[],
  /** Everyone's health in the room, by entity id. */
  health: new Map<number, { hp: number; maxHp: number }>(),
  you: null as number | null,
  closing: null as Closing | null,
  /** The boss fell: who landed the blow (an entity id), and when
   * (performance.now() ms). */
  victory: null as { by: number; at: number } | null,
  /** What's been dropped for you, a batch per drop (boss loot, each Tower
   * kill that paid one): every batch stays on the ground until it's picked
   * up or you leave. Dropped by LootDrops. */
  loots: [] as LootBatch[],
  /** In the Tower: the floor (its mobs are in {@link towerMobs}), and when
   * its mobs enrage (performance.now() ms; null from an older server). */
  tower: null as
    | (Omit<TowerFloor, "mobs" | "enrageIn"> & { enrageAt: number | null })
    | null,
  /** When the boss was last hit and when you last were (performance.now()
   * ms), for the bar's flash and the screen's. */
  bossHitAt: Number.NEGATIVE_INFINITY,
  youHitAt: Number.NEGATIVE_INFINITY,
  /** When the boss last slammed the floor, for it to rear and drop. */
  slammedAt: Number.NEGATIVE_INFINITY,
  /** In the cave: the raid (its times on this machine's clock), or null
   * (the Tower, or an older server without a lobby). */
  raid: null as RaidView | null,
  /** Your contribution so far, and its rank of the roster. */
  tally: null as { score: number; rank: number; of: number } | null,
  /** Where the boss has been, newest last (drawn a moment behind, like a
   * mob: see {@link bossNow}). */
  bossPath: [] as { at: number; x: number; z: number; yaw: number }[],
  /** What the boss is saying, until when (performance.now() ms). */
  say: null as { text: string; until: number } | null,
};

/** The raid as the client holds it: RaidState with its times local
 * (performance.now() ms), and whether you're in the fight. */
export type RaidView = Omit<
  RaidState,
  "startsAt" | "lockedAt" | "enrageAt" | "hardAt" | "you"
> & {
  startsAt: number;
  lockedAt: number | null;
  enrageAt: number | null;
  hardAt: number | null;
  you: "in" | "out" | "watching";
};

/** One drop of loot: what you got (the pending drops behind it; an empty
 * id is a dev drop, nothing to collect), and when the room said so
 * (performance.now() ms). */
export type LootBatch = {
  id: number;
  drops: LootDrop[];
  at: number;
  /** Tossed down in front of you (the dev drop), not out of the boss. */
  here?: boolean;
  /** Out of a Tower mob, where it fell. */
  from?: { x: number; z: number };
};

/** One Tower mob as the client holds it: the last few places the server
 * said it was (for drawing it smoothly, a moment behind), its health, and
 * when it fell. */
export type MobView = {
  id: number;
  /** Its kind (MOB_KINDS), and whether it's an elite (1) or the Warden. */
  kind: "brute" | "spitter" | "lunger";
  rank: 0 | 1 | 2;
  hp: number;
  maxHp: number;
  /** Winding up a swing. */
  windup: boolean;
  samples: { at: number; x: number; z: number; yaw: number }[];
  /** performance.now() ms it fell (null: up). */
  downAt: number | null;
  /** performance.now() ms it was last hit, for the flash. */
  hitAt: number;
};

/** The Tower's mobs, by id. */
export const towerMobs = new Map<number, MobView>();

/** How many of the floor's mobs are still up. */
export function mobsLeft(): number {
  let n = 0;
  for (const m of towerMobs.values()) if (m.downAt === null) n++;
  return n;
}

/** How far behind the newest word mobs and the boss are drawn, ms: a bit
 * over two server ticks, so one late packet never leaves them standing.
 * Samples are stamped with the server's time, not when they arrived, so
 * the spacing stays even through network jitter. */
export const MOB_DELAY_MS = 150;
/** A gap in samples longer than this was the thing standing still: pin
 * its old spot just before the new one rather than glide across the gap. */
const QUIET_GAP_MS = TOWN_TICK_MS * 2.5;

/** Where the boss stands at `at` (performance.now() ms; drawn a moment
 * behind the newest word, like a mob), and which way it faces. Its home
 * until the server says otherwise. */
export function bossNow(at: number = performance.now() - MOB_DELAY_MS): {
  x: number;
  z: number;
  yaw: number;
} {
  const s = bossFight.bossPath;
  if (!s.length) return { x: BOSS_STAND.x, z: BOSS_STAND.z, yaw: Math.PI };
  for (let i = s.length - 1; i > 0; i--) {
    const a = s[i - 1];
    const b = s[i];
    if (a.at <= at && at <= b.at) {
      const k = b.at > a.at ? (at - a.at) / (b.at - a.at) : 1;
      let dy = b.yaw - a.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      return {
        x: a.x + (b.x - a.x) * k,
        z: a.z + (b.z - a.z) * k,
        yaw: a.yaw + dy * k,
      };
    }
  }
  const last = s[s.length - 1];
  return at < s[0].at ? s[0] : last;
}

/** Add a sample to a path, in order, pinning the old spot after a quiet
 * spell, and keep the last `keep`. */
function pushSample(
  s: { at: number; x: number; z: number; yaw: number }[],
  at: number,
  x: number,
  z: number,
  yaw: number,
  keep: number,
) {
  const last = s[s.length - 1];
  if (last && at <= last.at) return;
  if (last && at - last.at > QUIET_GAP_MS)
    s.push({ at: at - TOWN_TICK_MS, x: last.x, z: last.z, yaw: last.yaw });
  s.push({ at, x, z, yaw });
  while (s.length > keep) s.shift();
}

function pushBossAt(x: number, z: number, yaw: number, at: number) {
  pushSample(bossFight.bossPath, at, x, z, yaw, 8);
}

function raidView(r: RaidState, clock: Clock, you?: RaidView["you"]): RaidView {
  return {
    ...r,
    startsAt: clock.toLocal(r.startsAt),
    lockedAt: r.lockedAt !== undefined ? clock.toLocal(r.lockedAt) : null,
    enrageAt: r.enrageAt !== undefined ? clock.toLocal(r.enrageAt) : null,
    hardAt: r.hardAt !== undefined ? clock.toLocal(r.hardAt) : null,
    you: you ?? r.you ?? bossFight.raid?.you ?? "in",
  };
}

/** What a refused skill says, when the player can do something about it. */
const REFUSALS: Record<SkillRefusal, string> = {
  "no-target": "No one knocked out near enough to bring back.",
  "not-yet": "That only works once the fight is on.",
};

/** Where a mob is at `at` (performance.now() ms), between its samples. */
export function mobAt(
  m: MobView,
  at: number,
): { x: number; z: number; yaw: number } {
  const s = m.samples;
  const last = s[s.length - 1];
  if (!last) return { x: 0, z: 0, yaw: 0 };
  for (let i = s.length - 1; i > 0; i--) {
    const a = s[i - 1];
    const b = s[i];
    if (a.at <= at && at <= b.at) {
      const k = b.at > a.at ? (at - a.at) / (b.at - a.at) : 1;
      let dy = b.yaw - a.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      return {
        x: a.x + (b.x - a.x) * k,
        z: a.z + (b.z - a.z) * k,
        yaw: a.yaw + dy * k,
      };
    }
  }
  return at < s[0].at ? s[0] : last;
}

function syncMobs(mobs: readonly TowerMob[], now: number) {
  for (const w of mobs) {
    let m = towerMobs.get(w.id);
    if (!m) {
      m = {
        id: w.id,
        kind: w.k ?? "brute",
        rank: w.e ?? 0,
        hp: w.hp,
        maxHp: w.maxHp,
        windup: false,
        samples: [],
        downAt: null,
        hitAt: Number.NEGATIVE_INFINITY,
      };
      towerMobs.set(w.id, m);
    }
    m.hp = w.hp;
    m.maxHp = w.maxHp;
    m.windup = w.s === 1;
    pushSample(m.samples, now, w.x, w.z, w.yaw, 6);
  }
}

function setTower(f: TowerFloor, now: number) {
  const was = bossFight.tower;
  if (!was || was.floor !== f.floor) towerMobs.clear();
  const { mobs, enrageIn, ...floor } = f;
  bossFight.tower = {
    ...floor,
    enrageAt: enrageIn === undefined ? null : now + enrageIn,
  };
  syncMobs(mobs, now);
}

/** Tells one drop of loot from the next (LootDrops keys on it). */
let lootSeq = 0;
/** A crit's hit-stop, ms: the world holds still a beat. */
const CRIT_STOP_MS = 60;
/** When the boss's warning last sounded (performance.now() ms). */
let lastWarnAt = Number.NEGATIVE_INFINITY;

/** A tiny store that tells its listeners at most once a frame: a burst of
 * messages in one frame (each is its own task, so React can't batch them)
 * re-renders once. */
function frameStore() {
  let version = 0;
  let queued = false;
  const listeners = new Set<() => void>();
  const flush = () => {
    queued = false;
    version++;
    for (const l of listeners) l();
  };
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  };
  const get = () => version;
  return {
    emit() {
      if (queued) return;
      queued = true;
      if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(flush);
      else queueMicrotask(flush);
    },
    use: () => useSyncExternalStore(subscribe, get),
  };
}

/** The fight's shape: stages, floor shapes, minions, lines, the end. */
const shapeStore = frameStore();
/** Health only (the boss's and everyone's): it changes on nearly every
 * tick of a fight, and only the HUD shows it. */
const hpStore = frameStore();
const emit = shapeStore.emit;
const emitHp = hpStore.emit;

/** Re-render when the fight changes shape (not every frame, nor on every
 * hit: see {@link useBossHp}). */
export function useBossFight(): number {
  return shapeStore.use();
}

/** Re-render when anyone's health (the boss's too) changes. */
export function useBossHp(): number {
  return hpStore.use();
}

/** Out of the boss room: forget the fight. */
export function resetBossFight(): void {
  if (
    !bossFight.on &&
    !bossFight.shapes.length &&
    !bossFight.closing &&
    !bossFight.loots.length
  )
    return;
  bossFight.on = false;
  setRegenFrozen(false);
  bossFight.event = "";
  bossFight.shapes = [];
  bossFight.health.clear();
  bossFight.closing = null;
  bossFight.victory = null;
  bossFight.loots = [];
  bossFight.you = null;
  bossFight.tower = null;
  bossFight.raid = null;
  bossFight.tally = null;
  bossFight.bossPath = [];
  bossFight.say = null;
  towerMobs.clear();
  resetSkills();
  emit();
  emitHp();
}

/** How long a landed shape lingers (its flash) before it's gone, ms. */
export const SHAPE_FLASH_MS = 380;

export type Clock = {
  /** A server time as performance.now() ms. */
  toLocal: (serverTime: number) => number;
  you: () => number | null;
};

/** How high over the boss's feet a damage number pops. */
const BOSS_NUMBER_Y = 3.4;

function shape(t: BossTelegraph, clock: Clock): FloorShape {
  return {
    ...t,
    from: clock.toLocal(t.at),
    lands: clock.toLocal(t.hitAt),
    resolvedAt: null,
  };
}

/** Apply one server message to the fight. Anything that isn't about the
 * fight is ignored. */
export function handleBossMessage(m: ServerMessage, clock: Clock): void {
  const now = performance.now();
  switch (m.t) {
    case "welcome": {
      // Who you are in the room, fight or not (a resurrect in town is
      // drawn by entity).
      bossFight.you = m.you;
      if (!m.fight) {
        emit();
        return;
      }
      applyFight(m.fight, clock, m.you);
      emit();
      emitHp();
      return;
    }
    case "boss":
      bossFight.hp = m.hp;
      bossFight.maxHp = m.maxHp;
      // A new phase changes the fight's shape; a hit is only health.
      if (m.phase !== bossFight.phase) emit();
      bossFight.phase = m.phase;
      bossFight.bossHitAt = now;
      emitHp();
      return;
    case "telegraph": {
      if (!bossFight.on) return;
      const { t: _t, ...t } = m;
      bossFight.shapes.push(shape(t, clock));
      if (m.mob === undefined) {
        // The boss's own: one warning a volley, not one per shape.
        if (now - lastWarnAt > 250) {
          lastWarnAt = now;
          sfxWarn(Math.max(0.4, (clock.toLocal(m.hitAt) - now) / 1000));
        }
        if (m.kind === "scatter" && m.target === clock.you())
          notify("You're marked: step away from everyone!", {
            kind: "info",
            holdMs: 2_500,
          });
      }
      emit();
      return;
    }
    case "resolve": {
      const s = bossFight.shapes.find((x) => x.id === m.id);
      if (s) s.resolvedAt = now;
      const you = clock.you();
      const hitYou = you !== null && m.hits.includes(you);
      // A minion's swing is its own, smaller thing: the boss doesn't slam
      // for it, and far ones are barely felt.
      const minion = s?.mob !== undefined;
      if (!minion) {
        bossFight.slammedAt = now;
        sfxSlam();
      }
      if (hitYou) {
        bossFight.youHitAt = now;
        shake(minion ? 0.3 : 0.45);
        sfxHurt();
      } else if (!minion) {
        // Felt more the nearer it lands.
        const me = you !== null ? entityAt.get(you) : undefined;
        const d = s && me ? Math.hypot(s.x - me.x, s.z - me.z) : 8;
        shake(0.12 * Math.max(0.25, 1 - d / 16));
      }
      emit();
      return;
    }
    case "hp": {
      // Yours went down: the amount pops off your herzie. Anyone's went up
      // (a heal, a bite to eat, a revive): in green, over them. In a room
      // HP only rises from those.
      const was = bossFight.health.get(m.id)?.hp;
      const mine = m.id === clock.you();
      if (mine && was !== undefined && m.hp < was) pushHurtNumber(was - m.hp);
      if (was !== undefined && m.hp > was)
        pushHealNumber(mine ? null : m.id, m.hp - was);
      bossFight.health.set(m.id, { hp: m.hp, maxHp: m.maxHp });
      if (m.id === clock.you()) setHpNow(m.hp);
      emitHp();
      return;
    }
    case "hit": {
      const mob = m.mob !== undefined ? towerMobs.get(m.mob) : undefined;
      if (mob) {
        mob.hitAt = now;
        const at = mobAt(mob, now - MOB_DELAY_MS);
        const jitter = () => (Math.random() - 0.5) * 0.6;
        pushDamageNumber(
          [at.x + jitter(), MOB.top + 0.3, at.z + jitter()],
          m.damage,
          m.crit,
        );
      } else {
        const jitter = (Math.random() - 0.5) * 1.6;
        const at = bossNow();
        pushDamageNumber(
          [at.x + jitter, BOSS_NUMBER_Y, at.z],
          m.damage,
          m.crit,
        );
      }
      combat.hitAt = now;
      combat.hitCrit = m.crit;
      // Your own hits: a nudge, a jolt on a crit, but never enough to keep
      // the camera rattling through a long fight. A crit holds the world
      // still for a beat.
      if (combat.trauma < 0.3) shake(m.crit ? 0.22 : 0.05);
      if (m.crit) combat.slowUntil = now + CRIT_STOP_MS;
      sfxImpact(m.crit ? "crit" : "hit");
      return;
    }
    case "down":
      setHpNow(0, true);
      sfxDown();
      emit();
      return;
    case "victory":
      bossFight.victory = { by: m.by, at: now };
      bossFight.closing = {
        why: "victory",
        at: clock.toLocal(m.closesAt),
      };
      emit();
      return;
    case "results":
      setBossResults(
        { outcome: m.outcome, top: m.top, you: m.you },
        bossFight.victory?.at ?? null,
        now,
      );
      return;
    case "loot":
      if (!m.drops.length) return;
      bossFight.loots = [
        ...bossFight.loots,
        {
          id: ++lootSeq,
          drops: m.drops,
          at: now,
          ...(m.at ? { from: m.at } : {}),
        },
      ];
      emit();
      return;
    case "mobs": {
      const before = towerMobs.size;
      syncMobs(m.mobs, m.at !== undefined ? clock.toLocal(m.at) : now);
      if (towerMobs.size !== before) emit();
      return;
    }
    case "mobDown": {
      const mob = towerMobs.get(m.mob);
      // The Tower's fought alone: every kill is yours, and pays XP.
      const tower = bossFight.tower;
      if (mob && mob.downAt === null && tower)
        logActivity(`Received +${towerXpPerKill(tower.floor)} XP`);
      if (mob) {
        mob.hp = 0;
        mob.downAt = now;
      }
      emit();
      return;
    }
    case "floor": {
      const was = bossFight.tower;
      setTower(m, now);
      if (m.cleared && !(was?.floor === m.floor && was.cleared)) {
        notify(`Floor ${m.floor} cleared! The way on is open.`, {
          kind: "success",
        });
        sfxPortal();
      } else if (!m.cleared && was && was.floor !== m.floor) {
        notify(`Floor ${m.floor}`, { kind: "info" });
      }
      emit();
      return;
    }
    case "closing":
      bossFight.closing = { why: m.why, at: clock.toLocal(m.closesAt) };
      // The wipe has its own banner (moments.ts); the log keeps it.
      if (m.why === "wiped")
        logActivity("The boss won: everyone in the raid was knocked out");
      emit();
      return;
    case "tally":
      bossFight.tally = { score: m.score, rank: m.rank, of: m.of };
      emitHp();
      return;
    case "bossAt":
      pushBossAt(
        m.x,
        m.z,
        m.yaw,
        m.at !== undefined ? clock.toLocal(m.at) : now,
      );
      return;
    case "say":
      bossFight.say = { text: m.text, until: clock.toLocal(m.until) };
      emit();
      return;
    case "raid": {
      const was = bossFight.raid;
      const { t: _t, ...r } = m;
      bossFight.raid = raidView(r, clock);
      // In the fight, its start is the FIGHT! banner (moments.ts).
      if (
        was?.stage === "lobby" &&
        r.stage === "fight" &&
        bossFight.raid.you !== "in"
      )
        notify("The fight began without you.", { kind: "info" });
      emit();
      return;
    }
    case "buffOff":
      clearBuff(m.id, m.buff);
      return;
    case "channel": {
      if (m.target === null) {
        const was = skills.channels.get(m.by);
        setChannel(m.by, null);
        // Yours stopped short: nothing spent, ready again.
        if (m.by === clock.you()) {
          setReadyAt("resurrect", now);
          if (was && now < was.until - 200)
            notify("Resurrect stopped: hold still while you play.", {
              kind: "info",
              holdMs: 2_500,
            });
        }
      } else {
        setChannel(m.by, {
          target: m.target,
          from: now,
          until: clock.toLocal(m.until),
        });
        if (m.by === clock.you() || m.target === clock.you()) sfxChannel();
      }
      return;
    }
    case "revived": {
      if (m.by === clock.you()) {
        setReadyAt("resurrect", now + SKILL_DEFS.resurrect.cooldownMs);
        logActivity("Brought a fallen herzie back to its feet");
      }
      if (m.id === clock.you()) {
        notify("A Bard played you back to your feet!", { kind: "success" });
        logActivity("Resurrected by a Bard");
      }
      // A burst of light where they stand back up, for everyone.
      {
        const at = entityAt.get(m.id);
        if (at) waveField.burst([at.x, at.top * 0.6, at.z], [0, 1, 0], "crit");
        if (at || m.id === clock.you() || m.by === clock.you()) sfxRevive();
      }
      // Outside a fight nobody's health is tracked: the hp that follows
      // counts up from nothing, for its heal number.
      if (!bossFight.health.has(m.id))
        bossFight.health.set(m.id, { hp: 0, maxHp: 0 });
      emit();
      return;
    }
    case "out":
      if (bossFight.raid) bossFight.raid = { ...bossFight.raid, you: "out" };
      emit();
      return;
    case "skill": {
      // Yours played the moment you pressed it.
      if (m.by === clock.you() || !isSkillId(m.skill)) return;
      if (m.skill === "taunt") sfxTaunt();
      noteSkillCast({
        by: m.by,
        skill: m.skill,
        level: m.level,
        x: m.x,
        z: m.z,
        yaw: m.yaw,
        at: now,
      });
      return;
    }
    case "buff":
      setBuff(m.id, {
        buff: m.buff,
        value: m.value,
        until: clock.toLocal(m.until),
        ...(m.kind ? { kind: m.kind } : {}),
      });
      return;
    case "skillDenied": {
      // The prediction was wrong: the server's word on when it's ready.
      const id =
        skills.sent.get(m.seq) ?? (isSkillId(m.skill) ? m.skill : null);
      if (!id) return;
      skills.sent.delete(m.seq);
      setReadyAt(id as SkillId, m.readyAt > 0 ? clock.toLocal(m.readyAt) : now);
      // Nor is the buff you put on yourself.
      if (id === "cymbrella" || id === "taunt")
        clearBuff(clock.you() ?? -1, id);
      if (m.reason) notify(REFUSALS[m.reason], { kind: "info" });
      emitSkills();
      return;
    }
    case "skillUp":
      if (!isSkillId(m.skill)) return;
      skills.list = skills.list.map((s) =>
        s.id === m.skill ? { id: m.skill, level: m.level } : s,
      );
      notify(`Leveled up "${SKILL_DEFS[m.skill].name}" to Lv. ${m.level}`, {
        kind: "success",
      });
      emitSkills();
      return;
  }
}

function applyFight(f: FightState, clock: Clock, you: number) {
  bossFight.on = true;
  // In the room the server's value is the truth, and health doesn't regen.
  setRegenFrozen(true);
  const me = f.health.find((h) => h.id === you);
  if (me) setHpNow(me.hp);
  bossFight.event = f.event;
  bossFight.hp = f.hp;
  bossFight.maxHp = f.maxHp;
  bossFight.phase = f.phase;
  bossFight.shapes = f.telegraphs.map((t) => shape(t, clock));
  bossFight.health = new Map(
    f.health.map((h) => [h.id, { hp: h.hp, maxHp: h.maxHp }]),
  );
  bossFight.closing = null;
  bossFight.victory = null;
  bossFight.loots = [];
  if (f.tower) setTower(f.tower, performance.now());
  else bossFight.tower = null;
  const now = performance.now();
  bossFight.raid = f.raid ? raidView(f.raid, clock, f.raid.you) : null;
  bossFight.bossPath = [];
  if (f.bossAt) pushBossAt(f.bossAt.x, f.bossAt.z, f.bossAt.yaw, now);
  bossFight.say = f.say
    ? { text: f.say.text, until: clock.toLocal(f.say.until) }
    : null;
  if (!f.tower) towerMobs.clear();
  if (f.mobs) syncMobs(f.mobs, now);
  skills.buffs.clear();
  for (const b of f.buffs ?? [])
    setBuff(b.id, {
      buff: b.buff,
      value: b.value,
      until: clock.toLocal(b.until),
      ...(b.kind ? { kind: b.kind } : {}),
    });
  skills.channels.clear();
  for (const c of f.channels ?? [])
    setChannel(c.by, {
      target: c.target,
      from: now,
      until: clock.toLocal(c.until),
    });
}

/** Drop shapes that landed a while ago. Called by the frame loop. */
export function pruneShapes(now: number): void {
  const s = bossFight.shapes;
  if (!s.length) return;
  const keep = s.filter(
    (x) => x.resolvedAt === null || now - x.resolvedAt < SHAPE_FLASH_MS,
  );
  if (keep.length !== s.length) {
    bossFight.shapes = keep;
    // Re-render, so a landed shape is taken off the floor.
    emit();
  }
}

/**
 * Dev only (Settings > Debug > "Drop Test Loot"): a random item tossed down
 * in front of you, wherever you are in the Town, to watch and tune the
 * drop, the pickup and the spirit's fetch. Nothing is granted.
 */
export function debugDropLoot(count = 1): void {
  const pool = ITEMS.filter((i) => getItemIcon(i));
  const pick = () => pool[Math.floor(Math.random() * pool.length)].id;
  // Stamped NaN: the Town isn't drawing while Settings is open, so the
  // drop starts on its first frame back.
  bossFight.loots = [
    ...bossFight.loots,
    {
      id: ++lootSeq,
      drops: Array.from({ length: count }, () => ({ id: "", item: pick() })),
      at: Number.NaN,
      here: true,
    },
  ];
  emit();
}
