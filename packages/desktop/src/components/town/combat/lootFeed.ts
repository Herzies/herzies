/**
 * The cave's loot and the rest of the app: the Town's 3D scene can't reach
 * the activity log or the bank itself, so TownWorld listens for log lines
 * here, and main.tsx says whether the bank has room for an item.
 */
type Listener = (message: string) => void;

const listeners = new Set<Listener>();

/** A line for the activity log. */
export function pushLootLog(message: string): void {
  for (const l of listeners) l(message);
}

export function onLootLog(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let roomFor: (itemId: string) => boolean = () => true;

/** main.tsx keeps this current with the bank (see HomeView's pickups). */
export function setLootRoom(fn: (itemId: string) => boolean): void {
  roomFor = fn;
}

/** Whether the bank can take one more of `itemId`. */
export function hasLootRoom(itemId: string): boolean {
  return roomFor(itemId);
}
