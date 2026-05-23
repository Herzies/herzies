import { cn } from "../lib/utils";

export function BackButton({
  colour = "yellow",
  onClick,
}: {
  colour?: "cyan" | "yellow" | "red" | "green";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title="Back"
      type="button"
      className={cn("text-ui-lg font-bold cursor-pointer", {
        "text-cyan": colour === "cyan",
        "text-yellow": colour === "yellow",
        "text-red": colour === "red",
        "text-green": colour === "green",
      })}
    >
      ← Back
    </button>
  );
}
