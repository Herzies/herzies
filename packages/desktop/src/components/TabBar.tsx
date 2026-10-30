import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "../lib/escapeStack";
import { cn } from "../lib/utils";
import { PANEL_TAB_ATTR } from "./InventoryView";
import { TabStarAccent } from "./TabStarAccent";

export type View =
  | "home"
  | "events"
  | "profile"
  | "deck"
  | "bag"
  | "stats"
  | "skills"
  | "friends"
  | "leaderboard"
  | "trade"
  | "store"
  | "settings";

/** The windows the Menu button's tray opens, each with its shortcut. */
type MenuItem = {
  id: View;
  label: string;
  /** Shown as "[key]" to the label's left. */
  key: string;
  colour?: "yellow";
};

/** A card landed on Deck or Bag while that window was shut (InventoryView's
 * onTabLanded): `n` counts landings, so each one bumps again. */
export type MenuLanding = { panel: "deck" | "bag"; n: number };

export function TabBar({
  view,
  base,
  setView,
  menuOpen,
  setMenuOpen,
  eventsRunning = 0,
  eventsOpen = false,
  onEvents,
  unspentPoints = 0,
  homeBlocked = false,
  hasStats = false,
  hasSkills = false,
  landing = null,
  windowSize = null,
}: {
  /** The open window, else the screen under it (Home, the Town). */
  view: View;
  /** The screen under any window: the toggle offers the other one. */
  base: "home" | "events";
  /** A tab or a menu item: a screen switches to it, a window toggles. */
  setView: (v: View) => void;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  /** How many events are on right now: Events sparkles and counts them. */
  eventsRunning?: number;
  /** Events: the bulletin board, opened or closed. */
  onEvents: () => void;
  /** The bulletin board is open. */
  eventsOpen?: boolean;
  /** Stat points waiting to be spent; badges Menu and Stats when above 0. */
  unspentPoints?: number;
  /** Home can't be gone to from here (an island you fight on): the button
   * stays, greyed. */
  homeBlocked?: boolean;
  /** The server knows stat points / the herzie has a class. */
  hasStats?: boolean;
  hasSkills?: boolean;
  landing?: MenuLanding | null;
  /** The Town's bigger window, while the Town is on screen: a toggle at the
   * menu's foot (Z does the same). */
  windowSize?: { expanded: boolean; onToggle: () => void } | null;
}) {
  const menuButton = useRef<HTMLButtonElement>(null);
  const windowOpen = view !== "home" && view !== "events";

  const items: MenuItem[] = [
    { id: "profile", label: "Profile", key: "o" },
    { id: "deck", label: "Deck", key: "i" },
    { id: "bag", label: "Bag", key: "b" },
    ...(hasStats ? [{ id: "stats" as const, label: "Stats", key: "j" }] : []),
    ...(hasSkills
      ? [{ id: "skills" as const, label: "Skills", key: "k" }]
      : []),
    { id: "friends", label: "Social", key: "f" },
    { id: "leaderboard", label: "Leaderboard", key: "l" },
    { id: "store", label: "Premium", key: "p", colour: "yellow" },
    { id: "settings", label: "Settings", key: "⌘," },
  ];

  // A landing bumps the Deck/Bag item if the tray is open, else Menu.
  const [bumping, setBumping] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new landing bumps, not the tray opening or closing
  useEffect(() => {
    if (landing) setBumping(menuOpen ? landing.panel : "menu");
  }, [landing]);
  const bump = (id: string) => ({
    className: cn("inline-block", bumping === id && "animate-tab-bump"),
    onAnimationEnd: () => setBumping(null),
  });

  const buttonClass = (active: boolean) =>
    cn(
      // Each its own small frosted button, the header row's 20px. The blur
      // is on the button itself: it has no fixed-position children for it
      // to trap.
      "flex h-5 cursor-pointer items-center overflow-visible rounded-lg border px-2.5 text-[10px] backdrop-blur-md transition-colors",
      active
        ? "border-cyan/40 bg-black/55 font-bold text-cyan"
        : "border-white/12 bg-black/40 text-text hover:bg-black/55 hover:text-cyan/80",
    );
  const onHome = base === "home";

  return (
    // Under the chat, on Home and in the Town alike (main.tsx places it):
    // the Home/World toggle and Events at the left, Menu at the right.
    <div className="flex items-center gap-1.5">
      {/* One button for the two screens: it names the one you're not on. */}
      {onHome ? (
        <button
          type="button"
          onClick={() => setView("events")}
          title="Go to the World — the Town and who's visiting. Shortcut [t]"
          className={buttonClass(false)}
        >
          World
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setView("home")}
          disabled={homeBlocked}
          title={
            homeBlocked
              ? "No Home here — head back out first"
              : "Go Home — your herzie. Shortcut [h]"
          }
          className={cn(
            buttonClass(false),
            homeBlocked &&
              "cursor-default opacity-45 hover:bg-black/40 hover:text-text",
          )}
        >
          Home
        </button>
      )}
      <button
        type="button"
        onClick={onEvents}
        title="Events — what's on now and coming up this week"
        className={cn("relative", buttonClass(eventsOpen))}
      >
        {/* On the button's edges (the button positions it). */}
        {eventsRunning > 0 && <TabStarAccent />}
        <span>
          <span className="relative z-10">Events</span>
          {eventsRunning > 0 && (
            <span className="relative z-10 ml-1 text-[8px] font-bold text-green">
              {eventsRunning}
            </span>
          )}
        </span>
      </button>
      <button
        ref={menuButton}
        type="button"
        onClick={() => setMenuOpen(!menuOpen)}
        title="Menu — your deck, bag, profile and more. Shortcut [m]"
        aria-expanded={menuOpen}
        className={cn("ml-auto", buttonClass(menuOpen || windowOpen))}
      >
        <span className="relative">
          <span
            {...bump("menu")}
            {...(!menuOpen && { [PANEL_TAB_ATTR]: "deck bag" })}
          >
            Menu
          </span>
          {unspentPoints > 0 && (
            <span className="ml-1 text-[8px] font-bold text-yellow">
              +{unspentPoints}
            </span>
          )}
        </span>
      </button>

      {menuOpen && (
        <MenuTray
          anchor={menuButton.current}
          onClose={() => setMenuOpen(false)}
        >
          {items.map((item) => {
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setView(item.id);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2 py-1 text-left text-ui hover:bg-white/8",
                  item.colour === "yellow" ? "text-yellow" : "text-text",
                  active && "bg-white/10 font-bold",
                  active && item.colour !== "yellow" && "text-cyan",
                )}
              >
                <span className="w-7 shrink-0 text-[10px] text-text-dim">
                  [{item.key}]
                </span>
                <span
                  {...(item.id === "deck" || item.id === "bag"
                    ? {
                        ...bump(item.id),
                        [PANEL_TAB_ATTR]: item.id,
                      }
                    : {})}
                >
                  {item.label}
                </span>
                {item.id === "stats" && unspentPoints > 0 && (
                  <span className="ml-auto text-[8px] font-bold text-yellow">
                    +{unspentPoints}
                  </span>
                )}
              </button>
            );
          })}
          {windowSize && (
            <>
              <div className="mx-2 my-1 border-t border-white/15" />
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  windowSize.onToggle();
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2 py-1 text-left text-ui text-text hover:bg-white/8"
              >
                <span className="w-7 shrink-0 text-[10px] text-text-dim">
                  [z]
                </span>
                {windowSize.expanded ? "Smaller window" : "Bigger window"}
              </button>
            </>
          )}
        </MenuTray>
      )}
    </div>
  );
}

/** The Menu button's tray: frosted, just above the button (the nav sits
 * under the chat), right-aligned with it. On the body, so it sits over the windows. Closes on Escape or a
 * click anywhere else. */
function MenuTray({
  anchor,
  onClose,
  children,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      setPos({
        right: Math.max(8, window.innerWidth - r.right),
        bottom: window.innerHeight - r.top + 6,
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  const tray = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      // The Menu tab toggles the tray itself.
      if (tray.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [anchor, onClose]);
  useEscape(onClose);

  if (!pos) return null;
  return createPortal(
    <div
      ref={tray}
      role="menu"
      className="menu-tray-in fixed z-70 w-[160px] overflow-hidden rounded-xl border border-white/12 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7)]"
      style={pos}
    >
      {/* The glass is a sibling layer, as in OverlayWindow. */}
      <div
        aria-hidden="true"
        className="overlay-fade-in pointer-events-none absolute inset-0 bg-bg-panel/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl backdrop-saturate-150"
      />
      <div className="overlay-fade-in relative flex flex-col p-1">
        {children}
      </div>
    </div>,
    document.body,
  );
}
