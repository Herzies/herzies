import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../lib/utils";

const ALIGN_MAP = {
  left: "start",
  center: "center",
  right: "end",
} as const satisfies Record<
  string,
  TooltipPrimitive.TooltipContentProps["align"]
>;

/**
 * Hover tooltip, built on Radix's Tooltip primitive. Content portals to
 * `document.body`, so it's immune to ancestor stacking contexts (no z-index
 * fights) and ancestor containing-block sizing quirks (no width collapse) —
 * and `avoidCollisions` (on by default) keeps it inside the viewport instead
 * of clipping at screen edges.
 *
 * The trigger is always our own wrapping `<span>`, not the caller's child
 * directly: a `disabled` native `<button>` doesn't fire the pointer events
 * Radix needs, so hovering a disabled trigger would otherwise never open the
 * tooltip. Wrapping it in a plain (non-disabled) span sidesteps that.
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
    <TooltipPrimitive.Provider delayDuration={0}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <span className={cn("inline-flex", className)}>{children}</span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={ALIGN_MAP[align]}
            sideOffset={4}
            collisionPadding={8}
            className="z-100 max-w-[160px] rounded border border-border bg-bg-panel px-1.5 py-0.5 text-left text-ui-sm text-text"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
