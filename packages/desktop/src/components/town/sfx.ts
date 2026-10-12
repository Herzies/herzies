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
