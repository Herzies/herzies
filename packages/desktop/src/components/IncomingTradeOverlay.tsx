import { useEffect, useRef } from "react";
import type { PendingTradeRequest } from "../tauri-bridge";

/**
 * In-app prompt when a trade request arrives. macOS often suppresses notification
 * banners while this window is focused; this overlay stays visible on any tab.
 */
export function IncomingTradeOverlay({
  request,
  busy,
  onJoin,
  onIgnore,
}: {
  request: PendingTradeRequest;
  busy: "join" | "ignore" | null;
  onJoin: () => void;
  onIgnore: () => void;
}) {
  const onIgnoreRef = useRef(onIgnore);
  const busyRef = useRef(busy);
  onIgnoreRef.current = onIgnore;
  busyRef.current = busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && busyRef.current === null) {
        onIgnoreRef.current();
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
        aria-labelledby="incoming-trade-title"
        className="mx-3 w-full max-w-sm border border-border bg-bg-panel px-4 py-3 shadow-lg"
      >
        <div
          id="incoming-trade-title"
          className="mb-1 text-ui-lg font-bold text-purple"
        >
          Trade request
        </div>
        <p className="mb-3 text-ui text-text">
          <span className="font-bold text-text">{request.fromName}</span> wants
          to trade with you.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn text-text-dim"
            disabled={busy !== null}
            onClick={onIgnore}
          >
            {busy === "ignore" ? "Declining…" : "Ignore"}
          </button>
          <button
            type="button"
            className="btn text-purple"
            disabled={busy !== null}
            onClick={onJoin}
          >
            {busy === "join" ? "Opening…" : "Join trade"}
          </button>
        </div>
      </div>
    </div>
  );
}
