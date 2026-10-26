/**
 * The raid's big beats, each felt three ways (a sound, the camera, a word
 * across the screen) so none of them slips by in the noise of a fight:
 *
 * - the lobby's last ten seconds, counted down;
 * - the boss waking ("FIGHT!"), with a roar;
 * - each new phase, with a roar and a flash on the boss;
 * - its minions arriving, with a call and a puff where each stands;
 * - the enrage, and the end of it;
 * - a wipe.
 *
 * Watched once a frame from the boss's own frame loop (`stepMoments`), off
 * the fight's state, so it works the same whether a beat came from a
 * message or from the clock (the enrage has no message of its own).
 */
import { useSyncExternalStore } from "react";
import {
  sfxCountdown,
  sfxEnrage,
  sfxFight,
  sfxRoar,
  sfxSummon,
  sfxWipe,
} from "../sfx";
import { bossFight, towerMobs } from "./fight";
import { shake } from "./state";
import { waveField } from "./waves";

export type BannerTone = "count" | "fight" | "phase" | "enrage" | "wipe";

export type Banner = {
  text: string;
  sub?: string;
  tone: BannerTone;
  /** performance.now() ms it went up, and how long it stays. */
  at: number;
  ms: number;
};

let banner: Banner | null = null;
const listeners = new Set<() => void>();

function show(b: Omit<Banner, "at">, now: number) {
  banner = { ...b, at: now };
  for (const l of listeners) l();
}

/** The word across the screen right now, if any (re-renders on a new one). */
export function useBanner(): Banner | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => banner,
  );
}

/** When the boss woke and last changed phase (performance.now() ms): its
 * body plays them out (Boss.tsx). */
export const beats = {
  wokeAt: Number.NEGATIVE_INFINITY,
  phaseAt: Number.NEGATIVE_INFINITY,
};

const PHASE_LINES: Record<2 | 3, string> = {
  2: "It's getting angry",
  3: "Its last stand",
};

let seen: {
  event: string;
  stage: string | null;
  phase: number;
  count: number;
  minions: Set<number>;
  enraged: boolean;
  hard: boolean;
  wiped: boolean;
} | null = null;

/** Forget the beats already played (a new fight, or out of the room). */
export function resetMoments(): void {
  seen = null;
  banner = null;
  beats.wokeAt = Number.NEGATIVE_INFINITY;
  beats.phaseAt = Number.NEGATIVE_INFINITY;
  for (const l of listeners) l();
}

/** Play whatever beat the fight has just reached. */
export function stepMoments(now: number): void {
  const raid = bossFight.raid;
  if (!bossFight.on || bossFight.tower || !raid) return;
  // Arriving mid-fight: what already happened isn't played again.
  if (!seen || seen.event !== bossFight.event) {
    seen = {
      event: bossFight.event,
      stage: raid.stage,
      phase: bossFight.phase,
      count: -1,
      minions: new Set(towerMobs.keys()),
      enraged: raid.enrageAt !== null && now >= raid.enrageAt,
      hard: raid.hardAt !== null && now >= raid.hardAt,
      wiped: bossFight.closing?.why === "wiped",
    };
    if (raid.stage === "fight") beats.wokeAt = Number.NEGATIVE_INFINITY;
  }
  const s = seen;

  if (raid.stage === "lobby") {
    const left = Math.ceil((raid.startsAt - now) / 1000);
    if (left >= 1 && left <= 10 && left !== s.count) {
      s.count = left;
      sfxCountdown(false);
      show({ text: String(left), tone: "count", ms: 900 }, now);
    }
  }

  if (s.stage === "lobby" && raid.stage === "fight") {
    beats.wokeAt = now;
    sfxFight();
    shake(0.5);
    show(
      {
        text: "FIGHT!",
        sub: "Dodge the floor, keep the music on",
        tone: "fight",
        ms: 1_800,
      },
      now,
    );
  }
  s.stage = raid.stage;

  // Once it's fallen (a last blow can cross a phase too), no more beats
  // but the end's own.
  if (bossFight.victory || bossFight.closing) s.phase = bossFight.phase;
  if (bossFight.phase > s.phase) {
    s.phase = bossFight.phase;
    beats.phaseAt = now;
    sfxRoar();
    shake(0.35);
    const p = bossFight.phase as 2 | 3;
    show(
      { text: `Phase ${p}`, sub: PHASE_LINES[p], tone: "phase", ms: 1_600 },
      now,
    );
  }

  // Its minions: a call, and a puff where each new one stands.
  let fresh = 0;
  for (const [id, m] of towerMobs) {
    if (s.minions.has(id)) continue;
    s.minions.add(id);
    if (m.downAt !== null) continue;
    fresh++;
    const at = m.samples[m.samples.length - 1];
    if (at) waveField.burst([at.x, 0.6, at.z], [0, 1, 0], "crit");
  }
  if (fresh) sfxSummon();

  if (!s.enraged && raid.enrageAt !== null && now >= raid.enrageAt) {
    s.enraged = true;
    sfxEnrage();
    shake(0.3);
    show(
      {
        text: "ENRAGED",
        sub: "It hits harder every 30 seconds",
        tone: "enrage",
        ms: 2_000,
      },
      now,
    );
  }
  if (!s.hard && raid.hardAt !== null && now >= raid.hardAt) {
    s.hard = true;
    sfxEnrage(true);
    shake(0.6);
    show(
      {
        text: "It's had enough",
        sub: "Finish it, now",
        tone: "enrage",
        ms: 2_200,
      },
      now,
    );
  }

  if (!s.wiped && bossFight.closing?.why === "wiped") {
    s.wiped = true;
    sfxWipe();
    show(
      { text: "Wiped", sub: "The boss won this time", tone: "wipe", ms: 2_600 },
      now,
    );
  }
}
