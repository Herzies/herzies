import { cn } from "../lib/utils";

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
}: {
  view: View;
  setView: (v: View) => void;
}) {
  const tabs: { id: View; label: string }[] = [
    { id: "home", label: "Herzie" },
    { id: "inventory", label: "Inventory" },
    { id: "events", label: "Events" },
    { id: "friends", label: "Friends" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <div className="flex border-t border-border py-1.5">
      {tabs.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => setView(t.id)}
          className={cn(
            "flex-1 border-none bg-transparent py-1 text-[10px] cursor-pointer",
            view === t.id
              ? "font-bold text-cyan"
              : "font-normal text-text-dim hover:text-text/70",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
