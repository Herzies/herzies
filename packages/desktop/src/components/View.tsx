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
  title: string;
  backButton?: React.ReactNode;
  action?: React.ReactNode;
  colour?: "cyan" | "green" | "yellow" | "red";
  children: React.ReactNode;
  className?: string;
  childrenClassName?: string;
}) {
  return (
    <div className={cn("h-full flex flex-col", className)}>
      <div className="flex justify-between items-center mb-4">
        {backButton ? (
          backButton
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

      <div className={cn("flex-1", childrenClassName)}>{children}</div>
    </div>
  );
}
