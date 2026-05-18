export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: "bold",
        color: "#facc15",
        cursor: "pointer",
      }}
      onClick={onClick}
    >
      ← Back
    </div>
  );
}
