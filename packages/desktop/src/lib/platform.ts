/** Running on macOS: the window has the native red/yellow/green buttons in
 * its top-left corner (tray.rs), so the top bar leaves room for them. */
export const IS_MAC =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
