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
 *
 * Memory is bounded (MAX_SAMPLES a list) and reset with each report.
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
/** A skill used more than this long after it was ready isn't timing. */
const SKILL_TIMING_MS = 3_000;
/** Each list keeps at most this many samples between reports. */
const MAX_SAMPLES = 2_000;

/**
 * When a report raises a flag. Provisional: set from one bot and what is
 * known of people in general, not from people playing the Tower — read them
 * as "worth a look", never as proof.
 */
export const FLAGS = {
  /** Any blink. */
  blinks: 1,
  /** From this many short warnings stood in... */
  dodgeMin: 20,
  /** ...getting out of at least this share of them (the fastest
   * person-like model reached 0.94; the bot 0.99-1). */
  dodgeEscape: 0.97,
  /** From this many casts on a target... */
  aimMin: 30,
  /** ...nine in ten this close to its middle (share of its half-width). */
  aimP90: 0.3,
  /** From this many skills used again soon after ready... */
  skillMin: 8,
  /** ...nine in ten within this many ms of it. */
  skillP90Ms: 80,
};

/** A warning stood in: when the herzie was out of it, and the least time
 * (ms) the walk out takes at the fastest a herzie runs. */
type Watch = { tg: Telegraph; outAt: number | null; needMs: number };

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

type Track = {
  last: { t: number; x: number; z: number } | null;
  frames: number;
  blinks: number;
  maxStep: number;
  /** Warnings that appeared over the herzie, until they land. */
  watching: Map<number, Watch>;
  stoodIn: number;
  escaped: number;
  shortStoodIn: number;
  shortEscaped: number;
  /** ms from a warning appearing to the herzie being out of it, less the
   * least the walk out takes: its reaction, plus the round trip. */
  reacts: number[];
  /** Each cast's distance off its target's middle, as a share. */
  aim: number[];
  /** ms after each skill was ready that it was used again. */
  skillLate: number[];
  /** When each skill is next ready. */
  readyAt: Map<string, number>;
};

