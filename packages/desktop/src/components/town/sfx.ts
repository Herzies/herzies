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
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
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

/** Stepping through a portal: a long rising rush. */
export function sfxPortal(): void {
  const a = audio();
  if (!a) return;
  noiseBurst(a, "bandpass", 200, 3200, 2, 0.35, 0.8);
  tone(a, "sine", 110, 440, 0.2, 0.2, 0.7);
}
