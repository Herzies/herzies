import {
  isSkillId,
  SKILL_DEFS,
  type SkillId,
  skillValue,
} from "@herzies/shared";
import { useSyncExternalStore } from "react";

/**
 * Class skills as the client holds them: yours (which, its level, when it's
 * ready), the buffs on everyone in the room, and the skills just used, for
 * the effects. Written by the frame loop, the socket and the app state;
 * read by the HUD and the VFX. The Town server decides what a skill does —
 * this only predicts the cooldown and draws.
 */

export type SkillCast = {
  /** Entity id of who used it (yours too). */
  by: number;
  skill: SkillId;
  level: number;
  x: number;
  z: number;
  yaw: number;
  /** performance.now() ms. */
  at: number;
};

export type ActiveBuff = {
  buff: string;
  value: number;
  /** performance.now() ms. */
  until: number;
};

export const skills = {
  /** Your class skill, if you have a class. */
  mine: null as { id: SkillId; level: number } | null,
  /** When yours is ready again (performance.now() ms): predicted on use,
   * put right by the server's refusal. */
  readyAt: 0,
  /** Ever-rising, echoed back in a refusal. */
  seq: 0,
  /** Buffs by entity id. */
  buffs: new Map<number, ActiveBuff[]>(),
  /** Skills used lately, newest last (for the effects; pruned by age). */
  casts: [] as SkillCast[],
};

/** Where each herzie in the room is, by entity id, for effects that follow
 * them (a Cymbrella overhead, a buster's mark). Written by whoever draws
 * the herzie: RemotePlayers for others, Combat for you. */
export const entityAt = new Map<
  number,
  { x: number; z: number; top: number }
>();

/** How long a skill's effect plays, ms. */
export const SKILL_FX_MS = 1_400;

let version = 0;
const listeners = new Set<() => void>();
export const emitSkills = () => {
  version++;
  for (const l of listeners) l();
};

/** Re-render when the skill bar or buffs change (not every frame). */
export function useSkills(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

/** From the app state: your class skill and its level (the first, while a
 * class has one skill). */
export function setMySkill(
  list: readonly { skillId: string; level: number }[] | undefined,
): void {
  const first = list?.find((s) => isSkillId(s.skillId));
  const next =
    first && isSkillId(first.skillId)
      ? { id: first.skillId, level: first.level }
      : null;
  const prev = skills.mine;
  if (prev?.id === next?.id && prev?.level === next?.level) return;
  // A level-up the fight already told us about stays (sync catches up).
  if (prev && next && prev.id === next.id && prev.level > next.level) return;
  skills.mine = next;
  emitSkills();
}

/** Whether yours is ready at `now`. */
export function mySkillReady(now: number): boolean {
  return !!skills.mine && now >= skills.readyAt;
}

/** You used it: start the predicted cooldown. Returns the seq to send. */
export function startMyCooldown(now: number): number {
  const mine = skills.mine;
  if (!mine) return 0;
  skills.readyAt = now + SKILL_DEFS[mine.id].cooldownMs;
  skills.seq++;
  emitSkills();
  return skills.seq;
}

/** A skill went off (yours or someone's): play its effect. */
export function noteSkillCast(cast: SkillCast): void {
  skills.casts.push(cast);
  if (skills.casts.length > 24) skills.casts.shift();
}

/** A buff on `id`, until `until` (performance.now() ms). */
export function setBuff(id: number, buff: ActiveBuff): void {
  const list = (skills.buffs.get(id) ?? []).filter((b) => b.buff !== buff.buff);
  list.push(buff);
  skills.buffs.set(id, list);
  emitSkills();
}

/** Takes `buff` off `id` (a buff you predicted, refused). */
export function clearBuff(id: number, buff: string): void {
  const list = skills.buffs.get(id);
  if (!list?.some((b) => b.buff === buff)) return;
  skills.buffs.set(
    id,
    list.filter((b) => b.buff !== buff),
  );
  emitSkills();
}

export function buffOn(
  id: number | null,
  buff: string,
  now: number,
): ActiveBuff | undefined {
  if (id === null) return undefined;
  return skills.buffs.get(id)?.find((b) => b.buff === buff && b.until > now);
}

/** Out of the room: drop everything but your skill. */
export function resetSkills(): void {
  skills.buffs.clear();
  skills.casts = [];
  entityAt.clear();
  emitSkills();
}

/** The value a skill has at a level, as a percentage for the HUD. */
export function skillPercent(id: SkillId, level: number): number {
  return Math.round(skillValue(id, level) * 100);
}
