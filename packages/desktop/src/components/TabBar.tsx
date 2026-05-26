import { cn } from "../lib/utils";
import { TabStarAccent } from "./TabStarAccent";

export type View =
  | "home"
  | "friends"
  | "inventory"
  | "trade"
  | "events"
  | "settings";

export function TabBar({
  view,
  setView,
  hasActiveEvent = false,
}: {
  view: View;
  setView: (v: View) => void;
  hasActiveEvent?: boolean;
}) {
  const tabs: {
    id: View;
    label: string;
    colour: "cyan" | "yellow" | "red" | "green";
    title: string;
  }[] = [
    {
      id: "home",
      label: "Herzie",
      colour: "cyan",
      title: "Your Herzie. Shortcut [h]",
    },
    {
      id: "inventory",
      label: "Inventory",
      colour: "yellow",
      title: "Your inventory. Shortcut [i]",
    },
    {
      id: "events",
      label: "Events",
      colour: "red",
      title: "Events. Shortcut [e]",
    },
    {
      id: "friends",
      label: "Friends",
      colour: "green",
      title: "Your friends. Shortcut [f]",
    },
    {
      id: "settings",
      label: "Settings",
      colour: "cyan",
      title: "Settings. Shortcut [s]",
    },
  ];
  return (
    <div className="flex border-t border-border py-1.5">
      {tabs.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => setView(t.id)}
          title={t.title}
          className={cn(
            "relative flex-1 overflow-visible border-none bg-transparent py-1 text-[10px] cursor-pointer",
            {
              "font-bold text-cyan": view === t.id && t.colour === "cyan",
              "hover:text-cyan/80": view !== t.id && t.colour === "cyan",
              "font-bold text-yellow": view === t.id && t.colour === "yellow",
              "hover:text-yellow/80": view !== t.id && t.colour === "yellow",
              "font-bold text-red": view === t.id && t.colour === "red",
              "hover:text-red/80": view !== t.id && t.colour === "red",
              "font-bold text-green": view === t.id && t.colour === "green",
              "hover:text-green/80": view !== t.id && t.colour === "green",
            },
          )}
        >
          {t.id === "events" && hasActiveEvent && <TabStarAccent />}
          <span className={cn("relative z-10")}>{t.label}</span>
        </button>
      ))}
    </div>
  );
}
