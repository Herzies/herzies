import { useEffect, useState } from "react";
import { cn } from "../lib/utils";

/** How long each step of the dots ("", ".", "..", "...") shows. */
const DOT_MS = 400;

/**
 * Full-screen cover while the app has nothing complete to show yet: before
 * the first state arrives at launch, and while a login loads the herzie and
 * its items. Showing the half-loaded UI instead flashes the wrong screen
 * (the logged-out splash, a herzie with no items, a bag that reads as full).
 *
 * Just the label, centred, with dots counting up after it. `overlay` covers
 * the whole window from inside a view that is still loading (Town), rather
 * than standing in for the app as a screen.
 */
export function LoadingSplash({
  label = "loading",
  hint,
  overlay = false,
}: {
  label?: string;
  /** A smaller line under the label. */
  hint?: string;
  overlay?: boolean;
}) {
  return (
    <div
      data-tauri-drag-region
      role="status"
      aria-live="polite"
      className={cn(
        "loading-splash flex flex-col items-center justify-center gap-1 text-ui text-text-dim",
        overlay ? "fixed inset-0 z-1000 bg-bg-panel" : "h-screen",
      )}
    >
      <div className="relative">
        {label}
        {/* Outside the label's box, so the label stays centred as the dots
            grow. */}
        <LoadingDots className="absolute left-full" />
      </div>
      {hint ? <div className="text-[10px]">{hint}</div> : null}
    </div>
  );
}

function LoadingDots({ className }: { className?: string }) {
  const [count, setCount] = useState(3);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setCount(0);
    const id = setInterval(() => setCount((n) => (n + 1) % 4), DOT_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <span aria-hidden="true" className={className}>
      {".".repeat(count)}
    </span>
  );
}
