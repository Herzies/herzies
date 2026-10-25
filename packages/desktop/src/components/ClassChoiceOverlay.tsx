import {
  CLASS_DEFS,
  CLASS_IDS,
  CLASS_ROLE_LABELS,
  type Equipped,
  type HerzieClass,
} from "@herzies/shared";
import { useState } from "react";
import { useEscape } from "../lib/escapeStack";
import { cn } from "../lib/utils";

/** The class gear as it will be worn: what's worn now, plus the class's
 * items in the hands. */
export function withClassGear(
  equipped: Equipped,
  herzieClass: HerzieClass,
): Equipped {
  const next: Equipped = {
    ...equipped,
    main_hand: undefined,
    off_hand: undefined,
  };
  for (const id of CLASS_DEFS[herzieClass].equipment) {
    if (id === "old-cymbal") next.off_hand = id;
    else next.main_hand = id;
  }
  return next;
}

/**
 * Picking a class, once, at stage 2: a tab per class and its role,
 * then a second ask, since it's for good.
 */
export function ClassChoiceOverlay({
  onChoose,
  onLater,
}: {
  /** Resolves once the server has it; rejects with its message. */
  onChoose: (herzieClass: HerzieClass) => Promise<void>;
  onLater: () => void;
}) {
  const [selected, setSelected] = useState<HerzieClass>("bard");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = CLASS_DEFS[selected];

  useEscape(() => {
    if (busy) return;
    if (confirming) setConfirming(false);
    else onLater();
  });

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      await onChoose(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-1000 flex items-start justify-center overflow-y-auto bg-black/60 pt-6 pb-6"
      data-tauri-drag-region="false"
    >
      <div
        role="dialog"
        aria-labelledby="class-choice-title"
        className="mx-3 w-full max-w-sm border border-white/15 bg-bg-panel px-4 py-3 shadow-lg"
      >
        <div
          id="class-choice-title"
          className="mb-1 text-ui-lg font-bold text-purple"
        >
          Choose a class
        </div>
        <div className="mb-3 text-ui text-text-dim">
          Your herzie has grown arms. What will it play?
        </div>

        <div className="mb-2 grid grid-cols-3 gap-1" role="tablist">
          {CLASS_IDS.map((id) => {
            const c = CLASS_DEFS[id];
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === selected}
                disabled={busy || confirming}
                className={cn(
                  "btn px-1 py-1",
                  id === selected
                    ? "border-purple text-text"
                    : "border-[#555] text-text-dim",
                )}
                onClick={() => setSelected(id)}
              >
                {c.name}
              </button>
            );
          })}
        </div>

        <div className="mb-3 text-ui text-text">
          {CLASS_ROLE_LABELS[def.role]}
        </div>

        {error && <div className="mb-2 text-ui text-red">{error}</div>}

        {confirming ? (
          <div>
            <div className="mb-2 text-ui text-text">
              Become a <span className="font-bold">{def.name}</span>? This is
              for good — a herzie only ever has one class.
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn text-text-dim"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn text-purple"
                disabled={busy}
                onClick={choose}
              >
                {busy ? "Choosing…" : `Become a ${def.name}`}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn text-text-dim"
              onClick={onLater}
            >
              Later
            </button>
            <button
              type="button"
              className="btn text-purple"
              onClick={() => setConfirming(true)}
            >
              Choose {def.name}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
