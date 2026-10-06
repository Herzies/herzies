import { cn } from "../lib/utils";
import { BANNER } from "./banner";

/**
 * Full-screen cover while the app has nothing complete to show yet: before
 * the first state arrives at launch, and while a login loads the herzie and
 * its items. Showing the half-loaded UI instead flashes the wrong screen
 * (the logged-out splash, a herzie with no items, a bag that reads as full).
 *
 * `overlay` covers the whole window from inside a view that is still
 * loading (Town), rather than standing in for the app as a screen.
 */
export function LoadingSplash({
  label,
  overlay = false,
}: {
  label?: string;
  overlay?: boolean;
}) {
  return (
    <div
      data-tauri-drag-region
      role="status"
      aria-live="polite"
      className={cn(
        "loading-splash flex flex-col items-center justify-center gap-6",
        overlay ? "fixed inset-0 z-1000 bg-bg-panel" : "h-screen",
      )}
    >
      <pre
        aria-hidden="true"
        className="loading-splash-banner m-0 text-sm leading-[1.15] text-purple"
      >
        {BANNER}
      </pre>
      <div className="flex flex-col items-center gap-2.5">
        <div className="loading-splash-track" aria-hidden="true" />
        <div className="h-4 text-ui text-text-dim">
          {label ?? <span className="sr-only">loading</span>}
        </div>
      </div>
    </div>
  );
}
