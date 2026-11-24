import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import {
  hotbarKeyRefusal,
  keyLabel,
  resetHotbarKeys,
  setHotbarKey,
  useHotbarKeys,
} from "./town/hotbarKeys";

/** On the slots' grid: a press there isn't "somewhere else". */
const SLOTS_ATTR = "data-hotbar-key-slots";

/** Which key is waiting for a press: slot `i`'s key (0) or second (1). */
type Listening = { i: number; which: 0 | 1 };

/**
 * Settings > Controls: the hotbar's keys, two a slot (1 and Q on the first
 * to begin with). Click one, then press the key you want: a key the game
 * already uses (B for the bag, WASD…) is refused, saying what has it; one
 * another slot has swaps with it. Backspace leaves it without a key, Escape
 * keeps the one it had.
 */
export function HotbarKeySettings() {
  const keys = useHotbarKeys();
  const [listening, setListening] = useState<Listening | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (listening === null) return;
    const { i, which } = listening;
    const stop = () => {
      setListening(null);
      setRefusal(null);
    };
    // Capture, on the window, before anything else hears the key: the Town
    // would use the slot, the app would open a view, Escape close Settings.
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      if (e.code === "Escape") return stop();
      if (e.code === "Backspace" || e.code === "Delete") {
        setHotbarKey(i, which, null);
        return stop();
      }
      const label = keyLabel(e);
      if (e.metaKey || e.ctrlKey || e.altKey) {
        setRefusal("Hotbar keys are single keys, without ⌘, Ctrl or Alt");
        return;
      }
      const why = hotbarKeyRefusal(e.code);
      if (why) {
        setRefusal(`${label} ${why}`);
        return;
      }
      setHotbarKey(i, which, { code: e.code, label });
      stop();
    };
    // A press anywhere but the slots stops listening (on a slot, its click
    // says what happens).
    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.(`[${SLOTS_ATTR}]`)) return;
      stop();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [listening]);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-ui text-text-dim">Hotbar keys</span>
        <button
          type="button"
          className="btn border-[#555] text-text-dim"
          onClick={() => {
            resetHotbarKeys();
            setListening(null);
            setRefusal(null);
          }}
        >
          Reset
        </button>
      </div>
      <div
        {...{ [SLOTS_ATTR]: "" }}
        className="grid grid-cols-2 gap-x-3 gap-y-1"
      >
        {keys.map((pair, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a slot is its place on the bar
          <div key={i} className="flex items-center gap-1.5 text-ui-sm">
            <span className="w-10 shrink-0 text-text-dim">Slot {i + 1}</span>
            {([0, 1] as const).map((which) => {
              const b = pair[which];
              const on = listening?.i === i && listening.which === which;
              return (
                <button
                  key={which}
                  type="button"
                  aria-label={`Hotbar slot ${i + 1}, ${which ? "second key" : "key"}: ${b?.label ?? "none"}`}
                  onClick={() => {
                    setRefusal(null);
                    setListening(on ? null : { i, which });
                  }}
                  className={cn(
                    "min-w-0 flex-1 cursor-pointer truncate rounded border bg-bg-panel px-1 py-0.5 text-center text-ui-sm",
                    on
                      ? "border-cyan text-cyan"
                      : b
                        ? "border-white/15 text-text"
                        : "border-white/10 text-text-dim",
                  )}
                >
                  {on ? "…" : (b?.label ?? "—")}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div
        className={cn(
          "mt-1 text-ui-sm",
          refusal ? "text-red" : "text-text-dim",
        )}
      >
        {refusal ??
          (listening !== null
            ? `Press a key for slot ${listening.i + 1}: Backspace for none, Esc to keep it.`
            : "Two keys a slot: click one to change it. Keys the game already uses can't be taken.")}
      </div>
    </div>
  );
}
