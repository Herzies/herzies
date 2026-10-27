import {
  getItem,
  isSkillId,
  SKILL_DEFS,
  type SkillId,
  skillValue,
} from "@herzies/shared";
import { useSyncExternalStore } from "react";
import { notify } from "../../../lib/notices";
import { offerSkillSlot } from "../hotbarSlots";

/**
 * Class skills as the client holds them: yours (which, their levels, when
 * each is ready), the buffs on everyone in the room, the skills just used,
 * for the effects, and any resurrect being played. Written by the frame
 * loop, the socket and the app state; read by the HUD and the VFX. The
 * Town server decides what a skill does — this only predicts cooldowns and
 * draws.
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
  /** An in-tune bonus: what it does ("def", "heal", "damage"). */
  kind?: string;
};

/** A Bard playing a resurrect: on whom, and when it lands (performance.now()
 * ms). */
export type Channel = { target: number; from: number; until: number };

export const skills = {
  /** Your class's skills, in its order (the starter first). */
  list: [] as { id: SkillId; level: number }[],
  /** When each of yours is ready again (performance.now() ms): predicted on
   * use, put right by the server. */
  readyAt: new Map<SkillId, number>(),
  /** Ever-rising, echoed back in a refusal; and which skill each was. */
  seq: 0,
  sent: new Map<number, SkillId>(),
  /** The skill last asked for (its hotbar key, or Q) and when, kept for
   * Combat's CAST_BUFFER_MS, so a press just before it's ready still goes
   * off. */
  queued: null as { id: SkillId; at: number } | null,
  /** Buffs by entity id. */
  buffs: new Map<number, ActiveBuff[]>(),
  /** Skills used lately, newest last (for the effects; pruned by age). */
  casts: [] as SkillCast[],
  /** Resurrects being played, by their Bard's entity id. */
  channels: new Map<number, Channel>(),
  /** Whether you hold your class's instrument (its item id in `instrument`):
   * without it, class skills can't be played. */
  armed: true,
  instrument: null as string | null,
};

/** Why skill `id` can't be played: the instrument it needs. */
export function instrumentNeeded(id: SkillId): string {
  const name = getItem(skills.instrument ?? "")?.name ?? "your instrument";
  return `Equip "${name}" to use "${SKILL_DEFS[id].name}".`;
}

/** From the app state: whether you hold your class's instrument. */
export function setArmed(armed: boolean, instrument: string | null): void {
  if (skills.armed === armed && skills.instrument === instrument) return;
  skills.armed = armed;
  skills.instrument = instrument;
  emitSkills();
}

/** Where each herzie in the room is, by entity id, for effects that follow
 * them (a Cymbrella overhead, a buster's mark). Written by whoever draws
 * the herzie: RemotePlayers for others, Combat for you. */
export const entityAt = new Map<
  number,
  { x: number; z: number; top: number }
>();

/** Where entity `id` is drawn now: its entry updated in place (this runs
 * every frame for every herzie). */
export function setEntityAt(id: number, x: number, z: number, top: number) {
  const e = entityAt.get(id);
  if (e) {
    e.x = x;
    e.z = z;
    e.top = top;
  } else entityAt.set(id, { x, z, top });
}

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

/** From the app state: your class's skills and their levels, in the
 * class's order. */
export function setMySkills(
  list: readonly { skillId: string; level: number }[] | undefined,
  order: readonly string[] = [],
): void {
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  const next = (list ?? [])
    .flatMap((s) =>
      isSkillId(s.skillId) ? [{ id: s.skillId, level: s.level }] : [],
    )
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((s) => {
      // A level-up the fight already told us about stays (sync catches up).
      const had = skills.list.find((p) => p.id === s.id);
      return had && had.level > s.level ? had : s;
    });
  const same =
    next.length === skills.list.length &&
    next.every(
      (s, i) => s.id === skills.list[i].id && s.level === skills.list[i].level,
    );
  if (same) return;
  // Learned just now (not the list arriving at launch): say so, and put it
  // on the hotbar if there's room.
  if (skills.list.length) {
    for (const s of next)
      if (!skills.list.some((p) => p.id === s.id))
        notify(`Learned "${SKILL_DEFS[s.id].name}"`, { kind: "info" });
  }
  for (let i = 1; i <= next.length; i++) offerSkillSlot(i);
  skills.list = next;
  emitSkills();
}

/** Your `n`th skill (1-based, the class's order), if you have one. */
export function mySkillAt(n: number): { id: SkillId; level: number } | null {
  return skills.list[n - 1] ?? null;
}

/** Ask to use your `n`th skill (a key press): Combat casts it on the next
 * frame it's ready. */
export function queueSkill(n: number): void {
  const s = mySkillAt(n);
  if (s) skills.queued = { id: s.id, at: performance.now() };
}

/** Whether your skill `id` is ready at `now`. */
export function skillReady(id: SkillId, now: number): boolean {
  return (
    skills.list.some((s) => s.id === id) && now >= (skills.readyAt.get(id) ?? 0)
  );
}

/** You used `id`: start its predicted cooldown (a resurrect's channel is
 * all it blocks until it lands). Returns the seq to send. */
export function startCooldown(id: SkillId, now: number): number {
  const def = SKILL_DEFS[id];
  skills.readyAt.set(id, now + (def.channelMs ?? def.cooldownMs));
  skills.seq++;
  skills.sent.set(skills.seq, id);
  if (skills.sent.size > 16) {
    const oldest = skills.sent.keys().next().value;
    if (oldest !== undefined) skills.sent.delete(oldest);
  }
  emitSkills();
  return skills.seq;
}

/** The server's word on when `id` is ready (performance.now() ms). */
export function setReadyAt(id: SkillId, at: number): void {
  skills.readyAt.set(id, at);
  emitSkills();
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

/** Takes `buff` off `id` (a buff you predicted, refused; or one the server
 * ended early). */
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

/** How much faster entity `id` attacks at `now`: 1, or 1 + its Haste. */
export function attackSpeedOf(id: number | null, now: number): number {
  return 1 + (buffOn(id, "haste", now)?.value ?? 0);
}

/** A resurrect began (or, with `target` null, stopped). */
export function setChannel(by: number, channel: Channel | null): void {
  if (channel) skills.channels.set(by, channel);
  else skills.channels.delete(by);
  emitSkills();
}

/** Out of the room: drop everything but your skills. */
export function resetSkills(): void {
  skills.buffs.clear();
  skills.casts = [];
  skills.channels.clear();
  skills.queued = null;
  entityAt.clear();
  emitSkills();
}

/** The value a skill has at a level, as a percentage for the HUD. */
export function skillPercent(id: SkillId, level: number): number {
  return Math.round(skillValue(id, level) * 100);
}
