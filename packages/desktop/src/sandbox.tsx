import "./globals.css";
import {
  CLOAK_STYLES,
  type CloakConfig,
  CREATURE_BODY_TYPES,
  CREATURE_PALETTE,
  CREATURE_PARAM_BOUNDS,
  type CreatureParams,
  clearCreatureCache,
  type DangleConfig,
  DEFAULT_DANGLE_CONFIG,
  DEFAULT_THREAD_CONFIG,
  type Equipped,
  earAngleFromDeg,
  earAngleToDeg,
  generateCreatureParams,
  type ThreadConfig,
} from "@herzies/shared";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HerzieWithSky } from "./components/HerzieWithSky";
import { cn } from "./lib/utils";

const WEARABLE_OPTIONS = [
  "headphones",
  "rainbow-headband",
  "gold-chain",
  "pearl-necklace",
  "bowtie",
  "boombox",
  "witch-hat",
  "sixpence",
  "fangs",
  "pumpkin-spice",
  "ghost",
  "blood-moon",
  // Class gear (stage 2 and up: it's held in the hands).
  "lute",
  "compact-discs",
  "worn-stick",
  "old-cymbal",
  // Cloaks (stage 3: worn on the back, under any slung gear).
  "troubadour-mantle",
  "groove-cape",
  "drumhide-cloak",
  "tailwind-cloak",
];

const DEFAULT_USER = "sandbox-user";

