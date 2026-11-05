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

type RoomFor = (itemId: string, alsoTaking: readonly string[]) => boolean;

let roomFor: RoomFor = () => true;
let free = Number.POSITIVE_INFINITY;
let version = 0;

/** main.tsx keeps this current with the bank (see HomeView's pickups):
 * whether there's room for an item, and how many slots are free. */
export function setLootRoom(
  fn: RoomFor,
  freeSlots = Number.POSITIVE_INFINITY,
): void {
  roomFor = fn;
  free = freeSlots;
  version += 1;
}

/** How many of the bank's slots are free. */
export function bagFree(): number {
  return free;
}

let bagShown = false;

/** main.tsx says when the bag is open: you can see it's full, so no warning. */
export function setBagOpen(open: boolean): void {
  bagShown = open;
}

export function bagOpen(): boolean {
  return bagShown;
}

/** Goes up every time the bank changes (a new `setLootRoom`). */
export function roomVersion(): number {
  return version;
}

/** Whether the bank can take one more of `itemId`, on top of `alsoTaking`
 * (what the spirit has already taken in and not handed over yet). */
export function hasLootRoom(
  itemId: string,
  alsoTaking: readonly string[] = [],
): boolean {
  return roomFor(itemId, alsoTaking);
}
