/**
 * Fair play: what the Town server can see of how a herzie plays, to tell a
 * person at the keys from a program playing for them. It only watches and
 * reports — one JSON line per Tower floor (and on leaving), queryable in
 * the Worker's logs — and never acts on what it sees: nothing here is
 * calibrated against people yet, so its flags are for a person to review.
 *
 * Why watch at all, when the server already decides every hit? A program
 * can play inside every rule. The client is open source and everything a
 * player is shown is in its memory: each warning shape with the moment it
 * lands, where every mob stands. A bot built on that (one was, to try a
 * game AI on the Tower) dodges on the first frame a warning arrives, aims
 * at the exact middle of its target, and fires each skill the instant its
 * cooldown ends. None of that breaks a rule; all of it shows from here:
 *
 * - Blinks: one frame to the next further than any herzie can go. The
 *   client sends a frame every 67 ms, so between two frames it moves ≤0.5
 *   (a sprint with the fastest gear). Packets bunched by the network
 *   arrive close together but still a small step apart, so the size of a
 *   step can't come from lag. A blink stays inside the move guard's
 *   allowance (rules.ts), which has to absorb bunching: this is the
 *   evidence for it instead.
 * - Dodges: for each warning that appears over where the herzie stands,
 *   whether it got out. A program gets out of nearly all of them, however
 *   short. In a simulation of the Tower (the real TowerEngine, floors
 *   31-35 at level 17, where nearly every warning is under 700 ms, 20-80
 *   ms of network each way) the autopilot got out of 99-100% of short
 *   ones; the same dodging held back by a person's reaction (200-350 ms,
 *   spread 60-120) of 79-94%. A real person plans worse than that model,
 *   so it is a generous upper bound for them. With 150 ms each way the
 *   bot fell to 93% and isn't flagged: a slow line hides it. Also logged,
 *   not flagged: how long getting out took past the least the walk out
 *   needs (the reaction plus the round trip). Its spread overlapped too
 *   much between the two to tell them apart on its own.
 * - Aim: how far off its target's middle each cast was, as a share of how
 *   wide the target looks. The crosshair finds a mob anywhere on its body,
 *   so a person's shares spread out to 1; a program aiming at the centre
 *   stays near it. (The client's aim assist is for training dummies only.)
 *   Not yet measured on a real bot: a moving mob is judged where it stood
 *   120 ms back, the client draws it ~150 ms back plus the trip down, and
 *   that gap alone moves a perfect aim off the middle. Untested beyond
 *   the unit tests; read it next to the others.
 * - Skills: how long after its cooldown ended each was used again. Weak on
 *   its own: the client keeps a press for 180 ms, so mashing the key also
 *   fires it the moment it's ready.
 * - Leaving mid-attack: the server only judges herzies that are there, so
 *   dropping the connection just before a blow lands dodges it. Counted
 *   when it happens with an attack stood in and due within a second.
 *
 * Memory is bounded (MAX_SAMPLES a list, and attacks drop out as they
 * land) and reset with each floor's report.
 */
import { TOWN_SPRINT_SPEED } from "@herzies/shared/town-net";
import { covers, type Telegraph, TUNING } from "./boss";

/** A step between two frames longer than this is a blink (≈3× the most a
 * herzie covers in one frame)... */
export const BLINK_STEP = 1.5;
/** ...if it also came faster than this (world units / s, over the time
 * between the frames' arrival): a client whose sends were held up (a
 * hidden window) arrives late and far, but not fast. */
export const BLINK_SPEED = 12;
/** A warning shorter than this (ms from appearing to landing) is short. */
export const SHORT_WARNING_MS = 700;
/** The fastest a herzie runs: a sprint with the most gear can add
 * (MAX_MOVE_SPEED, 25%; a test keeps the two in step). */
export const FASTEST = TOWN_SPRINT_SPEED * 1.25;
/** Leaving this long or less before an attack the herzie stands in lands
 * is leaving mid-attack. */
