import { cn } from "../lib/utils";

/** Matches View's colour prop so a tab row can match its screen's theme. */
export type TabColour = "cyan" | "green" | "yellow" | "red";

export function TabButton({
  active,
  onClick,
  colour = "cyan",
  children,
}: {
  active: boolean;
  onClick: () => void;
  colour?: TabColour;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer border-none bg-transparent px-1.5 pb-1.5 pt-0.5 text-ui",
        active
          ? cn("font-bold", {
              "text-cyan": colour === "cyan",
              "text-green": colour === "green",
              "text-yellow": colour === "yellow",
              "text-red": colour === "red",
            })
          : "text-text-dim hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
