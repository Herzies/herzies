import { useEffect, useRef } from "react";

/** What the player is asking for this frame. Read by the game loop; written
 * only by the listeners below. */
export type TownInput = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  /** Arrow keys: orbit the camera left/right, tilt it up/down. */
  turnLeft: boolean;
  turnRight: boolean;
  tiltUp: boolean;
  tiltDown: boolean;
  /** Shift held: run. */
  sprint: boolean;
  /** Mouse buttons held over the world. */
  mouseLeft: boolean;
  mouseRight: boolean;
  /** Space pressed: hop. A press, not a hold — whoever acts on it clears it. */
  jump: boolean;
};

const MOVE_KEYS: Record<string, keyof TownInput> = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  ArrowLeft: "turnLeft",
  ArrowRight: "turnRight",
  ArrowUp: "tiltUp",
  ArrowDown: "tiltDown",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
};

/** Whoever holds keys down now lets go of them (the boss's end screen
 * coming up over the Town: nobody walks on under it). */
const letGoListeners = new Set<() => void>();
export function letGoOfTownInput(): void {
  for (const l of letGoListeners) l();
}

const idle = (): TownInput => ({
  forward: false,
  back: false,
  left: false,
  right: false,
  turnLeft: false,
  turnRight: false,
  tiltUp: false,
  tiltDown: false,
  sprint: false,
  mouseLeft: false,
  mouseRight: false,
  jump: false,
});

/**
 * Keyboard and mouse state for walking around the Town.
 *
 * drei's KeyboardControls would cover the key map, but not the two things a
 * game inside an app needs: keys typed into the chat (or any field) must
 * not walk the herzie, and keys held when the window loses focus must not
 * stay held. Both are handled here. Listens only while `active`.
 *
 * `onInteract` fires on E; Space raises `jump`, for the game loop to clear. `surface` is the element mouse buttons count on
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
      // Tab is the game's (it starts a fight on the training grounds), not the
      // browser's: don't let it walk focus along the buttons and links. In
      // a text field it still moves between fields.
      if (e.code === "Tab" && !typing(e.target)) e.preventDefault();
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.code === "KeyE" && !e.repeat) {
        interact.current();
        return;
      }
      // Space would click whatever button has focus (or scroll): it's the
      // jump key here.
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) input.current.jump = true;
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
      if (e.button === 0 || e.buttons & 1) input.current.mouseLeft = true;
      if (e.button === 2 || e.buttons & 2) input.current.mouseRight = true;
    };
    // A second button pressed (or let go) while another is held fires no
    // pointerdown/up of its own — only a pointermove with `buttons` changed —
    // so once a press has started on the surface, follow `buttons` itself.
    const onPointerChange = (e: PointerEvent) => {
      const i = input.current;
      if (!i.mouseLeft && !i.mouseRight) return;
      i.mouseLeft = (e.buttons & 1) !== 0;
      i.mouseRight = (e.buttons & 2) !== 0;
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
    window.addEventListener("pointerup", onPointerChange);
    window.addEventListener("pointermove", onPointerChange);
    window.addEventListener("blur", release);
    letGoListeners.add(release);
    document.addEventListener("visibilitychange", onVisibility);
    surface?.addEventListener("pointerdown", onPointerDown);
    surface?.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerChange);
      window.removeEventListener("pointermove", onPointerChange);
      window.removeEventListener("blur", release);
      letGoListeners.delete(release);
      document.removeEventListener("visibilitychange", onVisibility);
      surface?.removeEventListener("pointerdown", onPointerDown);
      surface?.removeEventListener("contextmenu", onContextMenu);
      release();
    };
  }, [active, surface]);

  return input;
}
