/** Joins class names, skipping falsy ones — the shared package's stand-in for
 * clsx, so it doesn't take on a dependency for one line. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
