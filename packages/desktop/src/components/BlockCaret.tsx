import { type RefObject, useCallback, useLayoutEffect, useState } from "react";

let measureCtx: CanvasRenderingContext2D | null = null;
/** The width `text` takes in `input`'s font. */
function textWidth(input: HTMLInputElement, text: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  const style = getComputedStyle(input);
  measureCtx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return measureCtx.measureText(text).width;
}

/**
 * A blinking block cursor for a borderless input, a terminal's in place of
 * the thin native caret (give the input `caret-transparent`). Shown while
 * the input is focused with nothing selected.
 *
 * Spread `handlers` on the input, and render `<BlockCaret x={x} />` in a
 * `relative` wrapper around it.
 */
export function useBlockCaret(
  inputRef: RefObject<HTMLInputElement | null>,
  value: string,
) {
  const [x, setX] = useState<number | null>(null);
  const update = useCallback(() => {
    const input = inputRef.current;
    if (!input || document.activeElement !== input) {
      setX(null);
      return;
    }
    const start = input.selectionStart ?? input.value.length;
    if (start !== input.selectionEnd) {
      setX(null);
      return;
    }
    const pad = Number.parseFloat(getComputedStyle(input).paddingLeft) || 0;
    setX(
      input.offsetLeft +
        pad +
        textWidth(input, input.value.slice(0, start)) -
        input.scrollLeft,
    );
  }, [inputRef]);
  // Typed, pasted or set by code (autocomplete): the caret has moved. After
  // the browser has placed it, a frame on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value moves the caret
  useLayoutEffect(() => {
    update();
    const frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [value, update]);
  const handlers = {
    onFocus: update,
    onBlur: () => setX(null),
    onSelect: update,
    onKeyUp: update,
    onMouseUp: update,
    onScroll: update,
  };
  return { x, handlers };
}

export function BlockCaret({ x }: { x: number | null }) {
  if (x === null) return null;
  return (
    // Re-keyed on each move, so the blink restarts lit: a caret that moves
    // stays visible while it moves, as a native one does.
    <span
      key={x}
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 h-[1.2em] w-[0.6em] -translate-y-1/2 animate-blink bg-cyan/80 text-[10px]"
      style={{ left: x }}
    />
  );
}
