import { cn } from "../lib/utils";

/**
 * Scrollable list container. Caller owns sizing via `className` (e.g.
 * `min-h-0 flex-1` or `max-h-28`) — this only owns scrolling. No fade at the
 * edges: lists sit on the overlay windows' glass, where a fade to the app's
 * background colour reads as a dark band.
 */
export function List({
  children,
  className,
  contentStyle,
}: {
  children: React.ReactNode;
  className?: string;
  /** Style for the wrapper around `children`. Give it a `height` to make the
   * content taller than the visible area, so something inside can size
   * itself in percentages of that. */
  contentStyle?: React.CSSProperties;
}) {
  // className carries the caller's sizing (`min-h-0 flex-1` or `max-h-*`),
  // so it has to land on the actual scrolling element rather than a wrapper
  // — a wrapper with no in-flow content (the scroller pulled out via
  // `absolute`) collapses to zero height whenever that sizing doesn't come
  // from a flex parent stretching it (e.g. a bare `max-h-*` caller).
  return (
    // cursor-default: a list's plain text rows aren't for selecting, so no
    // I-beam over them; rows that do something set their own pointer.
    <div className={cn("cursor-default overflow-y-auto", className)}>
      <div style={contentStyle}>{children}</div>
    </div>
  );
}
