/**
 * What the boss says in its cave, over its head. The Town server picks and
 * sends each line (so everyone in the room reads the same one); the desktop
 * only draws it.
 *
 * It hates music, any music: the lines keep saying so, since that's the hint
 * players act on (play something, for your class's bonus).
 */

export type BossLineKind =
  | "start"
  | "phase"
  | "remind"
  | "minions"
  | "enrage"
  | "pulse"
  | "victory"
  | "wipe";

export const BOSS_LINES: Record<BossLineKind, readonly string[]> = {
  start: [
    "Enough waiting. And keep that music away from me!",
    "The door is shut. Nobody leaves. Nobody plays a note.",
    "Let's dance. In silence.",
  ],
  phase: [
    "Ugh! Still with the music?!",
    "Every song you play makes me angrier!",
    "Stop it! No more music! No more!",
  ],
  remind: [
    "If I hear one more note...",
    "Music? In MY cave?",
    "Who let a melody in here?",
    "I'd rather eat a cymbal than hear another song.",
    "Turn that racket off!",
  ],
  minions: [
    "Thornlings! Make them stop!",
    "Children! Dinner time!",
    "You want a crowd? Here's a crowd.",
  ],
  enrage: ["I am DONE being patient!", "You're still here?! Faster, then."],
  pulse: ["THIS ENDS NOW."],
  victory: ["Not... the... music...", "Fine. FINE. Take your shiny things."],
  wipe: ["Silence at last.", "Come back when you can hold a tune."],
};

/** A line of `kind`. `rand` picks, so the server's seeded generator keeps a
 * fight reproducible. */
export function bossLine(kind: BossLineKind, rand: () => number): string {
  const pool = BOSS_LINES[kind];
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

/** How long a line stays up: long enough to read, scaled by its length. */
export function bossLineMs(text: string): number {
  return Math.min(7_000, 2_500 + text.length * 45);
}
