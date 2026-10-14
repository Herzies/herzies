import { cn } from "../../lib/utils";

/** A keyboard key in a Town hint: `Tab`, `Q`. */
export function Key({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "rounded border border-white/30 px-1 text-white",
        className,
      )}
    >
      {children}
    </span>
  );
}