export const LEFT_MID_ATTACK_MS = 1_000;
/** A warning resolved this long before it was due was called off. */
const CALLED_OFF_MS = 50;
/** A skill used more than this long after it was ready isn't timing. */
const SKILL_TIMING_MS = 3_000;
/** Each list keeps at most this many samples between reports. */
const MAX_SAMPLES = 2_000;

/**
 * When a report raises a flag. Provisional: set from one bot and a model of
 * a person, not from people playing the Tower. Read them as "worth a look",
 * never as proof.
 */
export const FLAGS = {
  /** Any blink. */
  blinks: 1,
  /** From this many short attacks stood in since entering (the run, not
   * the floor: a floor has too few to tell a quick person from a bot)... */
  dodgeMin: 60,
  /** ...getting out of at least this share of them (the fastest
   * person-like model reached 0.94; the bot 0.99-1). */
  dodgeEscape: 0.97,
  /** From this many casts on a target since coming in... */
  aimMin: 60,
  /** ...half of them this close to its middle (share of its half-width).
   * The autopilot, played against a local server: 0.06-0.08 a floor. The
   * median, as the far end swung from 0.16 to 0.82 floor to floor. */
  aimP50: 0.15,
  /** From this many skills used again soon after ready since coming in... */
  skillMin: 8,
  /** ...nine in ten within this many ms of it. */
  skillP90Ms: 80,
  /** Left mid-attack this often since coming in. */
  leaves: 2,
};

/** How far (x, z) is from the way out of `tg`, inside it. */
export function edgeDistance(tg: Telegraph, x: number, z: number): number {
  if (tg.kind === "lane") {
    const yaw = tg.yaw ?? 0;
    const dx = x - tg.x;
    const dz = z - tg.z;
    const along = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const across = Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw));
    return Math.max(
      0,
      Math.min(
        tg.r + TUNING.playerRadius - across,
        along + TUNING.boss.radius,
        (tg.len ?? 0) + TUNING.playerRadius - along,
      ),
    );
  }
  const d = Math.hypot(x - tg.x, z - tg.z);
  const out = tg.r - d;
  return Math.max(0, tg.inner > 0 ? Math.min(out, d - tg.inner) : out);
}

/** Which attack a warning is part of: a lunger's lane is several circles
 * from one mob, landing together, and one dodge. */
function attackOf(tg: Telegraph): string {
  return tg.mob !== undefined ? `m${tg.mob}@${tg.hitAt}` : `t${tg.id}`;
}

/** An attack the herzie stood in when it appeared: its warnings (those
 * over the herzie, and every one of the attack's, to know if any struck),
 * when the herzie was out of all of those it stood in, and the least time
 * (ms) that walk out takes at the fastest a herzie runs. */
type Watch = {
  over: Telegraph[];
  pending: Set<number>;
  struck: boolean;
  short: boolean;
  outAt: number | null;
  at: number;
  needMs: number;
};

/** Dodges counted since the herzie came in (not reset by a report). */
type Totals = {
  stoodIn: number;
  escaped: number;
  shortStoodIn: number;
  shortEscaped: number;
  /** Times it left (or lost its connection) just before one landed. */
  leftMidAttack: number;
};

type Track = {
  last: { t: number; x: number; z: number } | null;
  frames: number;
  blinks: number;
  maxStep: number;
  /** Attacks stood in, by attackOf, until all their warnings land. */
  watching: Map<string, Watch>;
  floor: Totals;
  run: Totals;
  /** ms from an attack appearing to the herzie being out of it, less the
   * least the walk out takes: its reaction, plus the round trip. */
  reacts: number[];
  /** Each cast's distance off its target's middle, as a share: this floor,
   * and since coming in. */
  aim: number[];
  runAim: number[];
  /** ms after each skill was ready that it was used again: this floor, and
   * since coming in. */
  skillLate: number[];
  runSkillLate: number[];
  /** Until when (ms) one long step is the game's (the jump back to the
   * start of the next floor, see moved). */
  jumpUntil: number;
  /** When each skill is next ready. */
  readyAt: Map<string, number>;
};

