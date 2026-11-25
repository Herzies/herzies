import { getItem } from "@herzies/shared";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { assignHotbar, clearHotbar, swapHotbar } from "./hotbarSlots";

// Dragging things onto the hotbar: a card from the bag or the deck
// (InventoryView's own drag), or anything else (useDragToHotbar). While one is
// carried the hotbar rises over open windows, so it can be reached, and lights
// the slot under the cursor. Plain pointer events and `elementFromPoint`, as
// InventoryView's drag: Tauri's webview doesn't reliably deliver HTML5
// drag-and-drop.

/** Marks a hotbar slot's button with its index. */
export const HOTBAR_SLOT_ATTR = "data-hotbar-slot";

/** Whether an item can go on the hotbar: something to eat, or to wear. */
export function hotbarTakes(itemId: string): boolean {
  const def = getItem(itemId);
  return !!def && (!!def.consumable || (!!def.equipable && !!def.equipSlot));
}

/** The hotbar slot at a point, or null. */
export function hotbarSlotAt(x: number, y: number): number | null {
  const el = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>(`[${HOTBAR_SLOT_ATTR}]`);
  return el ? Number(el.getAttribute(HOTBAR_SLOT_ATTR)) : null;
}

/** Something the hotbar takes being carried, and the slot it's over (null
 * when none); null when nothing is. */
export type HotbarDrag = { over: number | null } | null;

let drag: HotbarDrag = null;
const listeners = new Set<() => void>();

export function setHotbarDrag(next: HotbarDrag): void {
  if (next?.over === drag?.over && !next === !drag) return;
  drag = next;
  for (const l of listeners) l();
}

export function useHotbarDrag(): HotbarDrag {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => drag,
  );
}

/** Past this far (px), a press is a drag rather than a click. */
const DRAG_THRESHOLD = 6;

/** What's carried and where the cursor is: for HotbarGhost to draw. */
export type HotbarGhostAt = { value: string; x: number; y: number };

/**
 * Press-and-drag of a hotbar value that isn't a card (a loadout tab, a
 * skill's badge, or a slot of the hotbar itself): `start` it on pointerdown;
 * let go over a slot and the value goes there. Carried from slot `from`, the
 * two slots swap, and let go anywhere off the bar it empties `from`.
 * `ghost` is where to draw what's carried (HotbarGhost). A press that became
 * a drag still ends in a click: `endedDrag()` says so (once), for the click
 * to do nothing.
 */
export function useDragToHotbar(): {
  start: (
    value: string,
    e: React.PointerEvent,
    opts?: { from?: number },
  ) => void;
  ghost: HotbarGhostAt | null;
  endedDrag: () => boolean;
} {
  const [ghost, setGhost] = useState<HotbarGhostAt | null>(null);
  const dragged = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const start = useCallback(
    (value: string, e: React.PointerEvent, opts: { from?: number } = {}) => {
      if (e.button !== 0) return;
      stop.current?.();
      // A new press: whatever the last drag's click was, it's been and gone.
      dragged.current = false;
      const sx = e.clientX;
      const sy = e.clientY;
      let dragging = false;
      const move = (ev: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD)
            return;
          dragging = true;
        }
        setGhost({ value, x: ev.clientX, y: ev.clientY });
        setHotbarDrag({ over: hotbarSlotAt(ev.clientX, ev.clientY) });
      };
      const up = (ev: PointerEvent) => {
        done();
        if (!dragging) return;
        dragged.current = true;
        const over = hotbarSlotAt(ev.clientX, ev.clientY);
        const { from } = opts;
        if (from === undefined) {
          if (over !== null) assignHotbar(over, value);
        } else if (over === null) clearHotbar(from);
        else if (over !== from) swapHotbar(from, over);
      };
      const done = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", done);
        setGhost(null);
        setHotbarDrag(null);
        stop.current = null;
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", done);
      stop.current = done;
    },
    [],
  );

  const endedDrag = useCallback(() => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  }, []);

  return { start, ghost, endedDrag };
}
