import { Herzie3D, validateName } from "@herzies/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { herzies, useWindowFocused } from "../tauri-bridge";
import { btnStyle, inputStyle } from "./styles";

export function OnboardingScreen({ onClose }: { onClose?: () => void }) {
  const [name, setName] = useState("");
  const [hatching, setHatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Random seed gives each onboarding session a different silhouette.
  const mysterySeed = useMemo(
    () => `mystery-${Math.random().toString(36).slice(2, 10)}`,
    [],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = name.trim();
  const clientError = trimmed === "" ? null : validateName(trimmed);
  const canSubmit = trimmed !== "" && !clientError && !hatching;
  const focused = useWindowFocused();

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setHatching(true);
    try {
      await herzies.registerHerzie(trimmed);
      // Successful registration emits a state-update; App re-renders with herzie set.
    } catch (e) {
      setError(typeof e === "string" ? e : "Something went wrong. Try again.");
      setHatching(false);
    }
  }

  return (
    <div
      data-tauri-drag-region
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        gap: 20,
        padding: 24,
        position: "relative",
      }}
    >
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            background: "transparent",
            color: "#888",
            border: "1px solid #555",
            width: 22,
            height: 22,
            fontSize: 12,
            lineHeight: 1,
            cursor: "pointer",
            padding: 0,
          }}
        >
          ×
        </button>
      )}
      <div
        style={{
          filter: "grayscale(1)",
          opacity: 0.35,
          pointerEvents: "none",
        }}
      >
        <Herzie3D
          userId={mysterySeed}
          stage={1}
          size={5}
          draggable={false}
          paused={!focused}
          ariaLabel="A mysterious herzie waiting to hatch"
        />
      </div>

      <div style={{ fontSize: 12, color: "#aaa", textAlign: "center" }}>
        Give your herzie a name. They'll grow as you listen to music.
      </div>

      <input
        ref={inputRef}
        type="text"
        placeholder="herzie name"
        maxLength={20}
        value={name}
        disabled={hatching}
        onChange={(e) => {
          setName(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        style={{
          ...inputStyle,
          padding: "8px 12px",
          fontSize: 13,
          textAlign: "center",
          width: 220,
        }}
      />

      {(clientError || error) && (
        <div style={{ fontSize: 11, color: "#f87171", textAlign: "center" }}>
          {error ?? clientError}
        </div>
      )}

      <button
        type="button"
        style={{
          ...btnStyle,
          padding: "8px 24px",
          fontSize: 13,
          color: canSubmit ? "#4ade80" : "#666",
          opacity: canSubmit ? 1 : 0.6,
        }}
        disabled={!canSubmit}
        onClick={submit}
      >
        {hatching ? "Hatching..." : "Hatch"}
      </button>
    </div>
  );
}
