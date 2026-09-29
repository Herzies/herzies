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
  visitorsInTown = 0,
}: {
  view: View;
  setView: (v: View) => void;
  /** How many visitors are in Town right now; badges the tab when above 0. */
  visitorsInTown?: number;
}) {
  type Tab = {
    id: View;
    label: string;
    colour: "cyan" | "yellow" | "red" | "green";
    title: string;
  };

  const tabs: Tab[] = [
    {
      id: "home",
      label: "Home",
      colour: "cyan",
      title: "Home — your herzie. Shortcut [h]",
    },
    {
      id: "inventory",
      label: "Inventory",
      colour: "cyan",
      title: "Your inventory. Shortcut [i]",
    },
    {
      id: "events",
      label: "Town",
      colour: "cyan",
      title: "Town — who's visiting. Shortcut [t]",
    },
    {
      id: "friends",
      label: "Social",
      colour: "cyan",
      title: "Friends & leaderboard. Shortcut [f]",
    },
    {
      id: "store",
      label: "Store",
      colour: "yellow",
      title: "Expansions & premium cards. Shortcut [b]",
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
      {t.id === "events" && visitorsInTown > 0 && <TabStarAccent />}
      <span className={cn("relative z-10")}>{t.label}</span>
      {t.id === "events" && visitorsInTown > 0 && (
        <span className="relative z-10 ml-0.5 align-super text-[8px] font-bold text-green">
          {visitorsInTown}
        </span>
      )}
    </button>
  );

  return (
    <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
      {tabs.map(renderTab)}
    </div>
  );
}
