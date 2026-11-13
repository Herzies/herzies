/**
 * How far behind the server's newest word mobs and the boss are drawn. The
 * same adaptive delay remote herzies are drawn at (the connection's
 * ServerClock), so a mob is drawn touching the herzie it touched, and a
 * slam the herzie it caught, on any link. Its own module so the fight's
 * state and its effects can both read it without importing each other.
 */

/** Before the connection's clock has synced: a bit over two server ticks,
 * so one late packet never leaves them standing. */
export const MOB_DELAY_MS = 150;

let source: () => number = () => MOB_DELAY_MS;

/** Where the delay comes from (the connection, once it's made). */
export function setDrawDelaySource(fn: () => number): void {
  source = fn;
}

/** How far behind the newest word mobs and the boss are drawn now, ms. */
export function drawDelayMs(): number {
  return source();
}
