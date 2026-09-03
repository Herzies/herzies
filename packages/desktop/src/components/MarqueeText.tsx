import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * Single-line text that auto-scrolls left/right to reveal its full content
 * when it overflows its container; falls back to a plain ellipsis otherwise.
 */
export function MarqueeText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return;

    const measure = () => {
      const overflow = textEl.scrollWidth - container.clientWidth;
      setDistance(overflow > 1 ? overflow : 0);
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    ro.observe(textEl);
    return () => ro.disconnect();
  }, [text]);

  return (
    <div
      ref={containerRef}
      className={cn("overflow-hidden whitespace-nowrap", className)}
    >
      <span
        ref={textRef}
        className={cn("inline-block", distance > 0 && "animate-marquee")}
        style={
          distance > 0
            ? ({ "--marquee-distance": `-${distance}px` } as CSSProperties)
            : undefined
        }
      >
        {text}
      </span>
    </div>
  );
}
