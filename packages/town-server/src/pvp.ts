/**
 * What every herzie-against-herzie judge shares: a duel (duel.ts) and the
 * Wilds' free-for-all (wilds.ts). How a herzie fights from its ticket, and
 * what its basic cast meets: the same aim, assist, reach and flight times
 * as a cast at the boss, with other herzies as the bodies. Pure.
 */
import { classDef } from "@herzies/shared/boss-fight";
import { type AttackStyle, isHerzieClass } from "@herzies/shared/classes";
import {
  aimDirection,
  bodyHitAt,
  DISC_RANGE,
  discLandsAfterMs,
  HERZIE_BODY,
  MELEE_REACH,
  meleeReaches,
  WAVE_HAND_HEIGHT,
  WAVE_SPEED,
} from "@herzies/shared/combat";
import { duelAttackShare, duelMaxHp } from "@herzies/shared/duel";
import type { Buff, SkillId } from "@herzies/shared/skills";
import type {
  ServerMessage,
  TownTicketPayload,
} from "@herzies/shared/town-net";
import { TUNING } from "./boss";
import {
  armsOf,
  type FightStats,
  type Outbound,
  skillsOf,
  statsOf,
} from "./fight";
import type { PositionHistory } from "./history";

/** How a herzie fights, from its newest ticket. */
export type PvpTicket = Pick<
  TownTicketPayload,
  "look" | "st" | "sk" | "lv" | "cls"
>;

/** A herzie as a PvP judge fights it: health from its level alone
 * (duelMaxHp), its ticket's stats, its Def as it fights (classDef), its
 * basic attack and skills. */
export type PvpKit = {
  level: number;
  maxHp: number;
  stats: FightStats;
  def: number;
  attack: AttackStyle;
  melee: number;
  armed: boolean;
  skills: Map<SkillId, number>;
};

export function pvpKit(c: PvpTicket): PvpKit {
  const stats = statsOf(c.st);
  const level =
    typeof c.lv === "number" && Number.isFinite(c.lv)
      ? Math.max(1, Math.floor(c.lv))
      : 1;
  const cls = isHerzieClass(c.cls) ? c.cls : null;
  return {
    level,
    maxHp: duelMaxHp(level),
    stats,
    def: classDef(cls, stats.def),
    ...armsOf(c),
    skills: skillsOf(c),
  };
}

/** Where `uid` stood as another player's client saw it at `now`: a
 * moment behind the server (TUNING.seenLagMs). */
export function seenAt(
  history: PositionHistory,
  uid: string,
  now: number,
): { x: number; z: number } | null {
  return history.at(uid, now - TUNING.seenLagMs) ?? history.at(uid, now);
}

/** A herzie a cast may meet: who, and where it stands. */
export type PvpBody = { uid: string; x: number; z: number };

/** How far along `dir` from (x, z) a wave (or a disc, which only goes so
 * far) first meets one of `bodies`, and whose. */
export function firstAlong(
  from: { x: number; z: number },
  dir: readonly [number, number, number],
  bodies: readonly PvpBody[],
  disc: boolean,
): { uid: string; dist: number } | null {
  let best: { uid: string; dist: number } | null = null;
  for (const b of bodies) {
    const dist = bodyHitAt(
      [from.x, WAVE_HAND_HEIGHT, from.z],
      dir,
      { ...HERZIE_BODY, x: b.x, z: b.z },
      disc ? DISC_RANGE : undefined,
    );
    if (dist !== null && (!best || dist < best.dist))
      best = { uid: b.uid, dist };
  }
  return best;
}

/**
 * What a basic cast from `pos`, aimed (yaw, pitch), meets of `bodies`: a
 * blow, the nearest in its reach (at once); a wave or a disc, the first in
 * its way (when it gets there). `mult`: its share of a wave
 * (duelAttackShare). Null: nothing.
 */
export function castMeets(
  kit: Pick<PvpKit, "attack" | "melee">,
  pos: { x: number; z: number },
  yaw: number,
  pitch: number,
  bodies: readonly PvpBody[],
): { uid: string; dist: number; flightMs: number; mult: number } | null {
  const mult = duelAttackShare(kit.attack, kit.melee);
  if (kit.attack === "melee") {
    let best: { uid: string; dist: number } | null = null;
    for (const b of bodies) {
      const reaches = meleeReaches(
        pos,
        yaw,
        { x: b.x, z: b.z, radius: HERZIE_BODY.radius },
        MELEE_REACH + TUNING.meleeSlack,
      );
      const dist = Math.hypot(b.x - pos.x, b.z - pos.z);
      if (reaches && (!best || dist < best.dist)) best = { uid: b.uid, dist };
    }
    return best && { ...best, flightMs: 0, mult };
  }
  const disc = kit.attack === "disc";
  const hit = firstAlong(pos, aimDirection(yaw, pitch), bodies, disc);
  if (!hit) return null;
  const flightMs = disc
    ? discLandsAfterMs(hit.dist)
    : (hit.dist / WAVE_SPEED) * 1000;
  return { ...hit, flightMs, mult };
}

export function to(uid: string, msg: ServerMessage): Outbound {
  return { to: { uid }, msg };
}

export function all(msg: ServerMessage): Outbound {
  return { to: "all", msg };
}

export function buffMsg(id: number, b: Buff): ServerMessage {
  return {
    t: "buff",
    id,
    buff: b.id,
    value: b.value,
    until: b.until,
    ...(b.kind ? { kind: b.kind } : {}),
  };
}

export const round = (n: number) => Math.round(n * 100) / 100;
