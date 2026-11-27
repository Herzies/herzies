import "./globals.css";
import {
  CLASS_DEFS,
  CLASS_IDS,
  CLASS_ROLE_LABELS,
  type HerzieClass,
} from "@herzies/shared";
import { AWARD_ROLES, pickAwardWinners } from "@herzies/shared/combat";
import { HerzieStage } from "@herzies/shared/gl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AwardsCard } from "./components/town/AwardsCard";
import type { BossResults } from "./components/town/combat/results";
import { setSfxMuted } from "./components/town/sfx";
import { followTownLook } from "./lib/overlayStage";
import { cn } from "./lib/utils";
import {
  awardResults,
  type Fighter,
  type FightRanks,
  maxHpFor,
  rankFight,
  roleOf,
  SCENARIOS,
} from "./raid-results-model";

/**
 * Dev only (`vite dev`, /raid-results-preview.html): the raid's end screen
 * (AwardsCard) as a fight would hand it out, drawn at every screen the Town
 * shows it at, at its real size. The roster's numbers can be edited in
 * place; the awards follow the game's own scoring (rankAwards,
 * pickAwardWinners). Settings stay across reloads.
 */

/** The Town's screens the end screen fills, in CSS px, less the 28 px
 * title bar where there is one (tray.rs TOWN_SIZE, SMALL_SIZE). */
const FRAMES = [
  {
    id: "small",
    label: "Small window",
    w: 380,
    h: 520,
    note: "380×548 window",
  },
  { id: "big", label: "Big window", w: 1024, h: 700, note: "1024×728 window" },
  {
    id: "full13",
    label: "Full screen 13″",
    w: 1470,
    h: 956,
    note: "MacBook Air 13″",
  },
  {
    id: "full1080",
    label: "Full screen 1080p",
    w: 1920,
    h: 1080,
    note: "1920×1080 display",
  },
] as const;

type State = {
  scenario: string;
  roster: Fighter[];
  you: number;
  outcome: BossResults["outcome"];
  herzies: boolean;
  frames: string[];
  /** The award stings (the Town's sound effects, off by default). */
  sound: boolean;
};

/** Bumped when State changes shape: older saves are dropped. */
const KEY = "raid-results-preview-4";

function fromScenario(
  id: string,
): Pick<State, "scenario" | "roster" | "you" | "outcome"> {
  const s = SCENARIOS.find((x) => x.id === id) ?? SCENARIOS[0];
  return {
    scenario: s.id,
    roster: s.roster.map((f) => ({ ...f })),
    you: s.you,
    outcome: s.outcome,
  };
}

const DEFAULTS: State = {
  ...fromScenario(SCENARIOS[0].id),
  herzies: true,
  frames: ["small", "big", "full13"],
  sound: false,
};

function load(): State {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && typeof saved === "object") return { ...DEFAULTS, ...saved };
  } catch {
    // Defaults, then.
  }
  return DEFAULTS;
}