const totals = (): Totals => ({
  stoodIn: 0,
  escaped: 0,
  shortStoodIn: 0,
  shortEscaped: 0,
  leftMidAttack: 0,
});

function track(): Track {
  return {
    last: null,
    frames: 0,
    blinks: 0,
    maxStep: 0,
    watching: new Map(),
    floor: totals(),
    run: totals(),
    reacts: [],
    aim: [],
    runAim: [],
    skillLate: [],
    runSkillLate: [],
    jumpUntil: Number.NEGATIVE_INFINITY,
    readyAt: new Map(),
  };
}

function push(list: number[], v: number): void {
  if (list.length < MAX_SAMPLES) list.push(v);
}

/** The `q` quantile (0-1) of `xs`, or null if there are none. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

const r2 = (n: number | null) =>
  n === null ? null : Math.round(n * 100) / 100;
const r0 = (n: number | null) => (n === null ? null : Math.round(n));
const rate = (n: number, of: number) => (of ? n / of : null);

export type DodgeCounts = {
  stood_in: number;
  escaped: number;
  short_stood_in: number;
  short_escaped: number;
  short_escape_rate: number | null;
  left_mid_attack: number;
};

function counts(t: Totals): DodgeCounts {
  return {
    stood_in: t.stoodIn,
    escaped: t.escaped,
    short_stood_in: t.shortStoodIn,
    short_escaped: t.shortEscaped,
    short_escape_rate: r2(rate(t.shortEscaped, t.shortStoodIn)),
    left_mid_attack: t.leftMidAttack,
  };
}

export type FairPlayReport = {
  frames: number;
  blinks: number;
  max_step: number;
  /** Attacks stood in this floor, and (`run`) since coming in. */
  dodge: DodgeCounts & {
    run: DodgeCounts;
    react_ms: {
      p25: number | null;
      p50: number | null;
      p75: number | null;
      spread: number | null;
    };
  };
  /** This floor's casts, and (`run`) since coming in. */
  aim: AimStats & { run: AimStats };
  skills: SkillStats & { run: SkillStats };
  flags: string[];
};

export type AimStats = {
  casts: number;
  p50: number | null;
  p90: number | null;
};
export type SkillStats = {
  used: number;
  p50_ms: number | null;
  p90_ms: number | null;
};

const aimStats = (xs: readonly number[]): AimStats => ({
  casts: xs.length,
  p50: r2(quantile(xs, 0.5)),
  p90: r2(quantile(xs, 0.9)),
});
const skillStats = (xs: readonly number[]): SkillStats => ({
  used: xs.length,
  p50_ms: r0(quantile(xs, 0.5)),
  p90_ms: r0(quantile(xs, 0.9)),
});

export type FairPlaySink = (line: string) => void;

export class FairPlay {
  private tracks = new Map<string, Track>();
  /** Each attack's warnings so far, by attackOf, until they land: a lane's
   * circles come one after another, and the herzie may stand in a later
   * one only. */
  private attacks = new Map<string, number[]>();
  private attackOfId = new Map<number, string>();

  constructor(private sink: FairPlaySink = (line) => console.log(line)) {}

  private of(uid: string): Track {
    let t = this.tracks.get(uid);
    if (!t) {
      t = track();
      this.tracks.set(uid, t);
    }
    return t;
  }

  /** A frame of the herzie's, accepted at `t` (server ms). */
  frame(uid: string, t: number, x: number, z: number): void {
    const k = this.of(uid);
    k.frames++;
    const last = k.last;
    if (last) {
      const step = Math.hypot(x - last.x, z - last.z);
      k.maxStep = Math.max(k.maxStep, step);
      const gap = Math.max(t - last.t, 1000 / 15) / 1000;
      if (step > BLINK_STEP && step / gap > BLINK_SPEED) {
        // The game's own jump to the next floor's start: once, excused.
        if (t <= k.jumpUntil) k.jumpUntil = Number.NEGATIVE_INFINITY;
        else k.blinks++;
      }
    }
    k.last = { t, x, z };
    for (const w of k.watching.values())
      if (w.outAt === null && !w.over.some((tg) => covers(tg, x, z)))
        w.outAt = t;
  }

