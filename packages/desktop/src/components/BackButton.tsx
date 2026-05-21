export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <div
      className="text-ui-lg font-bold text-yellow cursor-pointer"
      onClick={onClick}
    >
      ← Back
    </div>
  );
}
