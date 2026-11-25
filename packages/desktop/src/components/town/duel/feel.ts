import { logActivity } from "../../../lib/activity";
import { notify } from "../../../lib/notices";
import {
  pushBleedNumber,
  pushBlockedLabel,
  pushDamageNumber,
  pushHealNumber,
  pushStunLabel,
} from "../combat/DamageNumbers";
import { entityAt } from "../combat/skills";
import { combat, kick, shake } from "../combat/state";
import type { Vec3 } from "../combat/waves";
import { waveField } from "../combat/waves";
import { townSave } from "../runtime";
import {
  sfxDuelBlocked,
  sfxDuelChallenge,
  sfxDuelDefeat,
  sfxDuelFight,
  sfxDuelFinish,
  sfxDuelOut,
  sfxDuelThock,
  sfxDuelThump,
  sfxDuelTick,
  sfxDuelVictory,
  sfxHealBolt,
  sfxHurt,
  sfxStun,
} from "../sfx";
import { countdownBeat, mmss } from "./clock";
import {
  FX,
  finishFighters,
  flashFighter,
  kneelFighter,
  leanFighter,
  stopFighter,
} from "./fx";
import {
  type DuelEvent,
  duel,
  localOf,
  myDuel,
  onDuelEvent,
  opponentIn,
  pruneDuels,
} from "./store";

/**
 * What a duel feels like, from the store's events and the clock: sounds,
 * damage numbers, flashes, hit-stop, shakes and the lines in the corner.
 * Shakes are only for blows you deal or take; everyone near sees the rest.
 */

/** Things the HUD draws off these (performance.now() ms). */
export const duelFeel = {
  /** You were last hurt in a duel: the red edge, your bar's shake. */
  hurtAt: Number.NEGATIVE_INFINITY,
  /** "WINNER" floats over a duel's winner, for those watching. */
  winners: new Map<number, number>(),
};

/** How long WINNER floats (ms), and how near you see and hear a duel's end
 * (world units). */
export const WINNER_MS = 1_500;
const NEAR = 30;
/** When the centre marker lands after the ring appears (ms). */
export const MARKER_DROP_MS = 300;

/** What's been played already, per duel: its thump, its countdown's beat,
 * its sudden death. */
const played = new Map<
  number,
  { thump: boolean; beat: string | number | null; sudden: boolean }
>();
/** The last whole second the out-of-bounds tick sounded on. */
let outTick: number | null = null;

const near = (x: number, z: number) =>
  Math.hypot(x - townSave.x, z - townSave.z) <= NEAR;

/** The text over a herzie: its top, a touch higher. */
function over(id: number): [number, number, number] | null {
  const e = entityAt.get(id);
  return e ? [e.x, e.top + 0.3, e.z] : null;
}

function onEvent(e: DuelEvent) {
  const now = performance.now();
  switch (e.k) {
    case "ask":
      sfxDuelChallenge();
      return;
    case "refused":
      notify(e.text, { kind: "info" });
      return;
    case "rematch":
      if (duel.result?.opponent === e.by) sfxDuelChallenge();
      return;
    case "hp": {
      const { duel: d, id } = e;
      if (e.hp > e.was) {
        pushHealNumber(id === duel.you ? null : id, e.hp - e.was);
        if (id === duel.you) sfxHealBolt();
        return;
      }
      if (e.hp >= e.was) return;
      const by = opponentIn(d, id);
      flashFighter(id, now);
      // Both held still a beat, a bigger blow longer.
      const big = (e.was - e.hp) / e.maxHp > 0.12;
      stopFighter(id, big ? FX.critStopMs : FX.stopMs, now);
      stopFighter(by, big ? FX.critStopMs : FX.stopMs, now);
      const from = entityAt.get(by);
      const to = entityAt.get(id);
      if (from && to) leanFighter(id, to.x - from.x, to.z - from.z, now);
      if (id === duel.you) {
        duelFeel.hurtAt = now;
        shake(big ? 0.38 : 0.26);
        sfxHurt();
      }
      return;
    }
    case "hit": {
      const at = over(e.target);
      if (e.blocked) {
        if (at) pushBlockedLabel(at);
        sfxDuelBlocked();
        return;
      }
      if (at) {
        const jitter = () => (Math.random() - 0.5) * 0.6;
        const p: Vec3 = [at[0] + jitter(), at[1], at[2] + jitter()];
        if (e.bleed) pushBleedNumber(p, e.damage, `duel${e.target}`);
        else pushDamageNumber(p, e.damage, e.crit, `duel${e.target}`);
      }
      // A bleed hit: the number alone.
      if (e.bleed) return;
      combat.hitAt = now;
      combat.hitCrit = e.crit;
      if (combat.trauma < 0.3) shake(e.crit ? 0.22 : 0.08);
      sfxDuelThock(e.crit);
      return;
    }
    case "stun": {
      const at = over(e.id);
      if (at && localOf(e.until) > now) {
        pushStunLabel(at);
        sfxStun();
      }
      return;
    }
    case "out":
      outTick = null;
      return;
    case "end":
      onEnd(e, now);
      return;
  }
}

