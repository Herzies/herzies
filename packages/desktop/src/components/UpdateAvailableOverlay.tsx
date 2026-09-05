import { PromptOverlay } from "./PromptOverlay";

/**
 * In-app prompt when a new app version is available. "Update now" downloads,
 * installs, and relaunches directly — no extra trip through Settings.
 */
export function UpdateAvailableOverlay({
  version,
  onUpdate,
  onLater,
  installing,
  progress,
  error,
}: {
  version: string;
  onUpdate: () => void;
  onLater: () => void;
  installing: boolean;
  progress?: { downloaded: number; total: number | undefined };
  error?: string;
}) {
  const percent =
    progress?.total && progress.total > 0
      ? Math.round((progress.downloaded / progress.total) * 100)
      : null;

  return (
    <PromptOverlay
      title="Update available"
      titleId="update-available-title"
      onEscape={onLater}
      escapeDisabled={installing}
      actions={[
        {
          label: "Later",
          colour: "text-text-dim",
          onClick: onLater,
        },
        {
          label: error ? "Try again" : "Update now",
          colour: "text-purple",
          onClick: onUpdate,
          busy: installing,
          busyLabel:
            percent !== null ? `Downloading ${percent}%` : "Installing...",
        },
      ]}
    >
      {error ? (
        <>Update failed: {error}</>
      ) : (
        <>
          Version <span className="font-bold text-text">{version}</span> is
          ready to install. Update to get the latest features and fixes.
        </>
      )}
    </PromptOverlay>
  );
}
