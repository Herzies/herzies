import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "../lib/escapeStack";
import { NumberTicker } from "./NumberTicker";

/**
 * "How many?": buying a stack at an NPC, offering copies in a trade. A small
 * box in the middle of the screen with a ticker, whatever `total` says the
 * chosen amount comes to, and Cancel / confirm.
 */
export function QuantityModal({
  max,
  initial = 1,
  confirmLabel,
  busy = false,
  busyLabel,
  total,
  onConfirm,
  onCancel,
}: {
  /** The most that can be chosen (at least 1). */
  max: number;
  initial?: number;
  confirmLabel: string;
  busy?: boolean;
  busyLabel?: string;
  /** What `n` comes to, shown under the ticker (a price, say). */
  total?: (n: number) => ReactNode;
  onConfirm: (n: number) => void;
  onCancel: () => void;
}) {
  const top = Math.max(1, max);
  const [n, setN] = useState(Math.min(Math.max(1, initial), top));
  useEscape(() => {
    if (!busy) onCancel();
  });

  // At the document's top level, one above the item inspect overlay (also
  // portalled, z-1000), so buying from an inspected card puts this on top.
  return createPortal(
    <div
      className="pointer-events-auto fixed inset-0 z-1001 flex items-center justify-center bg-black/30"
      data-tauri-drag-region="false"
    >
      <div
        role="dialog"
        aria-label="How many"
        className="flex w-[200px] flex-col gap-2 border border-white/15 bg-bg-panel p-3 shadow-lg"
      >
        {/* Not a form: the ticker's buttons have no type, so they'd submit
            it. Enter in the box confirms instead. */}
        <fieldset
          aria-label="How many"
          className="m-0 flex items-center gap-1 border-none p-0"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) onConfirm(n);
          }}
        >
          <NumberTicker
            value={n}
            min={1}
            max={top}
            onChange={setN}
            size="small"
            fullWidth
          />
        </fieldset>
        {total && (
          <div className="text-center text-[10px] text-text-dim">
            {total(n)}
          </div>
        )}
        <div className="flex justify-end gap-1">
          <button
            type="button"
            className="btn text-ui-sm text-text-dim"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn text-ui-sm text-green"
            disabled={busy}
            onClick={() => onConfirm(n)}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
