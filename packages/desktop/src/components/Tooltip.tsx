import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";

const CURSOR_GAP_X = 10;
const CURSOR_GAP_Y = 6;
const EDGE_PADDING = 8;
const EST_WIDTH = 160;
const EST_HEIGHT = 24;

/**
 * Hover tooltip that tracks the cursor rather than anchoring to the
 * trigger's own position. Content portals to `document.body`, so it's
 * immune to ancestor stacking contexts (no z-index fights) and ancestor
 * containing-block sizing quirks (no width collapse).
 *
 * Sits with its bottom edge just above the cursor tip — `top`/`left` are the
 * cursor position and a `translate()` shifts by the bubble's own (actual,
 * unmeasured) size, so this is exact regardless of how wide the label ends
 * up (flips to whichever side/edge has room, using EST_WIDTH/EST_HEIGHT for
 * that decision only, since real size isn't known yet — a decision, not a
 * cap, matters here because positioning off the *estimate* instead of this
 * transform would leave a gap for any label narrower than the estimate).
 * Meant for a short `nowrap` text label; for content too big to comfortably
 * chase the cursor (e.g. a full item preview card), use `HoverPreview`
 * instead, which anchors to the trigger itself rather than the cursor.
 *
 * The trigger is always our own wrapping `<span>`, not the caller's child
 * directly: a `disabled` native `<button>` doesn't reliably fire the mouse
 * events we listen for, so hovering it would otherwise never open the
 * tooltip. Listening on the wrapping span sidesteps that.
 */
export function Tooltip({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);

  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  /** Every path that hides the bubble has to cancel the pending frame too:
   * a move schedules the `setPos` for the *next* frame, so a mouseleave (or
   * drag start) in the same frame would set null first and then be undone by
   * that queued callback — leaving a bubble on screen for a trigger the
   * cursor has already left, with no further event coming to clear it. */
  const close = () => {
    cancelFrame();
    setPos(null);
  };

  useEffect(() => cancelFrame, []);

  const handleMove = (e: React.MouseEvent) => {
    cancelFrame();
    // A held button means a drag (native or click-drag) is in progress —
    // dragging over several triggers in a row can leave a stale element
    // without its mouseleave (e.g. a native drag hijacking the event
    // stream), so don't track the cursor while any button is down.
    if (e.buttons !== 0) {
      close();
      return;
    }
    const { clientX: x, clientY: y } = e;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setPos({ x, y });
    });
  };

  const bubbleStyle = (x: number, y: number): React.CSSProperties => {
    const fitsRight =
      x + CURSOR_GAP_X + EST_WIDTH <= window.innerWidth - EDGE_PADDING;
    const fitsAbove = y - CURSOR_GAP_Y - EST_HEIGHT >= EDGE_PADDING;
    return {
      left: fitsRight ? x + CURSOR_GAP_X : x - CURSOR_GAP_X,
      top: fitsAbove ? y - CURSOR_GAP_Y : y + CURSOR_GAP_Y,
      transform: `translate(${fitsRight ? "0" : "-100%"}, ${fitsAbove ? "-100%" : "0"})`,
    };
  };

  return (
    <span
      className={cn("inline-flex", className)}
      onMouseEnter={handleMove}
      onMouseMove={handleMove}
      onMouseLeave={close}
    >
      {children}
      {pos &&
        createPortal(
          <div
            className="pointer-events-none fixed z-100 rounded border border-border bg-bg-panel px-1.5 py-0.5 text-left text-ui-sm whitespace-nowrap text-text"
            style={bubbleStyle(pos.x, pos.y)}
          >
            {label}
          </div>,
          document.body,
        )}
    </span>
  );
}

const TRIGGER_GAP = 8;
const PREVIEW_EST_WIDTH = 260;
const PREVIEW_EST_HEIGHT = 300;

/** How long the cursor has to rest on an item before its first preview opens,
 * so sweeping across the grid on the way somewhere else doesn't flash cards. */
const PREVIEW_OPEN_DELAY_MS = 350;
/** Once a preview has been shown, moving on to the next item within this long
 * opens its preview straight away — browsing item to item stays instant. */
const PREVIEW_WARM_MS = 300;
/** When the last preview closed, and how many are open now. Module-wide, so
 * the warmth carries from one trigger to the next. */
let previewClosedAt = Number.NEGATIVE_INFINITY;
let previewsOpen = 0;
const previewWarm = () =>
  previewsOpen > 0 || performance.now() - previewClosedAt < PREVIEW_WARM_MS;

/**
 * Shows `content` anchored to the trigger element's own position, not the
 * cursor — unlike `Tooltip`, position is measured once (on hover) from the
 * trigger's bounding rect and centred horizontally on it, so it stays put
 * instead of drifting as the cursor moves around inside a large trigger
 * (e.g. a grid cell). Meant for content too big to comfortably chase the
 * cursor (a full item preview card, say); for a short text label, use
 * `Tooltip` instead. Portals to `document.body` for the same reasons as
 * `Tooltip`.
 */
export function HoverPreview({
  content,
  children,
  className,
  /** Skip the above/below fit check and always place it above the trigger —
   * for a caller whose layout already guarantees room there. */
  alwaysAbove = true,
  /** `content`'s real (or best-guess) footprint, used to centre it over the
   * trigger and to judge whether it fits above. */
  estWidth = PREVIEW_EST_WIDTH,
  estHeight = PREVIEW_EST_HEIGHT,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  alwaysAbove?: boolean;
  estWidth?: number;
  estHeight?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tracks this preview in the module-wide warmth (see previewWarm).
  useEffect(() => {
    if (!visible) return;
    previewsOpen++;
    return () => {
      previewsOpen--;
      previewClosedAt = performance.now();
    };
  }, [visible]);

  const cancelOpen = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  // Unmounting mid-delay must not open a preview for a trigger that's gone.
  useEffect(
    () => () => {
      if (openTimer.current !== null) clearTimeout(openTimer.current);
    },
    [],
  );

  const open = () => {
    cancelOpen();
    if (previewWarm()) {
      setVisible(true);
      return;
    }
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setVisible(true);
    }, PREVIEW_OPEN_DELAY_MS);
  };
  const hide = () => {
    cancelOpen();
    setVisible(false);
  };

  const bubbleStyle = (): React.CSSProperties => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return { display: "none" };
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - estWidth / 2, EDGE_PADDING),
      window.innerWidth - estWidth - EDGE_PADDING,
    );
    const fitsAbove =
      alwaysAbove || rect.top - TRIGGER_GAP - estHeight >= EDGE_PADDING;
    return {
      left,
      top: fitsAbove ? rect.top - TRIGGER_GAP : rect.bottom + TRIGGER_GAP,
      transform: `translateY(${fitsAbove ? "-100%" : "0"})`,
    };
  };

  return (
    <span
      ref={ref}
      className={cn("inline-flex", className)}
      onMouseEnter={(e) => (e.buttons === 0 ? open() : hide())}
      // Same drag guard as `Tooltip` — see its handleMove.
      onMouseMove={(e) => {
        if (e.buttons !== 0) hide();
      }}
      onMouseLeave={hide}
      // A click is the player acting on the item — equipping it, opening
      // the dice window, inspecting it — and the preview has done its job.
      // It stays closed until the pointer leaves and comes back (only
      // mouseenter re-opens it).
      onPointerDown={hide}
    >
      {children}
      {visible &&
        createPortal(
          <div
            className="pointer-events-none fixed z-100"
            style={bubbleStyle()}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
