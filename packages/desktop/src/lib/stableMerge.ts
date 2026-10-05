/**
 * Merges a fresh state push into the previous state, keeping the previous
 * reference for every top-level field whose content is unchanged — and the
 * previous object outright when nothing changed.
 *
 * The Rust side sends the whole AppState over IPC on every push, so each one
 * deserializes into brand-new objects even when only `nowPlaying` moved.
 * Handed to React as-is, that made every field look changed: every memo keyed
 * on `state.inventory`, `state.units`, `state.friends`… recomputed, and every
 * view re-rendered on every push. With this, identity means "content changed"
 * again, so memoized views and effects only react to real changes.
 *
 * Compared structurally rather than by JSON text: most of AppState comes
 * from Rust `HashMap`s, whose key order changes every time the map is rebuilt
 * from a response, so equal content does not serialize identically.
 */
export function stableMerge<T extends object>(prev: T, next: T): T {
  const merged = {} as T;
  let changed = Object.keys(prev).length !== Object.keys(next).length;
  for (const key of Object.keys(next) as (keyof T)[]) {
    const before = prev[key];
    const after = next[key];
    if (deepEqual(before, after)) {
      merged[key] = before;
    } else {
      merged[key] = after;
      changed = true;
    }
  }
  return changed ? merged : prev;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const rb = b as Record<string, unknown>;
  const ra = a as Record<string, unknown>;
  return ka.every((k) => Object.hasOwn(rb, k) && deepEqual(ra[k], rb[k]));
}
