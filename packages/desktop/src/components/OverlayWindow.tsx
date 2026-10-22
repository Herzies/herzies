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
  onHome = false,
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
  /** Over Home: at the bottom of the window, on clearer glass, so the herzie
   * stays in view above and through it. */
  onHome?: boolean;
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

  const isTop = useEscape(onClose, open);
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // A press anywhere outside closes it — unless something's open over it
  // (an item inspect, a menu, a prompt: those close first), or it's on the
  // nav or the drag strip (data-window-safe), which do their own thing.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || panel.current?.contains(t)) return;
      if (t.closest("[data-window-safe]")) return;
      if (!isTop()) return;
      closeRef.current();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [open, isTop]);

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
        // No backdrop: around the panel, what's underneath (the Town,
        // walking and all; Home's herzie) stays as it is and takes its own
        // clicks.
        "pointer-events-none fixed inset-x-0 z-60",
        narrow
          ? // In the Town's big window: the small window's size, top left,
            // 8px under the player card (the panel's inset is the other 6)
            // and in line with it.
            "top-[calc(var(--player-card-bottom,32px)+2px)] h-[calc(var(--small-window-height)-var(--player-card-bottom,32px)-2px)] max-h-[calc(100vh-var(--player-card-bottom,32px)-2px)]"
          : onHome && !fit
            ? // On Home: the lower part of the window, the herzie above.
              "top-[40%] bottom-0"
            : fit
              ? // From under the nav's row (top-3, 20px: 32px; the panel's
                // inset puts it 6px below), as tall as it needs.
                "top-8 bottom-0"
              : // In the Town: from under the nav, the upper part of the
                // window, leaving the herzie in view below.
                "top-8 bottom-[40%]",
        closed && "hidden",
      )}
      data-tauri-drag-region="false"
    >
      <div
        ref={panel}
        role="dialog"
        aria-label={label}
        className={cn(
          "pointer-events-auto absolute inset-1.5 overflow-hidden rounded-2xl border border-white/12 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.7)]",
          narrow && "left-3 right-auto w-[356px]",
          // A column, so the content shrinks (and scrolls) if it can't fit.
          // Hangs from under the nav; on Home, rests on the window's bottom.
          fit && "flex max-h-[calc(100%-12px)] flex-col",
          fit && (onHome && !narrow ? "top-auto" : "bottom-auto"),
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
            "pointer-events-none absolute inset-0 rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-saturate-150",
            // On Home, clearer glass: the herzie shows through it.
            onHome && !narrow
              ? "bg-bg-panel/30 backdrop-blur-md"
              : "bg-bg-panel/50 backdrop-blur-xl",
            fade,
          )}
        />
        {/* A herzie's sky (HerzieWithSky), over the glass, under the herzie. */}
        <div
          ref={setSkySlot}
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-0", fade)}
        />
        {/* Close. In its own strip along the top (the content starts under
            it), so it never sits on a view's own header buttons. */}
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={onClose}
          className={cn(
            "absolute top-1.5 right-1.5 z-10 flex size-5 cursor-pointer items-center justify-center rounded-full border-none bg-transparent p-0 text-text-dim hover:bg-white/10 hover:text-text",
            fade,
          )}
        >
          <svg
            viewBox="0 0 10 10"
            className="size-2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2 2l6 6M8 2l-6 6" />
          </svg>
        </button>
        <HerzieStageContext.Provider value={stageContext}>
          <div ref={host} className="pointer-events-none absolute inset-0" />
          <div
            className={cn(
              "relative flex min-h-0 flex-col px-2.5 pt-6 pb-2",
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
