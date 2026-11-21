import { bellStrikeAt } from "./airship/bell";

/**
 * The Town's sound effects, made on the spot with WebAudio — no files: a
 * whoosh as a wave leaves the hand, a "bwomp" where it lands, a chime on a
 * crit, the rush of a portal. Each one wanders a little in pitch, so a
 * hundred casts don't sound like one sample on repeat.
 *
 * Quiet by design: the music the herzie listens to is the point, these sit
 * under it. Muted with `setSfxMuted` (remembered).
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;

const MUTE_KEY = "town.sfx.muted";
/** Off until the player turns it on (remembered once they do). */
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) !== "0";
  } catch {
    return true;
  }
})();

export function sfxMuted(): boolean {
  return muted;
}

export function setSfxMuted(on: boolean): void {
  muted = on;
  try {
    localStorage.setItem(MUTE_KEY, on ? "1" : "0");
  } catch {
    // Not remembered, then.
  }
  if (master) master.gain.value = on ? 0 : VOLUME;
}

const VOLUME = 0.35;

/** The audio graph, made on first use (after a key or click, so the
 * browser lets it play). */
function audio(): {
  ctx: AudioContext;
  out: GainNode;
  noise: AudioBuffer;
} | null {
  if (muted) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = VOLUME;
      // A gentle limiter, so a burst of hits never clips.
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -10;
      limit.ratio.value = 8;
      master.connect(limit).connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") void ctx.resume();
    return { ctx, out: master as GainNode, noise: noise as AudioBuffer };
  } catch {
    return null;
  }
}

const wobble = (amount = 0.05) => 1 + (Math.random() * 2 - 1) * amount;

/** A decaying envelope on a fresh gain node into `out`. */
function envelope(
  c: AudioContext,
  out: AudioNode,
  peak: number,
  attack: number,
  decay: number,
): GainNode {
  const g = c.createGain();
  const t = c.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

function noiseBurst(
  a: NonNullable<ReturnType<typeof audio>>,
  filter: BiquadFilterType,
  from: number,
  to: number,
  q: number,
  peak: number,
  seconds: number,
) {
  const { ctx: c, out } = a;
  const src = c.createBufferSource();
  src.buffer = a.noise;
  src.playbackRate.value = wobble(0.2);
  const f = c.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  const t = c.currentTime;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + seconds);
  src.connect(f).connect(envelope(c, out, peak, 0.01, seconds));
  src.start(t, Math.random() * 0.5);
  src.stop(t + seconds + 0.05);
}

function tone(
  a: NonNullable<ReturnType<typeof audio>>,
  type: OscillatorType,
  from: number,
  to: number,
  peak: number,
  attack: number,
  seconds: number,
  delay = 0,
) {
  const { ctx: c, out } = a;
  const o = c.createOscillator();
  o.type = type;
  const t = c.currentTime + delay;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + seconds);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + seconds);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + attack + seconds + 0.05);
}

/** The hand drawing back: a soft rising breath. */
export function sfxCharge(): void {
  const a = audio();
  if (!a) return;
  noiseBurst(a, "bandpass", 500 * wobble(), 1400 * wobble(), 3, 0.08, 0.12);
}

/** A wave leaving the hand: a filtered whoosh over a low push. */
export function sfxCast(): void {
  const a = audio();
  if (!a) return;
  const k = wobble();
  noiseBurst(a, "bandpass", 2400 * k, 600 * k, 1.6, 0.35, 0.22);
  tone(a, "sine", 150 * k, 70 * k, 0.4, 0.005, 0.14);
  // A shimmer on top: the "sonic" in it.
  tone(a, "triangle", 880 * k, 1320 * k, 0.05, 0.01, 0.12);
}

/** A wave striking: a low "bwomp" and a thud — and a bright chime on a
 * crit. A wave fizzling out against the world is just a puff. */
export function sfxImpact(kind: "hit" | "crit" | "fizzle"): void {
  const a = audio();
  if (!a) return;
  const k = wobble();
  if (kind === "fizzle") {
    noiseBurst(a, "lowpass", 1800 * k, 300, 0.7, 0.12, 0.18);
    return;
  }
  tone(a, "sine", 120 * k, 42 * k, 0.75, 0.004, 0.26);
  noiseBurst(a, "highpass", 3000 * k, 900, 0.8, 0.22, 0.06);
  noiseBurst(a, "lowpass", 900 * k, 200, 1, 0.25, 0.16);
  if (kind === "crit") {
    tone(a, "triangle", 1318 * k, 1318 * k, 0.12, 0.004, 0.45, 0.01);
    tone(a, "triangle", 1975 * k, 1975 * k, 0.08, 0.004, 0.5, 0.05);
    tone(a, "sine", 60 * k, 30 * k, 0.6, 0.004, 0.35);
  }
}

/** A disc flicked from the hand: a quick airy zip, rising, with a faint
 * whirr of its spin. The off hand's is a little lower. */
export function sfxDiscThrow(main: boolean): void {
  const a = audio();
  if (!a) return;
  const k = wobble() * (main ? 1 : 0.89);
  noiseBurst(a, "bandpass", 900 * k, 3600 * k, 2.2, 0.22, 0.13);
  tone(a, "triangle", 520 * k, 780 * k, 0.04, 0.005, 0.16);
}

/** A disc turning at the end of its flight, far off: a tiny tick. */
export function sfxDiscTurn(): void {
  const a = audio();
  if (!a) return;
  tone(a, "sine", 2637 * wobble(0.03), 2637, 0.025, 0.002, 0.08);
}

/** A disc glancing off a wall: a small bright clink. */
export function sfxDiscClink(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.04);
  tone(a, "triangle", 2093 * k, 1975 * k, 0.08, 0.002, 0.14);
  noiseBurst(a, "highpass", 5000 * k, 3000, 0.8, 0.1, 0.04);
}

