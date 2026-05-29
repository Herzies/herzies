import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "../lib/utils";

export interface PromptAction {
  label: string;
  onClick: () => void;
  /** Tailwind text-colour class for the button label (e.g. "text-purple"). */
  colour?: string;
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
}

/**
 * Full-screen prompt dialog used for incoming requests (trades, friends, ...).
 * macOS often suppresses notification banners while this window is focused, so
 * the overlay stays visible on any tab until the user responds.
 */
export function PromptOverlay({
  title,
  titleId,
  children,
  actions,
  onEscape,
  escapeDisabled = false,
}: {
  title: string;
  titleId: string;
  children: ReactNode;
  actions: PromptAction[];
  onEscape?: () => void;
  escapeDisabled?: boolean;
}) {
  const onEscapeRef = useRef(onEscape);
  const escapeDisabledRef = useRef(escapeDisabled);
  onEscapeRef.current = onEscape;
  escapeDisabledRef.current = escapeDisabled;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !escapeDisabledRef.current) {
        onEscapeRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-1000 flex items-start justify-center bg-black/45 pt-6"
      data-tauri-drag-region="false"
    >
      <div
        role="dialog"
        aria-labelledby={titleId}
        className="mx-3 w-full max-w-sm border border-border bg-bg-panel px-4 py-3 shadow-lg"
      >
        <div id={titleId} className="mb-1 text-ui-lg font-bold text-purple">
          {title}
        </div>
        <div className="mb-3 text-ui text-text">{children}</div>
        <div className="flex flex-wrap justify-end gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={cn("btn", action.colour ?? "text-text")}
              disabled={action.disabled ?? actions.some((a) => a.busy)}
              onClick={action.onClick}
            >
              {action.busy ? (action.busyLabel ?? action.label) : action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