function track(): Track {
  return {
    last: null,
    frames: 0,
    blinks: 0,
    maxStep: 0,
    watching: new Map(),
    stoodIn: 0,
    escaped: 0,
    shortStoodIn: 0,
    shortEscaped: 0,
    reacts: [],
    aim: [],
    skillLate: [],
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

export type FairPlayReport = {
  frames: number;
  blinks: number;
  max_step: number;
  dodge: {
    stood_in: number;
    escaped: number;
    escape_rate: number | null;
    short_stood_in: number;
    short_escaped: number;
    short_escape_rate: number | null;
    react_ms: {
      p25: number | null;
      p50: number | null;
      p75: number | null;
      spread: number | null;
    };
  };
  aim: { casts: number; p50: number | null; p90: number | null };
  skills: { used: number; p50_ms: number | null; p90_ms: number | null };
  flags: string[];
};

export type FairPlaySink = (line: string) => void;

export class FairPlay {
  private tracks = new Map<string, Track>();

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
      if (step > BLINK_STEP && step / gap > BLINK_SPEED) k.blinks++;
    }
    k.last = { t, x, z };
    for (const w of k.watching.values())
      if (w.outAt === null && !covers(w.tg, x, z)) w.outAt = t;
  }

  /** The herzie was put somewhere by the game (the next floor's start):
   * no step to measure from there. */
  moved(uid: string): void {
    const k = this.tracks.get(uid);
    if (k) k.last = null;
  }

  /** A warning appeared; `at` is where each herzie in the fight stood then
   * (as the server has it). Those it covers are watched until it lands. */
  telegraph(
    tg: Telegraph,
    at: readonly { uid: string; x: number; z: number }[],
  ): void {
    if (tg.kind === "buster" || tg.kind === "scatter") return;
    for (const p of at)
      if (covers(tg, p.x, p.z))
        this.of(p.uid).watching.set(tg.id, {
          tg,
          outAt: null,
          needMs: (edgeDistance(tg, p.x, p.z) / FASTEST) * 1000,
        });
  }

  /** A warning landed on `hit` (whoever it struck; a dome's shelter
   * counts as struck: they didn't get out). */
  resolved(id: number, hit: ReadonlySet<string>): void {
    for (const [uid, k] of this.tracks) {
      const w = k.watching.get(id);
      if (!w) continue;
      k.watching.delete(id);
      const short = w.tg.hitAt - w.tg.at < SHORT_WARNING_MS;
      k.stoodIn++;
      if (short) k.shortStoodIn++;
      if (hit.has(uid)) continue;
      k.escaped++;
      if (short) k.shortEscaped++;
      if (w.outAt !== null) push(k.reacts, w.outAt - w.tg.at - w.needMs);
    }
  }

  /** A cast that found a target, `off` radians to the side of the target's
   * middle, which looks `half` radians wide either side from there. */
  aimed(uid: string, off: number, half: number): void {
    if (!(half > 0)) return;
    push(this.of(uid).aim, Math.abs(off) / half);
  }

  /** A skill used at `now`, next ready at `readyAt`. */
  skill(uid: string, skill: string, now: number, readyAt: number): void {
    const k = this.of(uid);
    const was = k.readyAt.get(skill);
    if (was !== undefined && now >= was && now - was <= SKILL_TIMING_MS)
      push(k.skillLate, now - was);
    k.readyAt.set(skill, readyAt);
  }

  /** What `uid` did since the last report, with any flags raised. */
  summary(uid: string): FairPlayReport {
    const k = this.of(uid);
    const p25 = quantile(k.reacts, 0.25);
    const p75 = quantile(k.reacts, 0.75);
    const spread = p25 !== null && p75 !== null ? p75 - p25 : null;
    const escapeRate = k.stoodIn ? k.escaped / k.stoodIn : null;
    const shortRate = k.shortStoodIn ? k.shortEscaped / k.shortStoodIn : null;
    const aimP90 = quantile(k.aim, 0.9);
    const skillP90 = quantile(k.skillLate, 0.9);
    const flags: string[] = [];
    if (k.blinks >= FLAGS.blinks) flags.push("blinks");
    if (
      k.shortStoodIn >= FLAGS.dodgeMin &&
      shortRate !== null &&
      shortRate >= FLAGS.dodgeEscape
    )
      flags.push("dodges");
    if (
      k.aim.length >= FLAGS.aimMin &&
      aimP90 !== null &&
      aimP90 < FLAGS.aimP90
    )
      flags.push("aim");
    if (
      k.skillLate.length >= FLAGS.skillMin &&
      skillP90 !== null &&
      skillP90 < FLAGS.skillP90Ms
    )
      flags.push("skills");
    return {
      frames: k.frames,
      blinks: k.blinks,
      max_step: r2(k.maxStep) ?? 0,
      dodge: {
        stood_in: k.stoodIn,
        escaped: k.escaped,
        escape_rate: r2(escapeRate),
        short_stood_in: k.shortStoodIn,
        short_escaped: k.shortEscaped,
        short_escape_rate: r2(shortRate),
        react_ms: {
          p25: r0(p25),
          p50: r0(quantile(k.reacts, 0.5)),
          p75: r0(p75),
          spread: r0(spread),
        },
      },
      aim: {
        casts: k.aim.length,
        p50: r2(quantile(k.aim, 0.5)),
        p90: r2(aimP90),
      },
      skills: {
        used: k.skillLate.length,
        p50_ms: r0(quantile(k.skillLate, 0.5)),
        p90_ms: r0(skillP90),
      },
      flags,
    };
  }

  /**
   * Logs what `uid` did since the last report (one JSON line, `fairplay`
   * set so it can be picked out of the Worker's logs) and starts over,
   * keeping only where it stands and when its skills are ready. Nothing is
   * logged for a herzie that sent no frames.
   */
  report(uid: string, context: Record<string, unknown>): FairPlayReport | null {
    const k = this.tracks.get(uid);
    if (!k || k.frames === 0) return null;
    const summary = this.summary(uid);
    this.sink(JSON.stringify({ fairplay: 1, uid, ...context, ...summary }));
    const next = track();
    next.last = k.last;
    next.readyAt = k.readyAt;
    next.watching = k.watching;
    this.tracks.set(uid, next);
    return summary;
  }

  /** `uid` is gone: drop what's kept of it. */
  forget(uid: string): void {
    this.tracks.delete(uid);
  }
}