  /**
   * The game is putting the herzie somewhere (the next floor's start): one
   * long step within `graceMs` of `now` is that jump, not a blink. Frames
   * from before it are still on their way (the client walked into the far
   * portal), so the jump comes a few frames after this, from where they
   * left off: as the move guard allows it (rules.ts allowSpawnJump).
   */
  moved(uid: string, now: number, graceMs: number): void {
    const k = this.tracks.get(uid);
    if (k) k.jumpUntil = now + graceMs;
  }

  /** A warning appeared; `at` is where each herzie in the fight stood then
   * (as the server has it). An attack with a warning over a herzie is
   * watched for it until all the attack's warnings land. */
  telegraph(
    tg: Telegraph,
    at: readonly { uid: string; x: number; z: number }[],
  ): void {
    if (tg.kind === "buster" || tg.kind === "scatter") return;
    const key = attackOf(tg);
    const ids = this.attacks.get(key) ?? [];
    ids.push(tg.id);
    this.attacks.set(key, ids);
    this.attackOfId.set(tg.id, key);
    for (const p of at) {
      const k = this.of(p.uid);
      const w = k.watching.get(key);
      // A later warning of an attack already watched: it can strike too.
      if (w) w.pending.add(tg.id);
      if (!covers(tg, p.x, p.z)) continue;
      const need = (edgeDistance(tg, p.x, p.z) / FASTEST) * 1000;
      if (w) {
        w.over.push(tg);
        w.needMs = Math.max(w.needMs, need);
        continue;
      }
      k.watching.set(key, {
        over: [tg],
        pending: new Set(ids),
        struck: false,
        short: tg.hitAt - tg.at < SHORT_WARNING_MS,
        outAt: null,
        at: tg.at,
        needMs: need,
      });
    }
  }

  /**
   * A warning landed at `now` on `hit` (whoever it struck; a dome's
   * shelter counts as struck: they didn't get out). An attack watched is
   * counted once its last warning lands: got out if none of them struck.
   * One called off before it was due (its mob stunned or down) isn't a
   * dodge at all, and isn't counted.
   */
  resolved(id: number, hit: ReadonlySet<string>, now: number): void {
    const key = this.attackOfId.get(id);
    if (key === undefined) return;
    this.attackOfId.delete(id);
    const left = (this.attacks.get(key) ?? []).filter((i) => i !== id);
    if (left.length) this.attacks.set(key, left);
    else this.attacks.delete(key);
    for (const [uid, k] of this.tracks) {
      const w = k.watching.get(key);
      if (!w?.pending.delete(id)) continue;
      if (now < (w.over[0]?.hitAt ?? 0) - CALLED_OFF_MS) {
        k.watching.delete(key);
        continue;
      }
      if (hit.has(uid)) w.struck = true;
      if (w.pending.size) continue;
      k.watching.delete(key);
      for (const t of [k.floor, k.run]) {
        t.stoodIn++;
        if (w.short) t.shortStoodIn++;
        if (w.struck) continue;
        t.escaped++;
        if (w.short) t.shortEscaped++;
      }
      if (!w.struck && w.outAt !== null)
        push(k.reacts, w.outAt - w.at - w.needMs);
    }
  }

  /**
   * The herzie left (or lost its connection) at `now`. The server stops
   * judging a herzie that isn't there, so the attacks it stood in can't
   * land on it: they're no dodge, and are dropped. Each due within
   * LEFT_MID_ATTACK_MS is counted as leaving mid-attack instead: a herzie
   * that keeps doing that is dodging by disconnecting.
   */
  left(uid: string, now: number): void {
    const k = this.tracks.get(uid);
    if (!k) return;
    for (const w of k.watching.values()) {
      const lands = w.over[0]?.hitAt ?? 0;
      if (lands >= now && lands - now <= LEFT_MID_ATTACK_MS) {
        k.floor.leftMidAttack++;
        k.run.leftMidAttack++;
      }
    }
    k.watching.clear();
  }

