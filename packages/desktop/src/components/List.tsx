import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * Scrollable list container with a fade-to-background hint at whichever
 * edge (top/bottom) has more content to reveal. Caller owns sizing via
 * `className` (e.g. `min-h-0 flex-1` or `max-h-28`) — this only owns
 * scrolling and the fade.
 */
export function List({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;

    const measure = () => {
      setAtTop(scrollEl.scrollTop <= 0);
      setAtBottom(
        scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 1,
      );
    };

    measure();
    scrollEl.addEventListener("scroll", measure);
    // Watches both the scroller's own box (e.g. window resize) and its
    // content (items added/removed) — content growth alone doesn't change
    // the scroller's box size, so scrollEl-only wouldn't catch it.
    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    observer.observe(contentEl);
    return () => {
      scrollEl.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  // className carries the caller's sizing (`min-h-0 flex-1` or `max-h-*`),
  // so it has to land on the actual scrolling element rather than a wrapper
  // — a wrapper with no in-flow content (the scroller pulled out via
  // `absolute`) collapses to zero height whenever that sizing doesn't come
  // from a flex parent stretching it (e.g. a bare `max-h-*` caller).
  return (
    <div ref={scrollRef} className={cn("overflow-y-auto", className)}>
      <div
        className={cn(
          "pointer-events-none sticky top-0 -mb-4 h-4 bg-gradient-to-b from-bg-panel to-transparent transition-opacity",
          atTop ? "opacity-0" : "opacity-100",
        )}
      />
      <div ref={contentRef}>{children}</div>
      <div
        className={cn(
          "pointer-events-none sticky bottom-0 -mt-4 h-4 bg-gradient-to-t from-bg-panel to-transparent transition-opacity",
          atBottom ? "opacity-0" : "opacity-100",
        )}
      />
    </div>
  );
}
