import { getItemIcon, ITEMS, isSkillId, SKILL_DEFS } from "@herzies/shared";
import { MOB } from "@herzies/shared/tower";
import type {
  BossTelegraph,
  FightState,
  LootDrop,
  ServerMessage,
  TowerFloor,
  TowerMob,
} from "@herzies/shared/town-net";
import { useSyncExternalStore } from "react";
import { notify } from "../../../lib/notices";
import {
  sfxDown,
  sfxHurt,
  sfxImpact,
  sfxPortal,
  sfxSlam,
  sfxWarn,
} from "../sfx";
import { setHpNow, setRegenFrozen } from "../vitals";
import { pushDamageNumber } from "./DamageNumbers";
import { setBossResults } from "./results";
import {
  clearBuff,
  emitSkills,
  noteSkillCast,
  resetSkills,
  setBuff,
  skills,
} from "./skills";
import { combat, shake } from "./state";

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
  why: "victory" | "escaped" | "sealed";
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
  /** What you got for it (item ids), and when the room said so
   * (performance.now() ms); dropped at your feet by LootDrops. */
  loot: null as {
    id: number;
    /** The pending drops behind it (an empty id: a dev drop, nothing to
     * collect). */
    drops: LootDrop[];
    at: number;
    /** Tossed down in front of you (the dev drop), not out of the boss. */
    here?: boolean;
    /** Out of a Tower mob, where it fell. */
    from?: { x: number; z: number };
  } | null,
  /** In the Tower: the floor (its mobs are in {@link towerMobs}). */
  tower: null as Omit<TowerFloor, "mobs"> | null,
  /** When the boss was last hit and when you last were (performance.now()
   * ms), for the bar's flash and the screen's. */
  bossHitAt: Number.NEGATIVE_INFINITY,
  youHitAt: Number.NEGATIVE_INFINITY,
  /** When the boss last slammed the floor, for it to rear and drop. */
  slammedAt: Number.NEGATIVE_INFINITY,
};

/** One Tower mob as the client holds it: the last few places the server
 * said it was (for drawing it smoothly, a moment behind), its health, and
 * when it fell. */
export type MobView = {
  id: number;
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

/** How far behind the newest word mobs are drawn, ms: a snapshot or two. */
export const MOB_DELAY_MS = 110;

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
    m.samples.push({ at: now, x: w.x, z: w.z, yaw: w.yaw });
    if (m.samples.length > 6) m.samples.shift();
  }
}

function setTower(f: TowerFloor, now: number) {
  const was = bossFight.tower;
  if (!was || was.floor !== f.floor) towerMobs.clear();
  const { mobs, ...floor } = f;
  bossFight.tower = floor;
  syncMobs(mobs, now);
}

let version = 0;
/** Tells one drop of loot from the next (LootDrops keys on it). */
let lootSeq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  for (const l of listeners) l();
};

/** Re-render when the fight changes shape (not every frame). */
export function useBossFight(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

/** Out of the boss room: forget the fight. */
export function resetBossFight(): void {
  if (
    !bossFight.on &&
    !bossFight.shapes.length &&
    !bossFight.closing &&
    !bossFight.loot
  )
    return;
  bossFight.on = false;
  setRegenFrozen(false);
  bossFight.event = "";
  bossFight.shapes = [];
  bossFight.health.clear();
  bossFight.closing = null;
  bossFight.victory = null;
  bossFight.loot = null;
  bossFight.you = null;
  bossFight.tower = null;
  towerMobs.clear();
  resetSkills();
  emit();
}

/** How long a landed shape lingers (its flash) before it's gone, ms. */
export const SHAPE_FLASH_MS = 380;

export type Clock = {
  /** A server time as performance.now() ms. */
  toLocal: (serverTime: number) => number;
  you: () => number | null;
};

/** Where the boss's chest is, for a damage number over it. */
const BOSS_NUMBER_AT = [0, 3.4, -4] as const;

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
      if (!m.fight) return;
      applyFight(m.fight, clock, m.you);
      bossFight.you = m.you;
      emit();
      return;
    }
    case "boss":
      bossFight.hp = m.hp;
      bossFight.maxHp = m.maxHp;
      bossFight.phase = m.phase;
      bossFight.bossHitAt = now;
      emit();
      return;
    case "telegraph": {
      if (!bossFight.on) return;
      const { t: _t, ...t } = m;
      bossFight.shapes.push(shape(t, clock));
      sfxWarn(Math.max(0.4, (clock.toLocal(m.hitAt) - now) / 1000));
      emit();
      return;
    }
    case "resolve": {
      const s = bossFight.shapes.find((x) => x.id === m.id);
      if (s) s.resolvedAt = now;
      bossFight.slammedAt = now;
      sfxSlam();
      const you = clock.you();
      if (you !== null && m.hits.includes(you)) {
        bossFight.youHitAt = now;
        shake(0.45);
        sfxHurt();
      } else {
        shake(0.12);
      }
      emit();
      return;
    }
    case "hp": {
      bossFight.health.set(m.id, { hp: m.hp, maxHp: m.maxHp });
      if (m.id === clock.you()) setHpNow(m.hp);
      emit();
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
        pushDamageNumber(
          [BOSS_NUMBER_AT[0] + jitter, BOSS_NUMBER_AT[1], BOSS_NUMBER_AT[2]],
          m.damage,
          m.crit,
        );
      }
      combat.hitAt = now;
      combat.hitCrit = m.crit;
      shake(m.crit ? 0.3 : 0.1);
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
      bossFight.loot = {
        id: ++lootSeq,
        drops: m.drops,
        at: now,
        ...(m.at ? { from: m.at } : {}),
      };
      emit();
      return;
    case "mobs": {
      const before = towerMobs.size;
      syncMobs(m.mobs, now);
      if (towerMobs.size !== before) emit();
      return;
    }
    case "mobDown": {
      const mob = towerMobs.get(m.mob);
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
      emit();
      return;
    case "skill": {
      // Yours played the moment you pressed it.
      if (m.by === clock.you() || !isSkillId(m.skill)) return;
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
      });
      return;
    case "skillDenied":
      // The prediction was wrong: the server's word on when it's ready.
      if (m.seq === skills.seq) {
        skills.readyAt = m.readyAt > 0 ? clock.toLocal(m.readyAt) : now;
        // Nor is the Cymbrella you put on.
        if (skills.mine?.id === "cymbrella")
          clearBuff(clock.you() ?? -1, "cymbrella");
        emitSkills();
      }
      return;
    case "skillUp":
      if (!isSkillId(m.skill)) return;
      if (skills.mine?.id === m.skill)
        skills.mine = { id: m.skill, level: m.level };
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
  bossFight.loot = null;
  if (f.tower) setTower(f.tower, performance.now());
  else bossFight.tower = null;
  skills.buffs.clear();
  for (const b of f.buffs ?? [])
    setBuff(b.id, {
      buff: b.buff,
      value: b.value,
      until: clock.toLocal(b.until),
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
  bossFight.loot = {
    id: ++lootSeq,
    drops: Array.from({ length: count }, () => ({ id: "", item: pick() })),
    at: Number.NaN,
    here: true,
  };
  emit();
}