/** A disc back in the hand: a crisp click, a semitone apart between the
 * hands, so throwing both makes a little rhythm of it. */
export function sfxDiscCatch(main: boolean): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.015) * (main ? 1 : 0.944);
  noiseBurst(a, "highpass", 4200 * k, 2400 * k, 1.2, 0.18, 0.03);
  tone(a, "triangle", 1568 * k, 1480 * k, 0.07, 0.002, 0.09);
  tone(a, "sine", 220 * k, 140 * k, 0.12, 0.002, 0.06);
}

/** A melee swing on its way: a stick's swish through the air, or a body
 * bump's soft "hup" as it hops. */
export function sfxSwing(style: "strike" | "punch" | "bump"): void {
  const a = audio();
  if (!a) return;
  const k = wobble();
  if (style === "strike") {
    noiseBurst(a, "bandpass", 3200 * k, 900 * k, 2.4, 0.2, 0.1);
    return;
  }
  if (style === "punch") {
    // A quick jab's whoosh: shorter and higher than a stick's.
    noiseBurst(a, "bandpass", 2400 * k, 1100 * k, 1.8, 0.12, 0.06);
    return;
  }
  tone(a, "sine", 180 * k, 260 * k, 0.18, 0.01, 0.08);
  noiseBurst(a, "lowpass", 700 * k, 300, 0.8, 0.08, 0.08);
}

/** A melee blow landing, under sfxImpact's thud: the stick's woody tock,
 * a punch's soft thwack, or a body bump's squashy bonk. */
export function sfxMeleeHit(style: "strike" | "punch" | "bump"): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.04);
  if (style === "strike") {
    tone(a, "triangle", 740 * k, 520 * k, 0.16, 0.002, 0.07);
    noiseBurst(a, "bandpass", 2000 * k, 1200 * k, 3, 0.18, 0.04);
    return;
  }
  if (style === "punch") {
    tone(a, "sine", 340 * k, 140 * k, 0.28, 0.002, 0.07);
    noiseBurst(a, "lowpass", 1400 * k, 500, 1.2, 0.14, 0.04);
    return;
  }
  tone(a, "sine", 260 * k, 90 * k, 0.35, 0.003, 0.12);
}

/** Stepping through a portal: a long rising rush. */
export function sfxPortal(): void {
  const a = audio();
  if (!a) return;
  noiseBurst(a, "bandpass", 200, 3200, 2, 0.35, 0.8);
  tone(a, "sine", 110, 440, 0.2, 0.2, 0.7);
}

/** Going in through a heavy door: a creak as it swings, then the thump of
 * it shutting behind you. */
export function sfxDoor(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.05);
  tone(a, "sawtooth", 150 * k, 210 * k, 0.035, 0.08, 0.35);
  tone(a, "sine", 95 * k, 50 * k, 0.45, 0.004, 0.25, 0.42);
  noiseBurst(a, "lowpass", 700 * k, 140, 1, 0.12, 0.12);
}

/** An attack is coming: a rising tone for as long as the shape fills, so
 * it can be heard as well as seen. `seconds` is the windup. */
export function sfxWarn(seconds: number): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.04);
  tone(
    a,
    "sawtooth",
    140 * k,
    420 * k,
    0.07,
    Math.min(0.4, seconds / 2),
    seconds,
  );
  tone(a, "sine", 70 * k, 110 * k, 0.18, 0.1, seconds);
}

/** The boss's attack landing: a deep slam. */
export function sfxSlam(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.05);
  tone(a, "sine", 95 * k, 28 * k, 0.9, 0.004, 0.5);
  noiseBurst(a, "lowpass", 1400 * k, 120, 1.2, 0.45, 0.12);
}

/** Getting hit: a short, low crunch. */
export function sfxHurt(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.06);
  tone(a, "square", 220 * k, 70 * k, 0.22, 0.003, 0.18);
  noiseBurst(a, "bandpass", 900 * k, 200, 1.4, 0.2, 0.1);
}

/** Knocked out: a falling tone. */
export function sfxDown(): void {
  const a = audio();
  if (!a) return;
  tone(a, "triangle", 440, 55, 0.3, 0.01, 0.9);
}

// --- The raid's moments -----------------------------------------------------

/** The boss roars: waking, or a new phase. A low growl under a rush. */
export function sfxRoar(big = false): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.04);
  const len = big ? 1.3 : 0.9;
  tone(a, "sawtooth", 92 * k, 46 * k, big ? 0.32 : 0.24, 0.08, len);
  tone(a, "square", 61 * k, 38 * k, 0.12, 0.1, len);
  noiseBurst(a, "lowpass", 900, 160, 0.9, big ? 0.4 : 0.28, len);
}

/** The lobby's last seconds: a tick, brighter on the last. */
export function sfxCountdown(last: boolean): void {
  const a = audio();
  if (!a) return;
  tone(a, "triangle", last ? 1320 : 880, last ? 1320 : 860, 0.16, 0.004, 0.12);
}

/** The fight is on: the roar, and a crash over it. */
export function sfxFight(): void {
  const a = audio();
  if (!a) return;
  sfxRoar(true);
  noiseBurst(a, "highpass", 5000, 2500, 0.7, 0.22, 0.9);
}

/** It calls its minions: an eerie rising call. */
export function sfxSummon(): void {
  const a = audio();
  if (!a) return;
  tone(a, "triangle", 220, 660, 0.12, 0.05, 0.7);
  tone(a, "triangle", 233, 698, 0.08, 0.05, 0.7, 0.04);
  noiseBurst(a, "bandpass", 400, 1800, 3, 0.12, 0.6);
}

