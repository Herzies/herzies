import { cn } from "../lib/utils";

/** The strip's height: the gap above the top cards, so it never covers
 * them (the name on Home's card is a button). */
const HEIGHT = 12;

/**
 * A strip across the window's top that drags it (the window has no native
 * title bar), with a small grab handle in the middle to say it's there. The
 * handle ignores the mouse, so the press lands on the strip, which carries
 * the drag attribute (Tauri only drags from the element that has it). It
 * takes no room: --title-bar-height is 0, so the cards keep the same 12px
 * from the top as from the side.
 */
export function TitleBar({ className }: { className?: string }) {
  document.documentElement.style.setProperty("--title-bar-height", "0px");
  return (
    <div
      data-tauri-drag-region
      data-window-safe
      style={{ height: HEIGHT }}
      className={cn(
        "group z-[60] flex cursor-grab justify-center select-none active:cursor-grabbing",
        className,
      )}
    >
      <div className="pointer-events-none mt-1 h-[3px] w-9 rounded-full bg-white/20 transition-colors group-hover:bg-white/45" />
    </div>
  );
}