function onEnd(e: Extract<DuelEvent, { k: "end" }>, now: number) {
  const d = e.duel;
  const mine = !!e.result;
  const seen = mine || near(d.x, d.z);
  if (e.why === "cancelled") {
    if (mine) notify("The duel was called off.", { kind: "info" });
    return;
  }
  // The winning blow: slowed, the loser flashed white and down on its
  // knees (not knocked out: nothing's lost).
  if (e.loser !== null && e.why !== "left") {
    if (e.why === "defeat") {
      finishFighters([d.a, d.b], now);
      flashFighter(e.loser, now, FX.finishFlashMs);
      if (seen) sfxDuelFinish();
      if (mine) shake(0.3);
    }
    kneelFighter(e.loser, now);
  }
  const a = `"${e.names.a}"`;
  const b = `"${e.names.b}"`;
  const winner = e.winner === d.a ? a : b;
  const loser = e.winner === d.a ? b : a;
  const time = ` (${mmss(e.ms)})`;
  if (e.result) {
    const r = e.result;
    const them = `"${r.who.name}"`;
    logActivity(
      r.won === true
        ? `Won a duel against ${them}`
        : r.won === false
          ? `Lost a duel to ${them}`
          : `Drew a duel with ${them}`,
    );
    // The banner's sting, as it comes in.
    setTimeout(() => {
      if (r.won === true) sfxDuelVictory();
      else sfxDuelDefeat();
    }, 600);
    return;
  }
  if (!seen) return;
  notify(
    e.winner === null
      ? `${a} and ${b} fought to a draw${time}`
      : e.why === "yield" || e.why === "bounds"
        ? `${loser} yielded to ${winner}${time}`
        : e.why === "left"
          ? `${loser} left the duel with ${winner}`
          : `${winner} defeated ${loser} in a duel${time}`,
    { kind: "info" },
  );
  if (e.winner !== null) duelFeel.winners.set(e.winner, now);
}

/**
 * The duel's moments on the clock, each frame: the centre marker landing,
 * the countdown's ticks and "FIGHT!", sudden death, the out-of-bounds tick.
 */
export function stepDuelFeel(now: number): void {
  for (const d of duel.rooms.values()) {
    let p = played.get(d.id);
    if (!p) {
      // Already running when you came: nothing to replay.
      const old = !Number.isFinite(d.seenAt);
      p = { thump: old, beat: old ? "fight" : null, sudden: old };
      played.set(d.id, p);
    }
    const mine = d.a === duel.you || d.b === duel.you;
    if (!p.thump && now - d.seenAt >= MARKER_DROP_MS) {
      p.thump = true;
      if (mine || near(d.x, d.z)) {
        sfxDuelThump();
        waveField.burst([d.x, 0.2, d.z], [0, 1, 0], "hit");
        if (mine) shake(0.12);
      }
    }
    if (d.endedAt !== null) continue;
    if (mine) {
      const { beat } = countdownBeat(
        localOf(d.at),
        localOf(d.startsAt),
        d.intro,
        now,
      );
      if (beat !== p.beat) {
        if (beat === "fight" && p.beat !== null) {
          sfxDuelFight();
          kick(0.08);
        } else if (typeof beat === "number") sfxDuelTick(3 - beat);
        p.beat = beat;
      }
    }
    if (!p.sudden && now >= localOf(d.suddenAt)) {
      p.sudden = true;
      if (mine || near(d.x, d.z)) sfxDuelFight();
    }
  }
  for (const id of played.keys()) if (!duel.rooms.has(id)) played.delete(id);
  for (const [id, at] of duelFeel.winners)
    if (now - at > WINNER_MS) duelFeel.winners.delete(id);
  // Outside the ring: a tick each second left.
  if (duel.outUntil !== null && myDuel()) {
    const left = Math.ceil((localOf(duel.outUntil) - now) / 1000);
    if (left > 0 && left !== outTick) {
      outTick = left;
      sfxDuelOut();
    }
  }
  pruneDuels(now);
}

onDuelEvent(onEvent);