/** The enrage: a two-note alarm, twice. */
export function sfxEnrage(hard = false): void {
  const a = audio();
  if (!a) return;
  const lo = hard ? 196 : 247;
  for (let i = 0; i < 2; i++) {
    tone(a, "square", lo * 2, lo * 2, 0.08, 0.01, 0.16, i * 0.4);
    tone(a, "square", lo * 1.5, lo * 1.5, 0.08, 0.01, 0.16, i * 0.4 + 0.2);
  }
  if (hard) sfxRoar(true);
}

/** Everyone's down: a slow falling minor pair. */
export function sfxWipe(): void {
  const a = audio();
  if (!a) return;
  tone(a, "triangle", 330, 110, 0.2, 0.05, 1.8);
  tone(a, "sine", 196, 65, 0.2, 0.05, 2.0, 0.15);
}

/** A Cymbrella going up: a deep cymbal swell, a shimmer rising over it as
 * the dome grows, and a low hum that holds. */
export function sfxDomeUp(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.02);
  tone(a, "sine", 98 * k, 110 * k, 0.32, 0.02, 1.1);
  tone(a, "triangle", 196 * k, 220 * k, 0.12, 0.03, 0.8);
  // The shimmer: bright noise swelling and rising with the growth.
  noiseBurst(a, "bandpass", 2600 * k, 7800 * k, 4, 0.16, 0.45);
  for (const [f, at] of [
    [880, 0.04],
    [1320, 0.12],
    [1760, 0.22],
  ] as const)
    tone(a, "sine", f * k, f * k * 1.01, 0.05, 0.01, 0.5, at);
}

/** A hit turned away by a dome: a bright metallic clang with a ring. */
export function sfxDomeBlock(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.05);
  noiseBurst(a, "highpass", 5200 * k, 2400 * k, 1.5, 0.2, 0.08);
  tone(a, "square", 1180 * k, 1120 * k, 0.05, 0.002, 0.25);
  tone(a, "sine", 2370 * k, 2330 * k, 0.08, 0.002, 0.5);
}

/** A Rimshot landing: the stick cracking off a drum's rim, sharp and dry,
 * with the drum's body thumping under it. */
export function sfxRimshot(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.04);
  noiseBurst(a, "highpass", 6200 * k, 2600 * k, 0.9, 0.38, 0.05);
  tone(a, "triangle", 1650 * k, 1100 * k, 0.22, 0.001, 0.05);
  tone(a, "sine", 210 * k, 110 * k, 0.4, 0.002, 0.14);
}

/** A Rimshot's wind-up: a snare roll that speeds up and swells over
 * `seconds`, with a low tension rising under it, timed to land on the
 * slam. Stop it (the wind-up cut short) and it falls silent at once. */
export function sfxRimshotWindup(seconds: number): { stop(): void } {
  const a = audio();
  if (!a) return { stop() {} };
  const { ctx: c } = a;
  // Its own bus, so it can be cut.
  const bus = c.createGain();
  bus.gain.value = 1;
  bus.connect(a.out);
  const sub = { ...a, out: bus as AudioNode as GainNode };
  const k = wobble(0.02);
  // Strokes closing in on each other, louder as they go.
  let at = 0;
  let gap = 0.11;
  while (at < seconds - 0.03) {
    const u = at / seconds;
    const src = c.createBufferSource();
    src.buffer = a.noise;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = (2600 + 1400 * u) * k;
    f.Q.value = 1.4;
    const g = c.createGain();
    const t = c.currentTime + at;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05 + 0.2 * u * u, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(f).connect(g).connect(bus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.07);
    at += gap;
    gap = Math.max(0.028, gap * 0.86);
  }
  // The tension: a low tone climbing to the slam.
  tone(sub, "triangle", 70 * k, 130 * k, 0.12, seconds * 0.6, seconds * 0.4);
  return {
    stop() {
      const t = c.currentTime;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setValueAtTime(bus.gain.value, t);
      bus.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      setTimeout(() => bus.disconnect(), 120);
    },
  };
}

/** A Rimshot's slam: a sub boom you feel more than hear, the rim's crack
 * on top, and the rattle of the ground breaking up. */
export function sfxRimshotSlam(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.04);
  tone(a, "sine", 110 * k, 38, 0.75, 0.004, 0.55);
  tone(a, "triangle", 220 * k, 70, 0.22, 0.003, 0.25);
  noiseBurst(a, "highpass", 6400 * k, 2800 * k, 0.9, 0.42, 0.05);
  tone(a, "triangle", 1700 * k, 1150 * k, 0.2, 0.001, 0.06);
  noiseBurst(a, "lowpass", 1800 * k, 300, 0.7, 0.32, 0.35);
  // Debris: a scatter of small ticks.
  for (let i = 0; i < 7; i++)
    tone(
      a,
      "square",
      (900 + Math.random() * 900) * k,
      500,
      0.025,
      0.001,
      0.03,
      0.06 + i * 0.035 + Math.random() * 0.02,
    );
}

/** A stun taking: a dizzy wobble of little bells, round and round. */
export function sfxStun(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.03);
  const notes = [1568, 1319, 1568, 1319, 1175];
  for (let i = 0; i < notes.length; i++)
    tone(
      a,
      "sine",
      notes[i] * k,
      notes[i] * k * 0.98,
      0.07,
      0.004,
      0.16,
      i * 0.07,
    );
}

/** A taunt: a struck gong. */
export function sfxTaunt(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.03);
  tone(a, "sine", 150 * k, 140 * k, 0.4, 0.004, 1.4);
  tone(a, "sine", 377 * k, 360 * k, 0.12, 0.004, 0.9);
  noiseBurst(a, "bandpass", 1200, 500, 2.5, 0.18, 0.4);
}

