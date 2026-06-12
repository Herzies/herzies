import { cn } from "../lib/utils";

/**
 * Hover tooltip. Wraps its trigger; the label appears on hover with a short
 * delay. Pure CSS — no portal — so keep `align` away from clipping edges.
 */
export function Tooltip({
  label,
  children,
  side = "bottom",
  align = "center",
  className,
}: {
  label: string;
  children: React.ReactNode;
  /** Which side of the trigger the label appears on. */
  side?: "top" | "bottom";
  /** Horizontal anchoring relative to the trigger. */
  align?: "left" | "center" | "right";
  className?: string;
}) {
  return (
    <span className={cn("group/tooltip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-100 whitespace-nowrap rounded border border-border bg-bg-panel px-1.5 py-0.5 text-ui-sm text-text opacity-0 transition-opacity delay-150 group-hover/tooltip:opacity-100",
          side === "bottom" ? "top-full mt-1" : "bottom-full mb-1",
          align === "center" && "left-1/2 -translate-x-1/2",
          align === "left" && "left-0",
          align === "right" && "right-0",
        )}
      >
        {label}
      </span>
    </span>
  );
}
