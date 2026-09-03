import { cn } from "../lib/utils";
import { TabStarAccent } from "./TabStarAccent";

export type View =
  | "home"
  | "friends"
  | "inventory"
  | "trade"
  | "events"
  | "store"
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
  type Tab = {
    id: View;
    label: string;
    colour: "cyan" | "yellow" | "red" | "green";
    title: string;
  };

  const leftTabs: Tab[] = [
    {
      id: "home",
      label: "Herzie",
      colour: "cyan",
      title: "Your Herzie. Shortcut [h]",
    },
    {
      id: "inventory",
      label: "Inventory",
      colour: "cyan",
      title: "Your inventory. Shortcut [i]",
    },
    {
      id: "events",
      label: "Events",
      colour: "cyan",
      title: "Events. Shortcut [e]",
    },
    {
      id: "friends",
      label: "Social",
      colour: "cyan",
      title: "Friends & leaderboard. Shortcut [f]",
    },
  ];

  const rightTabs: Tab[] = [
    {
      id: "store",
      label: "Store",
      colour: "yellow",
      title: "Buy coins. Shortcut [b]",
    },
    {
      id: "settings",
      label: "Settings",
      colour: "cyan",
      title: "Settings. Shortcut [s]",
    },
  ];

  const renderTab = (t: Tab) => (
    <button
      type="button"
      key={t.id}
      onClick={() => setView(t.id)}
      title={t.title}
      className={cn(
        "relative overflow-visible border-none bg-transparent py-1 text-[10px] cursor-pointer",
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
  );

  return (
    <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
      <div className="flex items-center gap-3">{leftTabs.map(renderTab)}</div>
      <div className="flex items-center gap-3">{rightTabs.map(renderTab)}</div>
    </div>
  );
}