/** Haste: a quick run of rising ticks, a metronome speeding up, and a
 * bright strum on top. */
export function sfxHaste(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.02);
  // Ticks closing in on each other: tick... tick.. tick. tick tick.
  let at = 0;
  for (let i = 0; i < 6; i++) {
    tone(a, "square", 1400 * k, 1300 * k, 0.05, 0.001, 0.03, at);
    at += 0.12 * 0.72 ** i;
  }
  const chord = [523, 659, 784, 1047];
  for (let i = 0; i < chord.length; i++)
    tone(
      a,
      "triangle",
      chord[i] * k,
      chord[i] * k,
      0.09,
      0.005,
      0.45,
      at + i * 0.02,
    );
}

/** The lute switching stance: a soft pluck, up to heal, down to attack. */
export function sfxStance(heal: boolean): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.02);
  const [from, to] = heal ? [440, 660] : [660, 440];
  tone(a, "triangle", from * k, to * k, 0.09, 0.004, 0.18);
}

/** A heal bolt sent: a warm, quick chime (a wave's charge is harsher). */
export function sfxHealBolt(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.03);
  tone(a, "sine", 880 * k, 1175 * k, 0.07, 0.004, 0.16);
  tone(a, "triangle", 1320 * k, 1320 * k, 0.03, 0.01, 0.12, 0.03);
}

/** A heal bolt with nobody to go to: a dull, short "no". */
export function sfxNoTarget(): void {
  const a = audio();
  if (!a) return;
  tone(a, "square", 220, 180, 0.05, 0.002, 0.08);
}

/** A resurrect being played: a soft rising chime. */
export function sfxChannel(): void {
  const a = audio();
  if (!a) return;
  const notes = [523, 659, 784];
  for (let i = 0; i < notes.length; i++)
    tone(a, "sine", notes[i], notes[i], 0.08, 0.05, 0.6, i * 0.25);
}

/** Back on its feet: a bright chord. */
export function sfxRevive(): void {
  const a = audio();
  if (!a) return;
  const notes = [784, 988, 1175, 1568];
  for (let i = 0; i < notes.length; i++)
    tone(a, "triangle", notes[i], notes[i], 0.1, 0.01, 0.5, i * 0.05);
}

// --- Loot ------------------------------------------------------------------

/** How grand a drop sounds, 0 (common) to 4 (mythic). */
export type LootTier = 0 | 1 | 2 | 3 | 4;

/** A major pentatonic run from C6, so pickups in a row climb a scale. */
const LADDER = [1047, 1175, 1319, 1568, 1760, 2093, 2349, 2637];

/** The stone boss bursting: a crack, a deep boom, a shower of grit. */
export function sfxLootBurst(): void {
  const a = audio();
  if (!a) return;
  noiseBurst(a, "highpass", 5000, 1400, 0.9, 0.35, 0.09);
  tone(a, "sine", 80, 30, 0.9, 0.004, 0.7);
  noiseBurst(a, "lowpass", 2400, 200, 0.8, 0.3, 0.6);
}

/** A drop landing: a clink, and above uncommon a chord that grows with
 * the rarity — the sound tells you what fell before you look. */
export function sfxLootLand(tier: LootTier): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.03);
  tone(a, "triangle", 1568 * k, 1568 * k, 0.12, 0.002, 0.18);
  noiseBurst(a, "highpass", 6000 * k, 3000, 1, 0.08, 0.05);
  const chord = [523, 659, 784, 1047, 1319].slice(0, tier + 1);
  if (tier < 2) return;
  for (const [i, f] of chord.entries())
    tone(
      a,
      "sine",
      f * k,
      f * k,
      0.06 + tier * 0.015,
      0.01,
      0.9 + tier * 0.25,
      0.06 * i,
    );
}

/** Rare and up hum while they lie there, so they can be found by ear.
 * `level` (0..1) is how close you are. */
export function sfxLootHum(tier: LootTier): {
  level: (v: number) => void;
  stop: () => void;
} | null {
  if (tier < 2) return null;
  const a = audio();
  if (!a) return null;
  const { ctx: c, out } = a;
  const g = c.createGain();
  g.gain.value = 0;
  g.connect(out);
  const base = [220, 247, 262, 294, 330][tier];
  const oscs = [base, base * 1.5, base * 2.004].map((f, i) => {
    const o = c.createOscillator();
    o.type = i === 0 ? "sine" : "triangle";
    o.frequency.value = f;
    const og = c.createGain();
    og.gain.value = i === 0 ? 1 : 0.25;
    o.connect(og).connect(g);
    o.start();
    return o;
  });
  // A slow swell, so it breathes rather than drones.
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.35;
  const depth = c.createGain();
  depth.gain.value = 0.25;
  const swell = c.createGain();
  swell.gain.value = 0.75;
  lfo.connect(depth).connect(swell.gain);
  g.disconnect();
  g.connect(swell).connect(out);
  lfo.start();
  const peak = 0.02 + tier * 0.008;
  return {
    level: (v) => g.gain.setTargetAtTime(peak * v, c.currentTime, 0.15),
    stop: () => {
      const t = c.currentTime;
      g.gain.setTargetAtTime(0, t, 0.08);
      for (const o of [...oscs, lfo]) o.stop(t + 0.5);
    },
  };
}

/** Picking one up: a bright chime that climbs with each pickup in a row,
 * and a little sparkle on top for the rare ones. */
export function sfxLootPickup(step: number, tier: LootTier): void {
  const a = audio();
  if (!a) return;
  const f = LADDER[Math.min(step, LADDER.length - 1)];
  tone(a, "triangle", f, f, 0.16, 0.003, 0.35);
  tone(a, "sine", f * 2, f * 2, 0.05, 0.003, 0.25, 0.04);
  if (tier >= 2) {
    tone(a, "triangle", f * 1.5, f * 1.5, 0.07, 0.003, 0.5, 0.09);
    tone(a, "sine", f * 3, f * 3, 0.03, 0.003, 0.6, 0.14);
  }
}

