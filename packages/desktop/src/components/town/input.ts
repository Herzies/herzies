import { useEffect, useRef } from "react";

/** What the player is asking for this frame. Read by the game loop; written
 * only by the listeners below. */
export type TownInput = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  /** Mouse buttons held over the world. */
  mouseLeft: boolean;
  mouseRight: boolean;
};

const MOVE_KEYS: Record<string, keyof TownInput> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "back",
  ArrowDown: "back",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
};

const idle = (): TownInput => ({
  forward: false,
  back: false,
  left: false,
  right: false,
  mouseLeft: false,
  mouseRight: false,
});

/**
 * Keyboard and mouse state for walking around the Town.
 *
 * drei's KeyboardControls would cover the key map, but not the two things a
 * game inside an app needs: keys typed into the chat (or any field) must
 * not walk the herzie, and keys held when the window loses focus must not
 * stay held. Both are handled here. Listens only while `active`.
 *
 * `onInteract` fires on E. `surface` is the element mouse buttons count on
 * (the canvas); button releases are caught anywhere, since the camera
 * captures the pointer mid-drag.
 */
export function useTownInput(
  active: boolean,
  surface: HTMLElement | null,
  onInteract: () => void,
) {
  const input = useRef<TownInput>(idle());
  const interact = useRef(onInteract);
  interact.current = onInteract;

  useEffect(() => {
    if (!active) {
      Object.assign(input.current, idle());
      return;
    }
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return (
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.code === "KeyE" && !e.repeat) {
        interact.current();
        return;
      }
      const action = MOVE_KEYS[e.code];
      if (!action) return;
      e.preventDefault();
      input.current[action] = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const action = MOVE_KEYS[e.code];
      if (action) input.current[action] = false;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0) input.current.mouseLeft = true;
      if (e.button === 2) input.current.mouseRight = true;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button === 0) input.current.mouseLeft = false;
      if (e.button === 2) input.current.mouseRight = false;
    };
    // The right button is the steering button, not a menu.
    const onContextMenu = (e: Event) => e.preventDefault();
    // Mutated in place: the game loop holds on to this object.
    const release = () => {
      Object.assign(input.current, idle());
    };
    const onVisibility = () => {
      if (document.hidden) release();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    surface?.addEventListener("pointerdown", onPointerDown);
    surface?.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
      surface?.removeEventListener("pointerdown", onPointerDown);
      surface?.removeEventListener("contextmenu", onContextMenu);
      release();
    };
  }, [active, surface]);

  return input;
}
