import type { PendingTradeRequest } from "../tauri-bridge";
import { PromptOverlay } from "./PromptOverlay";

/**
 * In-app prompt when a trade request arrives.
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
  return (
    <PromptOverlay
      title="Trade request"
      titleId="incoming-trade-title"
      onEscape={onIgnore}
      escapeDisabled={busy !== null}
      actions={[
        {
          label: "Ignore",
          colour: "text-text-dim",
          onClick: onIgnore,
          busy: busy === "ignore",
          busyLabel: "Declining…",
        },
        {
          label: "Join trade",
          colour: "text-purple",
          onClick: onJoin,
          busy: busy === "join",
          busyLabel: "Opening…",
        },
      ]}
    >
      <span className="font-bold text-text">{request.fromName}</span> wants to
      trade with you.
    </PromptOverlay>
  );
}