/** The spirit noticing something: a quick upward chirp. */
export function sfxSpiritNotice(): void {
  const a = audio();
  if (!a) return;
  tone(a, "sine", 880, 1760, 0.08, 0.005, 0.12);
  tone(a, "sine", 1320, 2200, 0.05, 0.005, 0.1, 0.07);
}

// --- Home's drops: a hole opening in the air -----------------------------------
// Soft, all of them: there's music playing, and these come every few
// minutes while it does.

/** The hole opening: a low, soft "whomp" of air pulled in. */
export function sfxRiftOpen(): void {
  const a = audio();
  if (!a) return;
  tone(a, "sine", 140, 52, 0.22, 0.03, 0.45);
  noiseBurst(a, "lowpass", 260, 900, 0.7, 0.07, 0.4);
}

/**
 * The hole at work, "deciding": a hum that rises and quickens for
 * `seconds`, a little brighter for the rarer things. Returns a stop, for a
 * hole that closes early.
 */
export function sfxRiftWork(
  seconds: number,
  tier: LootTier,
): { stop: () => void } | null {
  const a = audio();
  if (!a) return null;
  const { ctx: c, out } = a;
  const t = c.currentTime;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05 + tier * 0.01, t + seconds * 0.8);
  g.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 0.08);
  // A wobble that quickens, as if it's working something out.
  const trem = c.createGain();
  trem.gain.value = 0.6;
  const lfo = c.createOscillator();
  lfo.frequency.setValueAtTime(5, t);
  lfo.frequency.exponentialRampToValueAtTime(15, t + seconds);
  const depth = c.createGain();
  depth.gain.value = 0.4;
  lfo.connect(depth).connect(trem.gain);
  g.connect(trem).connect(out);
  const base = 110 * wobble(0.03);
  const oscs = [base, base * 1.5 * 1.003].map((f, i) => {
    const o = c.createOscillator();
    o.type = i === 0 ? "sine" : "triangle";
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(
      f * (2 + tier * 0.12),
      t + seconds,
    );
    o.connect(g);
    o.start(t);
    o.stop(t + seconds + 0.15);
    return o;
  });
  lfo.start(t);
  lfo.stop(t + seconds + 0.15);
  return {
    stop: () => {
      const now = c.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setTargetAtTime(0.0001, now, 0.04);
      for (const o of [...oscs, lfo]) o.stop(now + 0.2);
    },
  };
}

/** The hole letting go of what it found: a soft pop. */
export function sfxRiftEject(tier: LootTier): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.04);
  tone(a, "sine", 420 * k, 900 * k, 0.12, 0.004, 0.12);
  noiseBurst(a, "bandpass", 2400, 900, 1.2, 0.05, 0.08);
  if (tier >= 3)
    tone(a, "triangle", 1320 * k, 1320 * k, 0.05, 0.004, 0.4, 0.05);
}

/** The hole closing up into a point: a quick indrawn breath. */
export function sfxRiftClose(): void {
  const a = audio();
  if (!a) return;
  noiseBurst(a, "bandpass", 1400, 220, 1.4, 0.06, 0.22);
  tone(a, "sine", 320, 90, 0.07, 0.01, 0.2);
}

// --- The Crystal -------------------------------------------------------------

/** Attuning: light gathering in the crystal, a soft glassy rise. */
export function sfxCrystalCharge(): void {
  const a = audio();
  if (!a) return;
  tone(a, "sine", 330, 990, 0.08, 0.15, 0.7);
  tone(a, "triangle", 660, 1980, 0.03, 0.2, 0.65, 0.05);
  noiseBurst(a, "bandpass", 1200, 5200, 4, 0.05, 0.7);
}

/** The Crystal giving up what it held: a bright glassy chord over a soft
 * swell. */
export function sfxCrystalBurst(): void {
  const a = audio();
  if (!a) return;
  tone(a, "sine", 110, 55, 0.22, 0.01, 0.6);
  noiseBurst(a, "highpass", 7000, 2500, 0.8, 0.12, 0.35);
  for (const [i, f] of [784, 988, 1175, 1568, 1976].entries())
    tone(a, "triangle", f, f, 0.07, 0.005, 1.4, 0.03 * i);
}

/** A level gained during the payout: two quick rising notes. */
export function sfxCrystalLevel(): void {
  const a = audio();
  if (!a) return;
  tone(a, "triangle", 1047, 1047, 0.1, 0.004, 0.25);
  tone(a, "triangle", 1568, 1568, 0.1, 0.004, 0.4, 0.09);
  tone(a, "sine", 3136, 3136, 0.03, 0.004, 0.5, 0.12);
}

/** The Crystal poked in its window: a small glassy plink. */
export function sfxCrystalBoop(): void {
  const a = audio();
  if (!a) return;
  const f = 1320 + Math.random() * 220;
  tone(a, "triangle", f, f * 1.5, 0.06, 0.003, 0.18);
  tone(a, "sine", f * 2, f * 2, 0.025, 0.003, 0.3, 0.05);
}

/** The XP counting up: a faint tick, pitched up as it goes (0..1). */
export function sfxCrystalTick(progress: number): void {
  const a = audio();
  if (!a) return;
  const f = 1200 + progress * 1400;
  tone(a, "sine", f, f, 0.025, 0.002, 0.05);
}

// --- Titles and loadouts -----------------------------------------------------

/** A title earned: a bright two-note chime; `big` (legendary, mythic) a
 * rising arpeggio over a soft swell. */
