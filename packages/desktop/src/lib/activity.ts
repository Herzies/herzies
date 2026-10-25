/**
 * A line in the activity log (the chat's history) from anywhere, no React
 * needed — e.g. the Tower's "+1 XP" on a kill. The app subscribes once and
 * adds each line as the backend's activity is added.
 */
const listeners = new Set<(message: string) => void>();

export function logActivity(message: string): void {
  for (const l of listeners) l(message);
}

export function onLogActivity(cb: (message: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
