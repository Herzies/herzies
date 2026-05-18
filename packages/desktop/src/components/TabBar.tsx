import { btnStyle } from "./styles";

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
    <div
      style={{ display: "flex", borderTop: "1px solid #333", padding: "6px 0" }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setView(t.id)}
          style={{
            ...btnStyle,
            border: "none",
            borderRadius: 0,
            flex: 1,
            padding: "4px 0",
            color: view === t.id ? "#7dd3fc" : "#666",
            fontWeight: view === t.id ? "bold" : "normal",
            background: "transparent",
            fontSize: 10,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
