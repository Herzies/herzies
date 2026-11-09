import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_MAC } from "../lib/platform";
import { cn } from "../lib/utils";
import { useWindowFocused } from "../tauri-bridge";

/** The bar's height: macOS's own title bar's. */
const HEIGHT = 28;

/** The three window buttons, drawn as macOS draws them: coloured while the
 * window has focus, grey when it hasn't, their symbols showing while the
 * pointer is over any of them. Red closes the window (Herzies keeps running
 * in the menu bar), yellow minimises, green toggles the small and big
 * window (greyed out where the window can't change). */
function WindowButtons({
  onZoom,
  zoomed,
}: {
  onZoom?: () => void;
  zoomed?: boolean;
}) {
  const focused = useWindowFocused();
  const button = (
    label: string,
    color: string,
    symbol: React.ReactNode,
    onClick?: () => void,
  ) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!onClick}
      onClick={onClick}
      className={cn(
        "flex size-3 cursor-default items-center justify-center rounded-full border-none p-0",
        "shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.25)]",
        onClick && focused ? color : "bg-white/20",
      )}
    >
      {onClick && (
        <svg
          viewBox="0 0 12 12"
          className="size-3 stroke-black/60 opacity-0 group-hover:opacity-100"
          fill="none"
          strokeWidth={1.2}
          strokeLinecap="round"
          aria-hidden="true"
        >
          {symbol}
        </svg>
      )}
    </button>
  );
  const win = getCurrentWindow();
  return (
    <div className="group flex shrink-0 items-center gap-2">
      {button(
        "Close window",
        "bg-[#ff5f57]",
        <path d="M3.8 3.8l4.4 4.4M8.2 3.8l-4.4 4.4" />,
        () => win.close(),
      )}
      {button("Minimise window", "bg-[#febc2e]", <path d="M3 6h6" />, () =>
        win.minimize(),
      )}
      {button(
        zoomed ? "Smaller window" : "Bigger window",
        "bg-[#28c840]",
        // macOS's full-screen arrows: two corners pointing out to grow,
        // in to shrink (filled, not stroked).
        zoomed ? (
          <path
            d="M5.6 2.6v3h-3zM6.4 9.4v-3h3z"
            className="fill-black/60 stroke-none"
          />
        ) : (
          <path
            d="M3.2 3.2h3.6l-3.6 3.6zM8.8 8.8h-3.6l3.6-3.6z"
            className="fill-black/60 stroke-none"
          />
        ),
        onZoom,
      )}
    </div>
  );
}

/**
 * The window's top bar, frosted over whatever is under it: the window
 * buttons (on macOS, where the native ones are hidden), then your herzie's
 * name, level and class. The bar itself drags the window. It sets
 * --title-bar-height for the layout under it.
 */
export function TitleBar({
  name,
  level,
  classLabel,
  onZoom,
  zoomed,
  className,
}: {
  name?: string;
  level?: number;
  classLabel?: string;
  /** What the green button does; greyed out without it. */
  onZoom?: () => void;
  /** The window is big: the green button shrinks it. */
  zoomed?: boolean;
  className?: string;
}) {
  document.documentElement.style.setProperty(
    "--title-bar-height",
    `${HEIGHT}px`,
  );
  return (
    <div
      data-tauri-drag-region
      data-window-safe
      style={{ height: HEIGHT }}
      className={cn(
        "z-[60] flex cursor-grab items-center gap-3 bg-black/45 px-2 backdrop-blur-md select-none active:cursor-grabbing",
        !IS_MAC && "pl-3",
        className,
      )}
    >
      {IS_MAC && <WindowButtons onZoom={onZoom} zoomed={zoomed} />}
      {name && (
        <div className="pointer-events-none flex min-w-0 items-baseline gap-2 leading-none">
          <span className="min-w-0 truncate text-ui font-bold text-cyan">
            {name}
          </span>
          <span className="shrink-0 whitespace-nowrap text-[10px] text-text-dim">
            Lv. {level}
            {classLabel && ` · ${classLabel}`}
          </span>
        </div>
      )}
    </div>
  );
}
