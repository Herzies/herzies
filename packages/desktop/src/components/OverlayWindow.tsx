import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useEscape } from "../lib/escapeStack";
import { HerzieStageContext, overlayHerzieStage } from "../lib/overlayStage";
import { cn } from "../lib/utils";

/**
 * A frosted window over the app (Herzie, Social, Premium, ...): rounded,
 * bordered glass from under the nav down to the window's bottom. No
 * backdrop: the rest of the app stays usable around it (the Town keeps
 * walking). Escape or the caller (re-clicking its tab) closes it.
 *
 * Its children stay mounted while it's closed (display: none), so a view
 * keeps its state between visits, as the old full-screen tabs did.
 *
 * Built so nothing it adds traps its content's `position: fixed` popups:
 * the blur is a sibling layer, not a wrapper (a backdrop-filter ancestor
 * would become their containing block), and the panel slides on its
 * margins rather than a transform (globals.css). Fades go on each layer separately: an
 * opacity < 1 ancestor would cut the glass's blur off from what's behind it.
 */
export function OverlayWindow({
  open,
  onClose,
  label,
  children,
  narrow = false,
  fit = false,
  className,
  onClosed,
}: {
  open: boolean;
  onClose: () => void;
  /** What the window is, for screen readers. */
  label: string;
  children: ReactNode;
  /** Keep to the small window's size, top left (the Town's big window,
   * whose chat keeps that width too). */
  narrow?: boolean;
  /** As tall as its content (up to the full height), from the top, rather
   * than the whole height. */
  fit?: boolean;
  className?: string;
  /** The exit has finished playing: it's off screen now. Until then its
   * content should stay as it was (still "active"), or it changes under
   * the fade. */
  onClosed?: () => void;
}) {
  // "closed" is display: none; "closing" plays the exit, then becomes it.
  // Set while rendering, not in an effect: the exit starts on the same
  // frame `open` turns false, rather than a frame late.
  const [phase, setPhase] = useState<"open" | "closing" | "closed">(
    open ? "open" : "closed",
  );
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setPhase(open ? "open" : "closing");
  }

  useEscape(onClose, open);

  // The herzies inside draw on the overlay stage, hosted in whichever
  // window is open (only one is at a time).
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && host.current) overlayHerzieStage.setHost(host.current);
  }, [open]);
  const [skySlot, setSkySlot] = useState<HTMLDivElement | null>(null);
  const stageContext = useMemo(
    () => ({ stage: overlayHerzieStage, inOverlay: true, skySlot }),
    [skySlot],
  );

  const closed = phase === "closed" && !open;
  const closing = phase === "closing";
  const anim = closing ? "overlay-out" : "overlay-in";
  const fade = closing ? "overlay-fade-out" : "overlay-fade-in";

  return (
    <div
      className={cn(
        // From under the nav's row (top-3, 20px: 32px; the panel's inset
        // puts it 6px below) to the window's bottom. No backdrop: around the
        // panel, what's underneath (the Town, walking and all) stays as it
        // is and takes its own clicks.
        "pointer-events-none fixed inset-x-0 top-8 bottom-0 z-60",
        // In the Town's big window: the small window's size, top left, in
        // line with the Town's name and level above it.
        narrow &&
          "bottom-auto h-[calc(var(--small-window-height)-32px)] max-h-[calc(100vh-32px)]",
        closed && "hidden",
      )}
      data-tauri-drag-region="false"
    >
      <div
        role="dialog"
        aria-label={label}
        className={cn(
          "pointer-events-auto absolute inset-1.5 overflow-hidden rounded-2xl border border-white/12 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.7)]",
          narrow && "left-3 right-auto w-[356px]",
          // A column, so the content shrinks (and scrolls) if it can't fit.
          // Hangs from under the nav.
          fit && "bottom-auto flex max-h-[calc(100%-12px)] flex-col",
          closing && "pointer-events-none",
          anim,
        )}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget && closing) {
            setPhase("closed");
            onClosed?.();
          }
        }}
      >
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 rounded-2xl bg-bg-panel/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl backdrop-saturate-150",
            fade,
          )}
        />
        {/* A herzie's sky (HerzieWithSky), over the glass, under the herzie. */}
        <div
          ref={setSkySlot}
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-0", fade)}
        />
        <HerzieStageContext.Provider value={stageContext}>
          <div ref={host} className="pointer-events-none absolute inset-0" />
          <div
            className={cn(
              "relative flex min-h-0 flex-col px-2.5 pt-3 pb-2",
              !fit && "h-full",
              fade,
              className,
            )}
          >
            {children}
          </div>
        </HerzieStageContext.Provider>
      </div>
    </div>
  );
}
