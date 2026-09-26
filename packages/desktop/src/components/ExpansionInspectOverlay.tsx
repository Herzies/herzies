import { BANK_EXPANSION, ItemPreview } from "@herzies/shared";
import { useEffect } from "react";

/** The Bigger Bag's inspect card. It is not a catalog item, so it has no
 * `ItemPreviewCard` (rarity, sets) — just the spinning bag, title and
 * description, in the same overlay chrome `ItemInspectOverlay` uses. */
export function ExpansionInspectOverlay({
  onClose,
  meta,
  footer,
}: {
  onClose: () => void;
  /** Line under the title, e.g. price and how many are already owned. */
  meta?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-65 max-w-full border border-border bg-bg-panel p-2 text-center shadow-xl shadow-black/50"
      >
        <div className="mb-2 flex justify-center">
          <ItemPreview item={BANK_EXPANSION} box={110} />
        </div>
        <div className="text-sm font-bold">"{BANK_EXPANSION.name}"</div>
        {meta && <div className="my-1 text-ui-sm text-text-dim">{meta}</div>}
        {/* Same size and colour as ItemPreviewCard's description. */}
        <div className="text-ui-sm text-text-dim">
          {BANK_EXPANSION.description}
        </div>
        {footer && (
          <div className="mt-3 flex flex-col items-center gap-2">{footer}</div>
        )}
      </div>
    </div>
  );
}