  /** A cast that found a target, `off` radians to the side of the target's
   * middle, which looks `half` radians wide either side from there. */
  aimed(uid: string, off: number, half: number): void {
    if (!(half > 0)) return;
    const k = this.of(uid);
    push(k.aim, Math.abs(off) / half);
    push(k.runAim, Math.abs(off) / half);
  }

  /** A skill used at `now`, next ready at `readyAt`. */
  skill(uid: string, skill: string, now: number, readyAt: number): void {
    const k = this.of(uid);
    const was = k.readyAt.get(skill);
    if (was !== undefined && now >= was && now - was <= SKILL_TIMING_MS) {
      push(k.skillLate, now - was);
      push(k.runSkillLate, now - was);
    }
    k.readyAt.set(skill, readyAt);
  }

  /** What `uid` did since the last report (dodges also since coming in),
   * with any flags raised. */
  summary(uid: string): FairPlayReport {
    const k = this.of(uid);
    const p25 = quantile(k.reacts, 0.25);
    const p75 = quantile(k.reacts, 0.75);
    const spread = p25 !== null && p75 !== null ? p75 - p25 : null;
    const runShort = rate(k.run.shortEscaped, k.run.shortStoodIn);
    const runAimP50 = quantile(k.runAim, 0.5);
    const runSkillP90 = quantile(k.runSkillLate, 0.9);
    const flags: string[] = [];
    if (k.blinks >= FLAGS.blinks) flags.push("blinks");
    if (
      k.run.shortStoodIn >= FLAGS.dodgeMin &&
      runShort !== null &&
      runShort >= FLAGS.dodgeEscape
    )
      flags.push("dodges");
    if (k.run.leftMidAttack >= FLAGS.leaves) flags.push("leaves");
    if (
      k.runAim.length >= FLAGS.aimMin &&
      runAimP50 !== null &&
      runAimP50 < FLAGS.aimP50
    )
      flags.push("aim");
    if (
      k.runSkillLate.length >= FLAGS.skillMin &&
      runSkillP90 !== null &&
      runSkillP90 < FLAGS.skillP90Ms
    )
      flags.push("skills");
    return {
      frames: k.frames,
      blinks: k.blinks,
      max_step: r2(k.maxStep) ?? 0,
      dodge: {
        ...counts(k.floor),
        run: counts(k.run),
        react_ms: {
          p25: r0(p25),
          p50: r0(quantile(k.reacts, 0.5)),
          p75: r0(p75),
          spread: r0(spread),
        },
      },
      aim: { ...aimStats(k.aim), run: aimStats(k.runAim) },
      skills: { ...skillStats(k.skillLate), run: skillStats(k.runSkillLate) },
      flags,
    };
  }

  /**
   * Logs what `uid` did (one JSON line, `fairplay` set so it can be picked
   * out of the Worker's logs). With `reset` (a floor done) the next report
   * starts afresh, keeping where it stands, its cooldowns, the attacks
   * still coming and the run's totals. Nothing is logged for a
   * herzie that sent no frames.
   */
  report(
    uid: string,
    context: Record<string, unknown>,
    reset = true,
  ): FairPlayReport | null {
    const k = this.tracks.get(uid);
    if (!k || k.frames === 0) return null;
    const summary = this.summary(uid);
    this.sink(JSON.stringify({ fairplay: 1, uid, ...context, ...summary }));
    if (reset) {
      const next = track();
      next.last = k.last;
      next.readyAt = k.readyAt;
      next.watching = k.watching;
      next.run = k.run;
      next.runAim = k.runAim;
      next.runSkillLate = k.runSkillLate;
      next.jumpUntil = k.jumpUntil;
      this.tracks.set(uid, next);
    }
    return summary;
  }

  /** `uid` is gone for good: drop what's kept of it. */
  forget(uid: string): void {
    this.tracks.delete(uid);
  }
}
