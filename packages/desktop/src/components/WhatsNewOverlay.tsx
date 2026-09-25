import { PromptOverlay } from "./PromptOverlay";

/** Shown once per version, after an update, listing what changed. */
export function WhatsNewOverlay({
  version,
  highlights,
  onClose,
}: {
  version: string;
  highlights: string[];
  onClose: () => void;
}) {
  return (
    <PromptOverlay
      title={`New in version ${version}`}
      titleId="whats-new-title"
      onEscape={onClose}
      actions={[{ label: "Got it", colour: "text-purple", onClick: onClose }]}
    >
      <ul className="max-h-64 list-disc space-y-1 overflow-y-auto pl-4">
        {highlights.map((highlight) => (
          <li key={highlight}>{highlight}</li>
        ))}
      </ul>
      {/* Outside the scrolling list so the sign-off is always in view. */}
      <p className="mt-3 text-text-dim">
        Happy listening,
        <br />
        music_lover69
      </p>
    </PromptOverlay>
  );
}