export function sfxTitle(big: boolean): void {
  const a = audio();
  if (!a) return;
  if (!big) {
    tone(a, "triangle", 880, 880, 0.08, 0.004, 0.3);
    tone(a, "triangle", 1319, 1319, 0.08, 0.004, 0.5, 0.1);
    return;
  }
  tone(a, "sine", 220, 110, 0.12, 0.02, 0.7);
  noiseBurst(a, "highpass", 6000, 2500, 0.8, 0.06, 0.5);
  for (const [i, f] of [659, 880, 1109, 1319, 1760].entries())
    tone(a, "triangle", f, f, 0.07, 0.005, 0.9, 0.07 * i);
}

// --- Duels -----------------------------------------------------------------

/** Someone challenges you: a bright call, up a fourth, with a shimmer. */
export function sfxDuelChallenge(): void {
  const a = audio();
  if (!a) return;
  tone(a, "triangle", 784, 784, 0.09, 0.004, 0.22);
  tone(a, "triangle", 1047, 1047, 0.1, 0.004, 0.45, 0.12);
  noiseBurst(a, "highpass", 7000, 4000, 0.7, 0.03, 0.3);
}

/** The ring's centre landing: a low thump and a puff. */
export function sfxDuelThump(): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.03);
  tone(a, "sine", 110 * k, 40 * k, 0.55, 0.003, 0.28);
  noiseBurst(a, "lowpass", 700 * k, 150, 0.8, 0.18, 0.14);
}

/** "3", "2", "1": a tick a semitone higher each time (`step` 0, 1, 2). */
export function sfxDuelTick(step: number): void {
  const a = audio();
  if (!a) return;
  const f = 740 * 2 ** (step / 12);
  tone(a, "triangle", f, f, 0.15, 0.003, 0.14);
  tone(a, "sine", f / 2, f / 2, 0.08, 0.003, 0.1);
}

/** "FIGHT!": a drum hit under a short brass stab. */
export function sfxDuelFight(): void {
  const a = audio();
  if (!a) return;
  tone(a, "sine", 130, 45, 0.8, 0.003, 0.32);
  noiseBurst(a, "lowpass", 1600, 220, 1, 0.35, 0.16);
  for (const f of [349, 440, 523])
    tone(a, "sawtooth", f, f * 1.01, 0.06, 0.012, 0.32, 0.01);
  noiseBurst(a, "highpass", 5200, 2600, 0.7, 0.12, 0.45);
}

/** Your duel hit confirmed: a woody "thock" over more bass; a crit adds
 * the same knock five semitones up. */
export function sfxDuelThock(crit: boolean): void {
  const a = audio();
  if (!a) return;
  const k = wobble(0.03);
  tone(a, "triangle", 560 * k, 300 * k, 0.2, 0.002, 0.08);
  tone(a, "sine", 140 * k, 55 * k, 0.5, 0.003, 0.16);
  noiseBurst(a, "bandpass", 1800 * k, 900 * k, 2.5, 0.16, 0.05);
  if (crit) {
    const up = 2 ** (5 / 12);
    tone(a, "triangle", 560 * k * up, 300 * k * up, 0.14, 0.002, 0.1, 0.02);
    tone(a, "sine", 1760 * k, 1700 * k, 0.05, 0.003, 0.3, 0.03);
  }
}

/** A hit blocked by a dome: a dull clank. */
export function sfxDuelBlocked(): void {
  const a = audio();
  if (!a) return;
  tone(a, "square", 330, 300, 0.05, 0.002, 0.08);
  noiseBurst(a, "bandpass", 2400, 1600, 4, 0.08, 0.08);
}

/** The winning blow: a deep boom with a bright crack over it. */
export function sfxDuelFinish(): void {
  const a = audio();
  if (!a) return;
  tone(a, "sine", 90, 28, 0.9, 0.003, 0.7);
  noiseBurst(a, "highpass", 6000, 1800, 0.8, 0.25, 0.4);
  tone(a, "triangle", 1568, 1480, 0.08, 0.003, 0.6, 0.02);
}

/** Won a duel: a rising fanfare, landing on a held chord (about 1.5 s). */
export function sfxDuelVictory(): void {
  const a = audio();
  if (!a) return;
  const run = [523, 659, 784];
  for (const [i, f] of run.entries())
    tone(a, "triangle", f, f, 0.1, 0.005, 0.18, i * 0.13);
  for (const f of [523, 659, 784, 1047])
    tone(a, "triangle", f, f, 0.08, 0.01, 1.1, 0.42);
  tone(a, "sine", 131, 131, 0.14, 0.02, 1.1, 0.42);
  noiseBurst(a, "highpass", 6500, 3500, 0.7, 0.05, 0.8);
}

/** Lost a duel: two soft notes, falling. */
export function sfxDuelDefeat(): void {
  const a = audio();
  if (!a) return;
  tone(a, "sine", 523, 523, 0.09, 0.02, 0.4);
  tone(a, "sine", 392, 388, 0.09, 0.02, 0.7, 0.38);
}

/** Outside the ring: a low tick each second. */
export function sfxDuelOut(): void {
  const a = audio();
  if (!a) return;
  tone(a, "square", 196, 190, 0.07, 0.002, 0.09);
  tone(a, "sine", 98, 96, 0.12, 0.002, 0.12);
}

// --- The sky ship ------------------------------------------------------------
// Blåmann, to the Wilds: a bell and a horn to say she's going (heard
// from the dock as well as on board), the hull creaking and bumping, and
// the ride itself — the engines' hum and the wind — while you're aboard.
// Each takes a `volume` (0–1, how near it is, say), on top of the rest.

type Audio = NonNullable<ReturnType<typeof audio>>;

