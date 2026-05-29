import type { PendingFriendRequest } from "../tauri-bridge";
import { PromptOverlay } from "./PromptOverlay";

/**
 * In-app prompt when a friend request arrives. Dismissing without responding
 * leaves the request in the Friends → Requests tab.
 */
export function IncomingFriendOverlay({
  request,
  busy,
  onAccept,
  onDecline,
  onDismiss,
}: {
  request: PendingFriendRequest;
  busy: "accept" | "decline" | null;
  onAccept: () => void;
  onDecline: () => void;
  onDismiss: () => void;
}) {
  return (
    <PromptOverlay
      title="Friend request"
      titleId="incoming-friend-title"
      onEscape={onDismiss}
      escapeDisabled={busy !== null}
      actions={[
        {
          label: "Decline",
          colour: "text-text-dim",
          onClick: onDecline,
          busy: busy === "decline",
          busyLabel: "Declining…",
        },
        {
          label: "Accept",
          colour: "text-green",
          onClick: onAccept,
          busy: busy === "accept",
          busyLabel: "Adding…",
        },
      ]}
    >
      <span className="font-bold text-text">{request.fromName}</span> wants to be
      your friend.
    </PromptOverlay>
  );
}
