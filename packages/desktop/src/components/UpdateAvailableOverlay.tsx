import { PromptOverlay } from "./PromptOverlay";

/**
 * In-app prompt when a new app version is available.
 */
export function UpdateAvailableOverlay({
  version,
  onUpdate,
  onLater,
}: {
  version: string;
  onUpdate: () => void;
  onLater: () => void;
}) {
  return (
    <PromptOverlay
      title="Update available"
      titleId="update-available-title"
      onEscape={onLater}
      actions={[
        {
          label: "Later",
          colour: "text-text-dim",
          onClick: onLater,
        },
        {
          label: "Update now",
          colour: "text-purple",
          onClick: onUpdate,
        },
      ]}
    >
      Version <span className="font-bold text-text">{version}</span> is ready to
      install. Update to get the latest features and fixes.
    </PromptOverlay>
  );
}