function Preview() {
  const [state, setState] = useState(load);
  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(state));
  }, [state]);
  const set = (patch: Partial<State>) => setState((s) => ({ ...s, ...patch }));
  useEffect(() => setSfxMuted(!state.sound), [state.sound]);
  // Bumped to hand the awards out again.
  const [replay, setReplay] = useState(0);

  const ranks = useMemo(() => rankFight(state.roster), [state.roster]);
  const results = useMemo(
    () => awardResults(state.roster, ranks, state.you, state.outcome),
    [state.roster, ranks, state.you, state.outcome],
  );

  return (
    <div className="flex h-screen text-ui text-text">
      <Controls
        state={state}
        set={set}
        reset={() => setState(DEFAULTS)}
        onReplay={() => setReplay((n) => n + 1)}
      />
      <main className="min-w-0 flex-1 overflow-auto p-4">
        <Roster state={state} set={set} ranks={ranks} />
        <div className="mt-6 flex flex-col gap-6">
          {FRAMES.filter((f) => state.frames.includes(f.id)).map((f) => (
            <section key={f.id}>
              <h3 className="mb-1.5 text-text-dim">
                <span className="text-text">{f.label}</span> · {f.w}×{f.h} ·{" "}
                {f.note}
              </h3>
              <Frame
                // A new fight or a replay starts the show over.
                key={`${f.id}:${state.scenario}:${replay}`}
                w={f.w}
                h={f.h}
                results={results}
                herzies={state.herzies}
              />
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

function Controls({
  state,
  set,
  reset,
  onReplay,
}: {
  state: State;
  set: (p: Partial<State>) => void;
  reset: () => void;
  /** Hand the awards out again. */
  onReplay: () => void;
}) {
  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r border-white/10 bg-bg-panel p-3">
      <h1 className="text-ui-lg font-bold">Raid results</h1>

      <Group title="Fight">
        <select
          className="input w-full bg-bg"
          value={state.scenario}
          onChange={(e) => set(fromScenario(e.target.value))}
        >
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <Choice
          value={state.outcome}
          options={[
            ["victory", "Victory"],
            ["defeat", "Defeat"],
          ]}
          onChange={(outcome) => set({ outcome })}
        />
      </Group>

      <Group title="Screens">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.sound}
              onChange={(e) => set({ sound: e.target.checked })}
            />
            Sound
          </label>
          <button type="button" className="btn ml-auto" onClick={onReplay}>
            Replay the show
          </button>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={state.herzies}
            onChange={(e) => set({ herzies: e.target.checked })}
          />
          Draw the winners' herzies
        </label>
        <div className="flex flex-col gap-1">
          {FRAMES.map((f) => (
            <label key={f.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={state.frames.includes(f.id)}
                onChange={(e) =>
                  set({
                    frames: e.target.checked
                      ? [...state.frames, f.id]
                      : state.frames.filter((x) => x !== f.id),
                  })
                }
              />
              {f.label}
            </label>
          ))}
        </div>
      </Group>

      <div className="flex gap-2">
        <button type="button" className="btn" onClick={reset}>
          Reset all
        </button>
      </div>
    </aside>
  );
}

/** The roster, its numbers editable, and where each lands in each role
 * (★: that role's winner). */
function Roster({
  state,
  set,
  ranks,
}: {
  state: State;
  set: (p: Partial<State>) => void;
  ranks: FightRanks;
}) {
  const winners = pickAwardWinners(ranks);
  const maxHp = maxHpFor(state.roster);
  const edit = (i: number, patch: Partial<Fighter>) =>
    set({
      roster: state.roster.map((f, j) => (j === i ? { ...f, ...patch } : f)),
    });
  const remove = (i: number) =>
    set({
      roster: state.roster.filter((_, j) => j !== i),
      you: state.you === i ? 0 : state.you > i ? state.you - 1 : state.you,
    });
  const add = () =>
    set({
      roster: [
        ...state.roster,
        {
          name: `Herzie ${state.roster.length + 1}`,
          cls: "record_slinger",
          damage: 150_000,
          adds: 0,
          healed: 0,
          blocked: 0,
          heldSec: 0,
        },
      ],
    });
  const num = (i: number, key: keyof Fighter, step: number) => (
    <input
      type="number"
      className="input w-[5.5rem] px-1 text-right tabular-nums"
      step={step}
      min={0}
      value={state.roster[i][key] as number}
      onChange={(e) =>
        edit(i, { [key]: Math.max(0, Number(e.target.value) || 0) })
      }
    />
  );
  const total = state.roster.reduce((n, f) => n + f.damage, 0);
  return (
    <div>
      <p className="mb-2 text-text-dim">
        Boss health {maxHp.toLocaleString()} for {state.roster.length} · boss
        damage dealt {total.toLocaleString()} (
        {Math.round((total / maxHp) * 100)}%). Hover a name on a screen for what
        it did.
      </p>
      <table className="border-separate border-spacing-x-1.5 border-spacing-y-0.5 whitespace-nowrap">
        <thead className="text-ui-sm text-text-dim">
          <tr>
            <th className="font-normal">You</th>
            <th className="text-left font-normal">Herzie</th>
            <th className="text-left font-normal">Class</th>
            <th className="text-right font-normal">Boss dmg</th>
            <th className="text-right font-normal">Minions</th>
            <th className="text-right font-normal">Held (s)</th>
            <th className="text-right font-normal">Blocked</th>
            <th className="text-right font-normal">Healed</th>
            {AWARD_ROLES.map((r) => (
              <th key={r} className="text-right font-normal">
                {CLASS_ROLE_LABELS[r]}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {state.roster.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, names included
            <tr key={i}>
              <td className="text-center">
                <input
                  type="radio"
                  name="you"
                  checked={state.you === i}
                  onChange={() => set({ you: i })}
                />
              </td>
              <td>
                <input
                  className="input w-40 px-1"
                  value={f.name}
                  onChange={(e) => edit(i, { name: e.target.value })}
                />
              </td>
              <td>
                <select
                  className="input bg-bg px-1"
                  value={f.cls}
                  onChange={(e) =>
                    edit(i, { cls: e.target.value as HerzieClass })
                  }
                >
                  {CLASS_IDS.map((c) => (
                    <option key={c} value={c}>
                      {CLASS_DEFS[c].name}
                    </option>
                  ))}
                </select>
              </td>
              <td>{num(i, "damage", 1000)}</td>
              <td>{num(i, "adds", 1000)}</td>
              <td>{num(i, "heldSec", 5)}</td>
              <td>{num(i, "blocked", 100)}</td>
              <td>{num(i, "healed", 100)}</td>
              {AWARD_ROLES.map((r) => {
                const e = ranks[r].find((x) => x.key === String(i));
                const won = winners[r]?.key === String(i);
                return (
                  <td
                    key={r}
                    className={cn(
                      "text-right tabular-nums",
                      won
                        ? "text-yellow"
                        : r === roleOf(f)
                          ? "text-text"
                          : "text-text-dim",
                    )}
                  >
                    {e
                      ? `${won ? "★ " : ""}#${e.rank} · ${Math.round(e.share * 100)}%`
                      : "–"}
                  </td>
                );
              })}
              <td>
                <button
                  type="button"
                  className="btn px-1.5"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => remove(i)}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn mt-1.5" onClick={add}>
        Add herzie
      </button>
    </div>
  );
}

/** One of the Town's screens at its real size, a stand-in for the cave
 * blurred behind the end screen, and the end screen over it as
 * BossResults places it. */
function Frame({
  w,
  h,
  results,
  herzies,
}: {
  w: number;
  h: number;
  results: Omit<BossResults, "showAt">;
  herzies: boolean;
}) {
  const [stage] = useState(() => new HerzieStage());
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => followTownLook(stage), [stage]);
  useEffect(() => () => stage.dispose(), [stage]);
  useEffect(() => {
    stage.setHost(overlay.current);
  }, [stage]);
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md border border-white/10"
      style={{
        width: w,
        height: h,
        background:
          "radial-gradient(ellipse 60% 45% at 50% 62%, #6b4a3a 0%, #2c2230 45%, #0d0b12 100%)",
      }}
    >
      {/* Something to blur: torches and the boss's bulk. */}
      <div className="absolute top-[30%] left-[18%] size-16 rounded-full bg-orange/60 blur-md" />
      <div className="absolute top-[26%] right-[16%] size-14 rounded-full bg-yellow/50 blur-md" />
      <div className="absolute bottom-[18%] left-1/2 h-1/3 w-1/4 -translate-x-1/2 rounded-t-full bg-[#3c3640]" />
      <div ref={overlay} className="absolute inset-3 z-10 flex">
        <AwardsCard
          results={results}
          stage={herzies ? stage : null}
          onContinue={() => {}}
        />
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-ui-sm tracking-[0.15em] text-text-dim uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          className={cn("btn flex-1", v === value && "border-text bg-white/10")}
          aria-pressed={v === value}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
