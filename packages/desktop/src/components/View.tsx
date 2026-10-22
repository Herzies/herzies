import { cn } from "../lib/utils";

export function View({
  title,
  backButton,
  action,
  colour = "cyan",
  children,
  className,
  childrenClassName,
}: {
  /** Left out inside a window, whose own title row names it. */
  title?: string;
  backButton?: React.ReactNode;
  action?: React.ReactNode;
  colour?: "cyan" | "green" | "yellow" | "red";
  children: React.ReactNode;
  className?: string;
  childrenClassName?: string;
}) {
  return (
    <div className={cn("h-full flex flex-col", className)}>
      {(backButton || title || action) && (
        <div
          className={cn(
            "relative z-50 flex justify-between items-center",
            // Under a window's title row, just badges or a back button: less gap.
            title ? "mb-4" : "mb-2",
          )}
        >
          {backButton ? (
            backButton
          ) : !title ? (
            <span />
          ) : (
            <h1
              className={cn("text-ui-lg font-bold", {
                "text-cyan": colour === "cyan",
                "text-green": colour === "green",
                "text-yellow": colour === "yellow",
                "text-red": colour === "red",
              })}
            >
              {title}
            </h1>
          )}

          {action && <div className="text-ui text-text-dim">{action}</div>}
        </div>
      )}

      <div className={cn("flex-1", childrenClassName)}>{children}</div>
    </div>
  );
}
