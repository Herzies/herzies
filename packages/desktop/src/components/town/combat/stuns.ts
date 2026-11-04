/**
 * Who's stunned, and until when (performance.now() ms): the Tower's mobs
 * and the boss's minions by id, the boss, and practice dummies by key.
 * The server's word for mobs and the boss (fight.ts); a local roll for a
 * dummy. StunVFX draws the stars, everyone in the room sees them.
 */
export const stuns = {
  mobs: new Map<number, number>(),
  boss: 0,
  dummies: new Map<string, number>(),
};

/** Whether `until` (a stun's end) is still to come at `now`. */
export function stunnedAt(until: number | undefined, now: number): boolean {
  return until !== undefined && until > now;
}

/** Everything forgotten (leaving the room). */
export function clearStuns(): void {
  stuns.mobs.clear();
  stuns.boss = 0;
  stuns.dummies.clear();
}