/** `a`, through a gain of its own at `volume`: let go after `seconds`. */
function atVolume(a: Audio, volume: number, seconds: number): Audio {
  const bus = a.ctx.createGain();
  bus.gain.value = Math.max(0, volume);
  bus.connect(a.out);
  setTimeout(() => bus.disconnect(), (seconds + 0.5) * 1000);
  return { ...a, out: bus };
}

/** A small bronze bell's partials: [× the strike note, loudness, how
 * long it rings (s)] — the hum under it, the strike note, the minor
 * third that makes it a bell, and the shimmer over it. */
const BELL_PARTIALS: [number, number, number][] = [
  [0.5, 0.05, 2.6],
  [1, 0.12, 1.9],
  [1.19, 0.06, 1.3],
  [1.5, 0.035, 1],
  [2, 0.06, 1.1],
  [2.52, 0.025, 0.6],
  [3.01, 0.015, 0.4],
];

/** The ship's bell, `strikes` times, in pairs as a ship's bell is rung:
 * ding-ding, ding-ding — on the strikes the bells you see swing to
 * (airship/bell.ts). */
export function sfxShipBell(strikes = 1, volume = 1): void {
  const a0 = audio();
  if (!a0) return;
  const n = Math.max(1, Math.round(strikes));
  const a = atVolume(a0, volume, bellStrikeAt(n) + 3);
  const f = 740 * wobble(0.01);
  for (let i = 0; i < n; i++) {
    const t = bellStrikeAt(i);
    for (const [ratio, peak, ring] of BELL_PARTIALS)
      tone(a, "sine", f * ratio, f * ratio * 0.998, peak, 0.002, ring, t);
    // The clapper's tick.
    tone(a, "triangle", f * 4.2, f * 3.9, 0.025, 0.001, 0.04, t);
  }
}

/** The ship's horn: a long, low, warm call — two reeds a fifth apart and
 * a hair out of tune, scooping up into pitch, its tone opening out as it
 * sounds and closing as it dies. About two seconds. */
export function sfxShipHorn(volume = 1): void {
  const a0 = audio();
  if (!a0) return;
  const { ctx: c } = a0;
  const held = 1.8;
  const a = atVolume(a0, volume, held + 1.2);
  const t = c.currentTime;
  // The horn's throat: its tone opening out as it sounds, closing as it dies.
  const throat = c.createBiquadFilter();
  throat.type = "lowpass";
  throat.Q.value = 0.8;
  throat.frequency.setValueAtTime(200, t);
  throat.frequency.linearRampToValueAtTime(850, t + 0.35);
  throat.frequency.setValueAtTime(850, t + held - 0.3);
  throat.frequency.linearRampToValueAtTime(240, t + held + 0.5);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.13, t + 0.25);
  g.gain.setValueAtTime(0.13, t + held - 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t + held + 0.6);
  throat.connect(g).connect(a.out);
  const base = 92 * wobble(0.02);
  // A slow vibrato, shared.
  const vibrato = c.createOscillator();
  vibrato.frequency.value = 4.6;
  const depth = c.createGain();
  depth.gain.value = base * 0.005;
  vibrato.connect(depth);
  const voices: [ratio: number, type: OscillatorType, level: number][] = [
    [1, "sawtooth", 0.9],
    [1.004, "triangle", 0.8],
    [1.5, "sawtooth", 0.45],
    [0.5, "sine", 0.9],
  ];
  const oscs = voices.map(([ratio, type, level]) => {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(base * ratio * 0.94, t);
    o.frequency.exponentialRampToValueAtTime(base * ratio, t + 0.3);
    depth.connect(o.frequency);
    const v = c.createGain();
    v.gain.value = level;
    o.connect(v).connect(throat);
    return o;
  });
  for (const o of [...oscs, vibrato]) {
    o.start(t);
    o.stop(t + held + 0.7);
  }
}

/** The hull creaking: wood grabbing and letting go — a buzz pulsing
 * through a narrow band, rising and falling a little. Each its own. */
export function sfxShipCreak(volume = 1): void {
  const a0 = audio();
  if (!a0) return;
  const { ctx: c } = a0;
  const k = wobble(0.08);
  const len = 0.5 + Math.random() * 0.4;
  const a = atVolume(a0, volume, len + 0.3);
  const t = c.currentTime;
  const o = c.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(70 * k, t);
  o.frequency.linearRampToValueAtTime(110 * k, t + len * 0.6);
  o.frequency.linearRampToValueAtTime(84 * k, t + len);
  const band = c.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 5;
  band.frequency.setValueAtTime(650 * k, t);
  band.frequency.linearRampToValueAtTime(1100 * k, t + len);
  // Stick and slip: the sound caught and let go 18–34 times a second.
  const grab = c.createGain();
  grab.gain.value = 0.5;
  const slip = c.createOscillator();
  slip.type = "square";
  slip.frequency.setValueAtTime(18 * k, t);
  slip.frequency.linearRampToValueAtTime(34 * k, t + len);
  const depth = c.createGain();
  depth.gain.value = 0.5;
  slip.connect(depth).connect(grab.gain);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.08);
  g.gain.setValueAtTime(0.12, t + len * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(band).connect(grab).connect(g).connect(a.out);
  for (const n of [o, slip]) {
    n.start(t);
    n.stop(t + len + 0.05);
  }
}

/** The hull bumping the dock, or the gangplank landing: a low wooden
 * thunk. */
export function sfxShipThunk(volume = 1): void {
  const a0 = audio();
  if (!a0) return;
  const a = atVolume(a0, volume, 0.6);
  const k = wobble(0.06);
  tone(a, "sine", 130 * k, 52 * k, 0.45, 0.004, 0.3);
  tone(a, "triangle", 260 * k, 170 * k, 0.1, 0.002, 0.08);
  noiseBurst(a, "lowpass", 700 * k, 160, 0.8, 0.18, 0.14);
}