function Sandbox() {
  const [userId, setUserId] = useState(DEFAULT_USER);
  const [params, setParams] = useState<CreatureParams>(() =>
    generateCreatureParams(DEFAULT_USER),
  );
  const [stage, setStage] = useState(1);
  const [size, setSize] = useState(5);
  const [animate, setAnimate] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [armed, setArmed] = useState(false);
  const [draggable, setDraggable] = useState(true);
  const [showSky, setShowSky] = useState(false);
  const [wearables, setWearables] = useState<string[]>([]);
  const [dangle, setDangle] = useState<DangleConfig>(DEFAULT_DANGLE_CONFIG);
  const [thread, setThread] = useState<ThreadConfig>(DEFAULT_THREAD_CONFIG);
  // The worn cloak's cloth, to tune: its own until a slider moves.
  const cloakId = wearables.find((id) => id in CLOAK_STYLES);
  const [cloakTuning, setCloakTuning] = useState<{
    id: string;
    config: CloakConfig;
  } | null>(null);
  const cloak =
    cloakId && cloakTuning?.id === cloakId
      ? cloakTuning.config
      : cloakId
        ? CLOAK_STYLES[cloakId].config
        : undefined;
  const tuneCloak = (patch: Partial<CloakConfig>) => {
    if (!cloakId || !cloak) return;
    setCloakTuning({ id: cloakId, config: { ...cloak, ...patch } });
  };
  const swings =
    wearables.includes("gold-chain") || wearables.includes("pearl-necklace");
  const [jsonOpen, setJsonOpen] = useState(false);

  const applySeed = useCallback((id: string) => {
    setParams(generateCreatureParams(id));
    clearCreatureCache();
  }, []);

  useEffect(() => {
    applySeed(userId);
  }, [userId, applySeed]);

  const patch = (partial: Partial<CreatureParams>) => {
    setParams((p) => ({ ...p, ...partial }));
    clearCreatureCache();
  };

  const toggleWearable = (id: string) => {
    setWearables((prev) =>
      prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id],
    );
    clearCreatureCache();
  };

  const randomUserId = () => {
    const id = `user-${Math.random().toString(36).slice(2, 10)}`;
    setUserId(id);
  };

  const exportState = () => ({
    userId,
    stage,
    creatureParams: params,
    ...(swings ? { dangleConfig: dangle } : {}),
  });

  const copyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(exportState(), null, 2));
  };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 max-h-screen w-80 shrink-0 overflow-y-auto border-r border-border bg-bg p-3 text-ui">
        <h1 className="mb-3 text-ui-lg text-purple">herzie sandbox</h1>

        <Section title="identity">
          <Field label="userId (seed)">
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="input w-full"
            />
          </Field>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Btn onClick={() => applySeed(userId)}>re-seed</Btn>
            <Btn onClick={randomUserId}>random id</Btn>
          </div>
        </Section>

        <Section title="body">
          <SelectField
            label="body type"
            value={params.bodyType}
            options={CREATURE_BODY_TYPES.map((t: string, i: number) => ({
              value: i,
              label: t,
            }))}
            onChange={(v) => patch({ bodyType: v })}
          />
          <SliderField
            label="stage"
            value={stage}
            bounds={{ min: 1, max: 3, step: 1 }}
            onChange={(v) => {
              setStage(v);
              clearCreatureCache();
            }}
          />
          <SliderField
            label="body scale"
            value={params.bodyScale}
            bounds={CREATURE_PARAM_BOUNDS.bodyScale}
            onChange={(v) => patch({ bodyScale: v })}
          />
          <SliderField
            label="head ratio"
            value={params.headRatio}
            bounds={CREATURE_PARAM_BOUNDS.headRatio}
            onChange={(v) => patch({ headRatio: v })}
          />
          <SelectField
            label="texture"
            value={params.textureType}
            options={[0, 1, 2, 3].map((n) => ({ value: n, label: String(n) }))}
            onChange={(v) => patch({ textureType: v })}
          />
        </Section>

        <Section title="color">
          <SelectField
            label="palette"
            value={params.colorIndex}
            options={CREATURE_PALETTE.map((hex: string, i: number) => ({
              value: i,
              label: hex,
              swatch: hex,
            }))}
            onChange={(v) => patch({ colorIndex: v })}
          />
        </Section>

        <Section title="face">
          <SliderField
            label="eye spacing"
            value={params.eyeSpacing}
            bounds={CREATURE_PARAM_BOUNDS.eyeSpacing}
            onChange={(v) => patch({ eyeSpacing: v })}
          />
          <SliderField
            label="eye size"
            value={params.eyeSize}
            bounds={CREATURE_PARAM_BOUNDS.eyeSize}
            onChange={(v) => patch({ eyeSize: v })}
          />
          <SliderField
            label="eye height"
            value={params.eyeHeight}
            bounds={CREATURE_PARAM_BOUNDS.eyeHeight}
            onChange={(v) => patch({ eyeHeight: v })}
          />
          <SelectField
            label="ears"
            value={params.earCount}
            options={[
              { value: 0, label: "none" },
              { value: 1, label: "1" },
              { value: 2, label: "2" },
            ]}
            onChange={(v) => patch({ earCount: v })}
          />
          {params.earCount > 0 && (
            <>
              <SliderField
                label="ear angle (°)"
                value={earAngleToDeg(params.earAngle)}
                bounds={CREATURE_PARAM_BOUNDS.earAngleDeg}
                onChange={(v) => patch({ earAngle: earAngleFromDeg(v) })}
              />
              <SliderField
                label="ear length"
                value={params.earLength}
                bounds={CREATURE_PARAM_BOUNDS.earLength}
                onChange={(v) => patch({ earLength: v })}
              />
            </>
          )}
        </Section>

        <Section title="limbs">
          <SliderField
            label="arm length"
            value={params.armLength}
            bounds={CREATURE_PARAM_BOUNDS.armLength}
            onChange={(v) => patch({ armLength: v })}
          />
          <SliderField
            label="leg length"
            value={params.legLength}
            bounds={CREATURE_PARAM_BOUNDS.legLength}
            onChange={(v) => patch({ legLength: v })}
          />
        </Section>

        <Section title="display">
          <SliderField
            label="size (px)"
            value={size}
            bounds={{ min: 2, max: 20, step: 1 }}
            onChange={setSize}
          />
          <Check
            label="animate (rotate)"
            checked={animate}
            onChange={setAnimate}
          />
          <Check
            label="isPlaying (dance)"
            checked={isPlaying}
            onChange={setIsPlaying}
          />
          <Check
            label="armed (gear in hand)"
            checked={armed}
            onChange={setArmed}
          />
          <Check
            label="draggable"
            checked={draggable}
            onChange={setDraggable}
          />
          <Check label="show sky" checked={showSky} onChange={setShowSky} />
          <div className="mt-2">
            wearables:
            {WEARABLE_OPTIONS.map((w) => (
              <Check
                key={w}
                label={w}
                checked={wearables.includes(w)}
                onChange={() => toggleWearable(w)}
              />
            ))}
          </div>
        </Section>

        {swings && (
          <Section title="spin physics">
            <SliderField
              label="stiffness"
              value={dangle.stiffness}
              bounds={{ min: 20, max: 600, step: 5 }}
              onChange={(v) => setDangle((d) => ({ ...d, stiffness: v }))}
            />
            <SliderField
              label="damping"
              value={dangle.damping}
              bounds={{ min: 0, max: 30, step: 0.1 }}
              onChange={(v) => setDangle((d) => ({ ...d, damping: v }))}
            />
            <SliderField
              label="air drag"
              value={dangle.drag}
              bounds={{ min: 0, max: 10, step: 0.1 }}
              onChange={(v) => setDangle((d) => ({ ...d, drag: v }))}
            />
            <SliderField
              label="max swing (rad)"
              value={dangle.maxSwing}
              bounds={{ min: 0.05, max: 1.5, step: 0.01 }}
              onChange={(v) => setDangle((d) => ({ ...d, maxSwing: v }))}
            />
            <SliderField
              label="flare speed (rad/s)"
              value={dangle.flareSpeed}
              bounds={{ min: 1, max: 40, step: 0.5 }}
              onChange={(v) => setDangle((d) => ({ ...d, flareSpeed: v }))}
            />
            <div className="mt-1.5">
              <Btn onClick={() => setDangle(DEFAULT_DANGLE_CONFIG)}>
                reset physics
              </Btn>
            </div>
          </Section>
        )}

        {wearables.includes("compact-discs") && (
          <Section title="disc threads">
            <SliderField
              label="gravity"
              value={thread.gravity}
              bounds={{ min: 2, max: 80, step: 1 }}
              onChange={(v) => setThread((t) => ({ ...t, gravity: v }))}
            />
            <SliderField
              label="damping"
              value={thread.damping}
              bounds={{ min: 0, max: 15, step: 0.1 }}
              onChange={(v) => setThread((t) => ({ ...t, damping: v }))}
            />
            <SliderField
              label="air drag"
              value={thread.drag}
              bounds={{ min: 0, max: 10, step: 0.1 }}
              onChange={(v) => setThread((t) => ({ ...t, drag: v }))}
            />
            <SliderField
              label="response"
              value={thread.response}
              bounds={{ min: 0, max: 1, step: 0.05 }}
              onChange={(v) => setThread((t) => ({ ...t, response: v }))}
            />
            <div className="mt-1.5">
              <Btn onClick={() => setThread(DEFAULT_THREAD_CONFIG)}>
                reset threads
              </Btn>
            </div>
          </Section>
        )}

        {cloakId && cloak && (
          <Section title="cloak cloth">
            {(
              [
                ["gravity", "gravity", 10, 100, 1],
                ["damping", "damping", 0, 8, 0.1],
                ["air drag", "drag", 0, 4, 0.05],
                ["air friction", "airFriction", 0, 1, 0.01],
                ["response (moving)", "linearResponse", 0, 1, 0.05],
                ["response (turning)", "angularResponse", 0, 1, 0.05],
                ["bend (softness)", "bend", 0, 0.004, 0.00005],
                ["shear (softness)", "shear", 0, 0.004, 0.00005],
                ["gather (softness)", "compress", 0, 0.01, 0.0001],
                ["gusts", "turbulence", 0, 1, 0.01],
                ["friction", "friction", 0, 1, 0.01],
                ["edge hug", "hug", 0, 8, 0.1],
              ] as const
            ).map(([label, key, min, max, step]) => (
              <SliderField
                key={key}
                label={label}
                value={cloak[key]}
                bounds={{ min, max, step }}
                onChange={(v) => tuneCloak({ [key]: v })}
              />
            ))}
            <div className="mt-1.5">
              <Btn onClick={() => setCloakTuning(null)}>reset cloak</Btn>
            </div>
          </Section>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Btn onClick={() => setJsonOpen((v) => !v)}>
            {jsonOpen ? "hide json" : "show json"}
          </Btn>
          <Btn onClick={copyJson}>copy json</Btn>
        </div>

        {jsonOpen && (
          <pre className="mt-2 max-h-[200px] overflow-auto rounded border border-border bg-[#111] p-2 text-[10px] text-text-dim">
            {JSON.stringify(exportState(), null, 2)}
          </pre>
        )}
      </aside>

      <main className="flex min-h-screen flex-1 items-center justify-center p-6">
        <HerzieWithSky
          userId={userId}
          stage={stage}
          size={size}
          animate={animate}
          isPlaying={isPlaying}
          armed={armed}
          equipped={toEquipped(wearables)}
          creatureParams={params}
          dangleConfig={dangle}
          threadConfig={thread}
          cloakConfig={cloak}
          showSky={showSky}
          draggable={draggable}
        />
      </main>
    </div>
  );
}

