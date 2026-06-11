import { Herzie3D, validateName } from "@herzies/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { herzies, useWindowVisible } from "../tauri-bridge";

export function OnboardingScreen({ onClose }: { onClose?: () => void }) {
  const [name, setName] = useState("");
  const [hatching, setHatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
  const visible = useWindowVisible();

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setHatching(true);
    try {
      await herzies.registerHerzie(trimmed);
    } catch (e) {
      setError(typeof e === "string" ? e : "Something went wrong. Try again.");
      setHatching(false);
    }
  }

  return (
    <div
      data-tauri-drag-region
      className="relative flex h-screen flex-col items-center justify-center gap-5 p-6"
    >
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="absolute top-2 right-2 h-[22px] w-[22px] cursor-pointer border border-[#555] bg-transparent p-0 text-xs leading-none text-text-dim"
        >
          ×
        </button>
      )}
      <div className="pointer-events-none opacity-35 grayscale">
        <Herzie3D
          userId={mysterySeed}
          stage={1}
          size={5}
          draggable={false}
          paused={!visible}
          ariaLabel="A mysterious herzie waiting to hatch"
        />
      </div>

      <div className="text-center text-ui text-text-dim">
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
        className="input w-[220px] px-3 py-2 text-center text-ui-lg"
      />

      {(clientError || error) && (
        <div className="text-center text-ui text-red">
          {error ?? clientError}
        </div>
      )}

      <button
        type="button"
        className={cn(
          "btn px-6 py-2 text-ui-lg",
          canSubmit ? "text-green opacity-100" : "text-text-dim opacity-60",
        )}
        disabled={!canSubmit}
        onClick={submit}
      >
        {hatching ? "Hatching..." : "Hatch"}
      </button>
    </div>
  );
}
