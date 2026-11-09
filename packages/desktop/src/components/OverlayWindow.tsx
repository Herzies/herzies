import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useEscape } from "../lib/escapeStack";
import { HerzieStageContext, overlayHerzieStage } from "../lib/overlayStage";
import { cn } from "../lib/utils";

/**
 * A frosted window over the app (Herzie, Social, Premium, ...): rounded,
 * bordered glass from the top down to the window's bottom. No
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
  title,
  titleClassName = "text-cyan",
  children,
  narrow = false,
  onHome = false,
  inTown = false,
  fit: fitProp = false,
  half = false,
  side,
  wide = false,
  className,
  onClosed,
  noStage,
}: {
  open: boolean;
  onClose: () => void;
  /** The window's name, on its title row (always shown, whatever the
   * view inside is doing) and for screen readers. */
  title: string;
  /** The title's colour. */
  titleClassName?: string;
  children: ReactNode;
  /** Keep to the small window's size, top left (the Town's big window,
   * whose chat keeps that width too). */
  narrow?: boolean;
  /** Over Home (see `half`): the whole height, like `fit` in the Town. */
  onHome?: boolean;
  /** Over the Town's world: a press outside doesn't close it. */
  inTown?: boolean;
  /** As tall as its content (up to the full height), from the top, rather
   * than the whole height. */
  fit?: boolean;
  /** On Home: the bottom half of the window on clearer glass (taking
   * precedence over `fit` there), the herzie raised above it (the Herzie
   * window). */
  half?: boolean;
  /** With `narrow` (the big window): stand on the right instead (under the
   * boss's card in a fight), as tall as in the small window, where nothing
   * else is; the chat and the player card keep the left. */
  side?: "right";
  /** With `narrow` and `side="right"`: may reach down to the right
   * column's floor (with `fit`, as tall as its content up to there), rather
   * than keep to the small window's height (the Herzie window's character
   * screen). */
  wide?: boolean;
  className?: string;
  /** Has no herzies in it: leaves the overlay stage where it is, so a
   * window open beside it (the Herzie window, with Stats in the big window)
   * keeps drawing its herzie. */
  noStage?: boolean;
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
  // Not in the Town: there the world around it is played in, and a click
  // on it shouldn't cost you the window.
  useEffect(() => {
    if (!open || inTown) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || panel.current?.contains(t)) return;
      if (t.closest("[data-window-safe]")) return;
      if (!isTop()) return;
      closeRef.current();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [open, inTown, isTop]);

  // The herzies inside draw on the overlay stage, hosted in the window
  // that has them (only one does at a time).
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && !noStage && host.current)
      overlayHerzieStage.setHost(host.current);
    // A window coming or going makes the web view rebuild its layers, which
    // can blank a still herzie in another window still open (Stats beside
    // the Herzie window): draw it again.
    overlayHerzieStage.redraw();
  }, [open, noStage]);
  const [skySlot, setSkySlot] = useState<HTMLDivElement | null>(null);
  const stageContext = useMemo(
    () => ({ stage: overlayHerzieStage, inOverlay: true, skySlot }),
    [skySlot],
  );

  // Home's half-height window is a fixed size, not as tall as its content.
  const right = narrow && side === "right";
  const rightWide = right && wide;
  const fit = fitProp && !(half && onHome && !narrow);

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
        // 2px bigger all round than the app's content (10px in, not its
        // 12px): edges that lined up with the cards underneath (the chat,
        // the player card) showed through the glass as a doubled edge. The
        // big window's stay in line with its player card.
        "pointer-events-none fixed z-60",
        // Where windows start: 12px under the top bar (as the player card
        // does), or 10px under the boss's card when that's lower.
        "[--win-top:max(calc(var(--boss-card-bottom,0px)+10px),calc(var(--title-bar-height,0px)+12px))]",
        narrow ? "inset-x-3" : "inset-x-2.5",
        rightWide
          ? // The tall one on the right: from the same top, down to the
            // right column's floor at most (clear of the skills).
            "top-[var(--win-top)] h-[calc(100vh-var(--win-top)-56px)]"
          : right
            ? // In the big window, on the right: from the top (under the
              // boss's card, if there is one), as tall as it is in the small
              // window (10px from its top, 36px from its bottom), and never
              // down past the skills.
              "top-[var(--win-top)] h-[calc(var(--small-window-height)-var(--title-bar-height,0px)-48px)] max-h-[calc(100vh-var(--win-top)-56px)]"
            : narrow
              ? // In the Town's big window: the small window's size, top left,
                // 8px under the player card and in line with it.
                "top-[calc(var(--player-card-bottom,32px)+8px)] h-[calc(var(--small-window-height)-var(--player-card-bottom,32px)-14px)] max-h-[calc(100vh-var(--player-card-bottom,32px)-20px)]"
              : onHome && half
                ? // On Home, the deck and the bag: the bottom half, down to
                  // just over the nav's row (main.tsx).
                  "top-[calc(50%+1px)] bottom-[36px]"
                : onHome && !fit
                  ? // On Home, the rest: from the top (under the top bar,
                    // over the player card) to just over the nav's row.
                    "top-[var(--win-top)] bottom-[36px]"
                  : fit
                    ? // From the window's top (12px down, over the player card),
                      // as tall as it needs, down to the nav's row at most.
                      "top-[var(--win-top)] bottom-[36px]"
                    : // In the Town: the whole height, as on Home (the Herzie
                      // window is `fit`, as tall as it needs).
                      "top-[var(--win-top)] bottom-[36px]",
        closed && "hidden",
      )}
      data-tauri-drag-region="false"
    >
      <div
        ref={panel}
        role="dialog"
        // A press in another window (two can be open side by side) isn't
        // a press outside this one.
        data-window-safe
        aria-label={title}
        className={cn(
          "pointer-events-auto absolute inset-0 overflow-hidden rounded-2xl border border-white/12 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.7)]",
          narrow && (right ? "left-auto w-[356px]" : "right-auto w-[356px]"),
          // A column, so the content shrinks (and scrolls) if it can't fit.
          // Hangs from the top.
          fit && "flex max-h-full flex-col",
          fit && "bottom-auto",
          closing && "pointer-events-none",
          anim,
        )}
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          // Its layers settle as the animation ends: once more (see above).
          overlayHerzieStage.redraw();
          if (closing) {
            setPhase("closed");
            onClosed?.();
          }
        }}
      >
        {/* The blur reaches 24px past the panel, which clips it: a blur
            runs out of picture at its own edge and smears whatever's there
            inward, and the cards underneath (the chat, the player card) sit
            12px in from the window's sides exactly where the panel's edges
            are. Out there, the smear is clipped away. */}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute -inset-6 backdrop-saturate-150",
            // The Herzie window on Home: clearer glass, the herzie raised
            // above it.
            onHome && half && !narrow ? "backdrop-blur-md" : "backdrop-blur-xl",
            fade,
          )}
        />
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
            onHome && half && !narrow ? "bg-bg-panel/50" : "bg-bg-panel/70",
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
              "relative flex min-h-0 flex-col",
              !fit && "h-full",
              fade,
            )}
          >
            {/* The title row: the title, then close at the far right. h-8
                with a size-5 button and pr-1.5: 6px from the top and the
                right edge alike. Its own layer (z-50, as View's header):
                a herzie inside paints at z-index 1 and would take the
                close button's clicks. */}
            <div className="relative z-50 flex h-8 shrink-0 items-center justify-between pr-1.5 pl-2.5">
              <h1
                className={cn("truncate text-ui-lg font-bold", titleClassName)}
              >
                {title}
              </h1>
              <button
                type="button"
                aria-label={`Close ${title}`}
                onClick={onClose}
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent p-0 text-text-dim hover:bg-white/10 hover:text-text"
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
            </div>
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col px-2.5 pb-2",
                className,
              )}
            >
              {children}
            </div>
          </div>
        </HerzieStageContext.Provider>
      </div>
    </div>
  );
}