/** The sandbox's wearable checkboxes as equipped slots. */
function toEquipped(ids: string[]): Equipped {
  const out: Equipped = {};
  for (const id of ids) {
    if (
      id === "headphones" ||
      id === "rainbow-headband" ||
      id === "witch-hat" ||
      id === "sixpence"
    )
      out.head = id;
    else if (id === "clouds" || id === "stars" || id === "blood-moon")
      out.scenery = id;
    else if (id === "gold-chain" || id === "pearl-necklace" || id === "bowtie")
      out.body = id;
    else if (id === "fangs") out.face = id;
    else if (id === "pumpkin-spice") out.color = id;
    else if (id === "ghost" || id === "spirit-orb") out.spirit = id;
    else if (id === "old-cymbal") out.off_hand = id;
    else if (
      id.endsWith("-cloak") ||
      id === "troubadour-mantle" ||
      id === "groove-cape"
    )
      out.back = id;
    else if (id === "lute" || id === "compact-discs" || id === "worn-stick")
      out.main_hand = id;
    else if (id === "boombox") {
      if (!out.ground_left) out.ground_left = id;
      else out.ground_right = id;
    }
  }
  return out;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <h2 className="mb-2 text-[10px] tracking-wider text-cyan uppercase">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      <span className="mb-0.5 block text-text-dim">{label}</span>
      {children}
    </div>
  );
}

function SliderField({
  label,
  value,
  bounds,
  onChange,
}: {
  label: string;
  value: number;
  bounds: { min: number; max: number; step: number };
  onChange: (v: number) => void;
}) {
  const decimals = bounds.step < 1 ? 3 : 0;
  return (
    <Field label={`${label}: ${value.toFixed(decimals)}`}>
      <input
        type="range"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </Field>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: { value: number; label: string; swatch?: string }[];
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="input w-full"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.swatch ? `■ ${o.label}` : o.label}
          </option>
        ))}
      </select>
      {options[value]?.swatch && (
        <span
          className="ml-2 inline-block h-3.5 w-3.5 align-middle border border-[#444]"
          style={{ background: options[value].swatch }}
        />
      )}
    </Field>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="mt-1 block cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />{" "}
      {label}
    </label>
  );
}

function Btn({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded border border-[#444] bg-bg-panel px-2 py-1 text-ui text-purple font-mono"
    >
      {children}
    </button>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Sandbox />);
