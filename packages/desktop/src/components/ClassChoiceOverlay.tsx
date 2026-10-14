import {
  CLASS_DEFS,
  CLASS_IDS,
  CLASS_ROLE_LABELS,
  describeSkill,
  type Equipped,
  type HerzieClass,
  SKILL_DEFS,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils";

/** The class gear as it will be worn: what's worn now, plus the class's
 * items in the hands. */
export function withClassGear(
  equipped: Equipped,
  herzieClass: HerzieClass,
): Equipped {
  const next: Equipped = {
    ...equipped,
    main_hand: undefined,
    off_hand: undefined,
  };
  for (const id of CLASS_DEFS[herzieClass].equipment) {
    if (id === "old-cymbal") next.off_hand = id;
    else next.main_hand = id;
  }
  return next;
}

const ROLE_COLOURS: Record<string, string> = {
  support: "text-pink",
  dps: "text-cyan",
  tank: "text-yellow",
};

/**
 * Picking a class, once, at stage 2. Shows the herzie holding each class's
 * gear, with the skill it starts with, before asking; then asks again,
 * since it's for good.
 */
export function ClassChoiceOverlay({
  userId,
  stage,
  equipped,
  onChoose,
  onLater,
}: {
  userId: string;
  stage: number;
  equipped: Equipped;
  /** Resolves once the server has it; rejects with its message. */
  onChoose: (herzieClass: HerzieClass) => Promise<void>;
  onLater: () => void;
}) {
  const [selected, setSelected] = useState<HerzieClass>("bard");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = CLASS_DEFS[selected];
  const skill = SKILL_DEFS[def.starterSkill];
  const preview = useMemo(
    () => withClassGear(equipped, selected),
    [equipped, selected],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      if (confirming) setConfirming(false);
      else onLater();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, confirming, onLater]);

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      await onChoose(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-1000 flex items-start justify-center overflow-y-auto bg-black/60 pt-6 pb-6"
      data-tauri-drag-region="false"
    >
      <div
        role="dialog"
        aria-labelledby="class-choice-title"
        className="mx-3 w-full max-w-sm border border-border bg-bg-panel px-4 py-3 shadow-lg"
      >
        <div
          id="class-choice-title"
          className="mb-1 text-ui-lg font-bold text-purple"
        >
          Choose a class
        </div>
        <div className="mb-3 text-ui text-text-dim">
          Your herzie has grown arms. What will it play?
        </div>

        <div className="mb-2 grid grid-cols-3 gap-1" role="tablist">
          {CLASS_IDS.map((id) => {
            const c = CLASS_DEFS[id];
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === selected}
                disabled={busy || confirming}
                className={cn(
                  "btn flex flex-col items-center px-1 py-1",
                  id === selected
                    ? "border-purple text-text"
                    : "border-[#555] text-text-dim",
                )}
                onClick={() => setSelected(id)}
              >
                <span className="text-ui-lg">{c.emoji}</span>
                <span className="text-ui">{c.name}</span>
              </button>
            );
          })}
        </div>

        <div className="relative mb-2 flex h-48 items-center justify-center overflow-hidden border border-border">
          <SkillDemo skill={def.starterSkill} />
          <HerzieView
            userId={userId}
            stage={stage}
            size={3.2}
            equipped={preview}
            draggable={false}
            ariaLabel={`Your herzie as a ${def.name}`}
          />
        </div>

        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-ui font-bold text-text">
            {def.emoji} {def.name}
          </span>
          <span className={cn("text-ui", ROLE_COLOURS[def.role])}>
            {CLASS_ROLE_LABELS[def.role]}
          </span>
        </div>
        <div className="mb-2 text-ui text-text">{def.blurb}</div>
        <div className="mb-3 border border-border px-2 py-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-ui font-bold text-purple">{skill.name}</span>
            <span className="text-ui text-text-dim">
              Lv. 1 · {skill.cooldownMs / 1000}s cooldown
            </span>
          </div>
          <div className="text-ui text-text">{describeSkill(skill.id, 1)}</div>
          <div className="mt-0.5 text-ui text-text-dim">
            Grows to Lv. 10 as it's used in boss fights:{" "}
            {describeSkill(skill.id, 10).toLowerCase()}
          </div>
        </div>

        {error && <div className="mb-2 text-ui text-red">{error}</div>}

        {confirming ? (
          <div>
            <div className="mb-2 text-ui text-text">
              Become a <span className="font-bold">{def.name}</span>? This is
              for good — a herzie only ever has one class.
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn text-text-dim"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn text-purple"
                disabled={busy}
                onClick={choose}
              >
                {busy ? "Choosing…" : `Become a ${def.name}`}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn text-text-dim"
              onClick={onLater}
            >
              Later
            </button>
            <button
              type="button"
              className="btn text-purple"
              onClick={() => setConfirming(true)}
            >
              Choose {def.name}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A looping sketch of the skill behind the herzie: drones pulse outward,
 * discs fly, the cymbal hangs overhead. CSS only (globals.css). */
function SkillDemo({ skill }: { skill: string }) {
  if (skill === "soothing-drones") {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="class-demo-drone"
            style={{ animationDelay: `${i * 0.6}s` }}
          />
        ))}
      </div>
    );
  }
  if (skill === "backspin") {
    return (
      <div className="pointer-events-none absolute inset-0">
        {[-1, 0, 1].map((i) => (
          <span
            key={i}
            className="class-demo-disc"
            style={{ ["--spread" as string]: `${i * 22}px` }}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="pointer-events-none absolute inset-0 flex justify-center">
      <span className="class-demo-cymbal" />
    </div>
  );
}