/** The ride's sound, while it plays. */
type ShipLoop = {
  bus: GainNode;
  engine: OscillatorNode[];
  engineLevel: GainNode;
  engineTone: BiquadFilterNode;
  chug: OscillatorNode;
  wind: AudioBufferSourceNode;
  windTone: BiquadFilterNode;
  windLevel: GainNode;
  whistleTone: BiquadFilterNode;
  whistleLevel: GainNode;
};
let shipLoop: ShipLoop | null = null;
/** A few seconds of noise for the wind: the one-second burst buffer would
 * be heard repeating, held this long. */
let windNoise: AudioBuffer | null = null;
/** The ships' cruising speed, u/s: the wind's full at it. */
const SHIP_CRUISE = 7;
/** How quickly the ride's sound follows the ship (s, a time constant). */
const SHIP_FOLLOW = 0.3;

function shipLoopOf(a: Audio): ShipLoop {
  const { ctx: c } = a;
  if (!windNoise) {
    windNoise = c.createBuffer(1, c.sampleRate * 3, c.sampleRate);
    const d = windNoise.getChannelData(0);
    // Brown-ish: each sample a step from the last, so it rumbles.
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.04 * (Math.random() * 2 - 1)) / 1.04;
      d[i] = last * 3.5;
    }
  }
  const bus = c.createGain();
  bus.gain.value = 0;
  bus.connect(a.out);
  // The engines: a low buzz and its octave through a low-pass, thrumming
  // with the propellers (a tremolo that quickens with the throttle).
  const engineTone = c.createBiquadFilter();
  engineTone.type = "lowpass";
  engineTone.frequency.value = 260;
  const thrum = c.createGain();
  thrum.gain.value = 0.75;
  const chug = c.createOscillator();
  chug.frequency.value = 4;
  const chugDepth = c.createGain();
  chugDepth.gain.value = 0.25;
  chug.connect(chugDepth).connect(thrum.gain);
  const engineLevel = c.createGain();
  engineLevel.gain.value = 0;
  engineTone.connect(thrum).connect(engineLevel).connect(bus);
  const engine = (["sawtooth", "square"] as const).map((type, i) => {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = i === 0 ? 46 : 92.3;
    const v = c.createGain();
    v.gain.value = i === 0 ? 1 : 0.3;
    o.connect(v).connect(engineTone);
    return o;
  });
  // The wind: a rumble opening up as it rises, and a thin whistle in the
  // rigging over it.
  const wind = c.createBufferSource();
  wind.buffer = windNoise;
  wind.loop = true;
  const windTone = c.createBiquadFilter();
  windTone.type = "lowpass";
  windTone.frequency.value = 300;
  const windLevel = c.createGain();
  windLevel.gain.value = 0;
  wind.connect(windTone).connect(windLevel).connect(bus);
  const whistleTone = c.createBiquadFilter();
  whistleTone.type = "bandpass";
  whistleTone.Q.value = 7;
  whistleTone.frequency.value = 900;
  const whistleLevel = c.createGain();
  whistleLevel.gain.value = 0;
  wind.connect(whistleTone).connect(whistleLevel).connect(bus);
  for (const n of [...engine, chug]) n.start();
  wind.start(0, Math.random() * 3);
  return {
    bus,
    engine,
    engineLevel,
    engineTone,
    chug,
    wind,
    windTone,
    windLevel,
    whistleTone,
    whistleLevel,
  };
}

/**
 * The sound of riding a sky ship, for as long as you're near one: the
 * engines' hum, pitched and thrumming with the throttle, and the wind,
 * rising steeply with the speed and brightening as it does. Call `set`
 * every frame or so; `near` 0 (or muting) lets it go entirely, so a ship
 * far off costs nothing.
 */
export const shipAmbience = {
  set({
    speed,
    throttle,
    near,
  }: {
    /** u/s. */
    speed: number;
    /** 0–1. */
    throttle: number;
    /** 0 far off – 1 on board. */
    near: number;
  }): void {
    if (muted || near <= 0.001) {
      if (shipLoop) shipAmbience.stop();
      return;
    }
    const a = audio();
    if (!a) return;
    shipLoop ??= shipLoopOf(a);
    const s = shipLoop;
    const now = a.ctx.currentTime;
    const thr = Math.min(1, Math.max(0, throttle));
    const v = Math.min(1, Math.max(0, speed / SHIP_CRUISE));
    const wind = v ** 1.7;
    const follow = (p: AudioParam, to: number) =>
      p.setTargetAtTime(to, now, SHIP_FOLLOW);
    follow(s.bus.gain, Math.min(1, near));
    const pitch = 0.85 + 0.3 * thr;
    follow(s.engine[0].frequency, 46 * pitch);
    follow(s.engine[1].frequency, 92.3 * pitch);
    follow(s.engineTone.frequency, 220 + 340 * thr);
    follow(s.engineLevel.gain, 0.015 + 0.075 * thr);
    follow(s.chug.frequency, 4 + 8 * thr);
    follow(s.windTone.frequency, 300 * 10 ** v);
    follow(s.windLevel.gain, 0.02 + 0.16 * wind);
    follow(s.whistleTone.frequency, 900 + 1300 * v);
    follow(s.whistleLevel.gain, 0.03 * wind);
  },
  /** Fade it out and let it all go. */
  stop(): void {
    const s = shipLoop;
    if (!s || !ctx) return;
    shipLoop = null;
    const now = ctx.currentTime;
    s.bus.gain.cancelScheduledValues(now);
    s.bus.gain.setTargetAtTime(0, now, 0.1);
    for (const n of [...s.engine, s.chug, s.wind]) n.stop(now + 0.6);
    setTimeout(() => s.bus.disconnect(), 800);
  },
};
