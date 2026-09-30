"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch, INPUT } from "./admin-shared";

type XpBonusId = "boost" | "streak" | "good_eye_sniper";

type XpBonus = {
  id: XpBonusId;
  enabled: boolean;
  amount: number;
  cap: number | null;
};

type Schedule = { days: number[]; hourStart: number; hourEnd: number };

type Multiplier = {
  id: string;
  name: string;
  bonus: number;
  active: boolean;
  starts_at: string;
  ends_at: string;
  schedule: Schedule | null;
};

/** What each built-in bonus is, and what its `amount` means. */
const BUILT_INS: Record<
  XpBonusId,
  { label: string; unit: string; blurb: string; capped: boolean }
> = {
  boost: {
    label: "BOOST",
    unit: "flat",
    blurb: "While a herzie's boost_until is in the future.",
    capped: false,
  },
  streak: {
    label: "Daily streak",
    unit: "per streak day",
    blurb:
      "For each consecutive day listened. Off still counts the streak, it just pays nothing (and isn't announced).",
    capped: true,
  },
  good_eye_sniper: {
    label: "Good Eye Sniper",
    unit: "per song hunt won",
    blurb: "While the card is equipped.",
    capped: true,
  },
};

/** INPUT's look without its full width, for the short hour fields. */
const HOUR_INPUT =
  "w-20 bg-bg border border-border rounded-sm px-3 py-2 text-sm focus:outline-none focus:border-purple";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Bonuses are stored as fractions (0.05) and edited as percents (5). */
const toPercent = (fraction: number) => Math.round(fraction * 10_000) / 100;
const toFraction = (percent: number) => percent / 100;

function scheduleLabel(schedule: Schedule | null): string {
  if (!schedule) return "whole window";
  const days =
    schedule.days.length === 7
      ? "every day"
      : schedule.days.map((d) => DAYS[d]).join(", ");
  const hours =
    schedule.hourStart === 0 && schedule.hourEnd === 24
      ? "all day"
      : `${schedule.hourStart}:00–${schedule.hourEnd}:00`;
  return `${days}, ${hours}`;
}

/**
 * Every XP multiplier in one place: the built-in bonuses (tunable rules,
 * 00091) and the timed ones from public.multipliers. processSync adds the
 * active ones together, so a +5% and a +10% make +15%.
 */
export function XpPanel({ secret }: { secret: string }) {
  const [bonuses, setBonuses] = useState<XpBonus[]>([]);
  const [multipliers, setMultipliers] = useState<Multiplier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bonusesMissing, setBonusesMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminFetch<{ multipliers: Multiplier[] }>(
        "/api/admin/multipliers",
        secret,
      );
      setMultipliers(res.multipliers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load multipliers");
    }
    try {
      const res = await adminFetch<{ bonuses: XpBonus[] }>(
        "/api/admin/xp-bonuses",
        secret,
      );
      setBonuses(res.bonuses);
      setBonusesMissing(false);
    } catch {
      setBonusesMissing(true);
    }
  }, [secret]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-8">
      <p className="text-xs text-text-dim max-w-2xl">
        Every active multiplier is added together on each sync — a +5% and a
        +10% make +15% on top of base XP. Values here are percents.
      </p>
      {error && <p className="text-red text-xs">{error}</p>}

      <div>
        <h3 className="text-xs text-text-dim mb-2 uppercase tracking-wide">
          built-in
        </h3>
        {bonusesMissing ? (
          <p className="text-yellow text-xs">
            Couldn&apos;t load the built-in bonuses — this database probably
            doesn&apos;t have migration 00091_xp_bonuses yet. Until it does, the
            game uses the old fixed values.
          </p>
        ) : (
          <ul className="border border-border rounded-sm divide-y divide-border">
            {bonuses.map((b) => (
              <BuiltInRow
                // Remount after a save so the inputs reset to what's stored.
                key={`${b.id}:${b.amount}:${b.cap}`}
                bonus={b}
                secret={secret}
                onSaved={load}
              />
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-xs text-text-dim mb-2 uppercase tracking-wide">
          timed
        </h3>
        <ul className="border border-border rounded-sm divide-y divide-border">
          {multipliers.map((m) => (
            <MultiplierRow
              key={m.id}
              multiplier={m}
              secret={secret}
              onChange={load}
            />
          ))}
          {multipliers.length === 0 && (
            <li className="px-4 py-3 text-xs text-text-dim">
              No timed multipliers.
            </li>
          )}
        </ul>
        <NewMultiplier secret={secret} onCreated={load} />
      </div>
    </div>
  );
}

function BuiltInRow({
  bonus,
  secret,
  onSaved,
}: {
  bonus: XpBonus;
  secret: string;
  onSaved: () => void;
}) {
  const meta = BUILT_INS[bonus.id];
  const [amount, setAmount] = useState(String(toPercent(bonus.amount)));
  const [cap, setCap] = useState(
    bonus.cap == null ? "" : String(toPercent(bonus.cap)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountNum = Number(amount);
  const capNum = cap.trim() === "" ? null : Number(cap);
  const valid =
    amountNum > 0 &&
    (capNum === null || (Number.isFinite(capNum) && capNum > 0));
  const dirty =
    toFraction(amountNum) !== bonus.amount ||
    (capNum === null ? null : toFraction(capNum)) !== bonus.cap;

  const post = async (row: Omit<XpBonus, "id">) => {
    setBusy(true);
    setError(null);
    try {
      await adminFetch("/api/admin/xp-bonuses", secret, {
        method: "POST",
        body: JSON.stringify({ id: bonus.id, ...row }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  // On/off saves straight away with the stored numbers, like the timed rows;
  // edited numbers wait for "save".
  const toggle = (on: boolean) =>
    post({ enabled: on, amount: bonus.amount, cap: bonus.cap });
  const save = () =>
    post({
      enabled: bonus.enabled,
      amount: toFraction(amountNum),
      cap: meta.capped && capNum !== null ? toFraction(capNum) : null,
    });
  const enabled = bonus.enabled;

  return (
    <li className="grid gap-3 px-4 py-3 sm:grid-cols-[1.4fr_auto_1fr_1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className={enabled ? "text-sm" : "text-sm text-text-dim"}>
          {meta.label}
        </div>
        <div className="text-xs text-text-dim">{meta.blurb}</div>
        {error && <div className="text-xs text-red">{error}</div>}
      </div>
      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => toggle(e.target.checked)}
        />
        {enabled ? "on" : "off"}
      </label>
      <label className="text-xs text-text-dim">
        % {meta.unit}
        <input
          type="number"
          step="any"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={INPUT}
        />
      </label>
      {meta.capped ? (
        <label className="text-xs text-text-dim">
          cap % (blank = none)
          <input
            type="number"
            step="any"
            min="0"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            className={INPUT}
          />
        </label>
      ) : (
        <div />
      )}
      <button
        type="button"
        disabled={busy || !valid || !dirty}
        onClick={save}
        className="text-xs text-purple bg-transparent border border-border px-3 py-2 rounded-sm cursor-pointer hover:border-purple disabled:opacity-50"
      >
        save
      </button>
    </li>
  );
}

/** Editable fields shared by the row editor and the create form. */
type MultiplierDraft = {
  name: string;
  bonusPercent: string;
  startsAt: string;
  endsAt: string;
  recurring: boolean;
  days: number[];
  hourStart: string;
  hourEnd: string;
};

/** `<input type="date">` wants YYYY-MM-DD. */
const dateOnly = (iso: string) => iso.slice(0, 10);

function draftFrom(m: Multiplier): MultiplierDraft {
  return {
    name: m.name,
    bonusPercent: String(toPercent(m.bonus)),
    startsAt: dateOnly(m.starts_at),
    endsAt: dateOnly(m.ends_at),
    recurring: m.schedule !== null,
    days: m.schedule?.days ?? [0, 1, 2, 3, 4, 5, 6],
    hourStart: String(m.schedule?.hourStart ?? 0),
    hourEnd: String(m.schedule?.hourEnd ?? 24),
  };
}

const EMPTY_DRAFT: MultiplierDraft = {
  name: "",
  bonusPercent: "10",
  startsAt: new Date().toISOString().slice(0, 10),
  endsAt: "2099-12-31",
  recurring: false,
  days: [0, 1, 2, 3, 4, 5, 6],
  hourStart: "0",
  hourEnd: "24",
};

function draftProblem(d: MultiplierDraft): string | null {
  if (!d.name.trim()) return "Name it.";
  if (!(Number(d.bonusPercent) > 0)) return "Bonus must be above 0%.";
  if (!d.startsAt || !d.endsAt || d.endsAt < d.startsAt)
    return "The window ends before it starts.";
  if (d.recurring) {
    const start = Number(d.hourStart);
    const end = Number(d.hourEnd);
    if (d.days.length === 0) return "Pick at least one day.";
    if (!(start >= 0 && start <= 23 && end >= 1 && end <= 24 && end > start))
      return "Hours must run from 0–23 to a later 1–24.";
  }
  return null;
}

/** The API body for a draft. The window is whole days: start of the first
 * to the end of the last (UTC). */
function draftBody(d: MultiplierDraft) {
  return {
    name: d.name.trim(),
    bonus: toFraction(Number(d.bonusPercent)),
    startsAt: `${d.startsAt}T00:00:00Z`,
    endsAt: `${d.endsAt}T23:59:59Z`,
    schedule: d.recurring
      ? {
          days: [...d.days].sort(),
          hourStart: Number(d.hourStart),
          hourEnd: Number(d.hourEnd),
        }
      : null,
  };
}

function DraftFields({
  draft,
  setDraft,
  idPrefix,
}: {
  draft: MultiplierDraft;
  setDraft: (d: MultiplierDraft) => void;
  idPrefix: string;
}) {
  const set = (patch: Partial<MultiplierDraft>) =>
    setDraft({ ...draft, ...patch });
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <label className="text-xs text-text-dim" htmlFor={`${idPrefix}-name`}>
          name
          <input
            id={`${idPrefix}-name`}
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            className={INPUT}
          />
        </label>
        <label className="text-xs text-text-dim" htmlFor={`${idPrefix}-bonus`}>
          bonus %
          <input
            id={`${idPrefix}-bonus`}
            type="number"
            step="any"
            min="0"
            value={draft.bonusPercent}
            onChange={(e) => set({ bonusPercent: e.target.value })}
            className={INPUT}
          />
        </label>
        <label className="text-xs text-text-dim" htmlFor={`${idPrefix}-from`}>
          from
          <input
            id={`${idPrefix}-from`}
            type="date"
            value={draft.startsAt}
            onChange={(e) => set({ startsAt: e.target.value })}
            className={INPUT}
          />
        </label>
        <label className="text-xs text-text-dim" htmlFor={`${idPrefix}-to`}>
          to
          <input
            id={`${idPrefix}-to`}
            type="date"
            value={draft.endsAt}
            onChange={(e) => set({ endsAt: e.target.value })}
            className={INPUT}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={draft.recurring}
          onChange={(e) => set({ recurring: e.target.checked })}
        />
        only on some days / hours
      </label>
      {draft.recurring && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {DAYS.map((label, day) => (
            <label
              key={label}
              className="flex items-center gap-1 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={draft.days.includes(day)}
                onChange={(e) =>
                  set({
                    days: e.target.checked
                      ? [...draft.days, day]
                      : draft.days.filter((d) => d !== day),
                  })
                }
              />
              {label}
            </label>
          ))}
          <span className="text-text-dim">from hour</span>
          <input
            type="number"
            min="0"
            max="23"
            value={draft.hourStart}
            onChange={(e) => set({ hourStart: e.target.value })}
            className={HOUR_INPUT}
          />
          <span className="text-text-dim">to</span>
          <input
            type="number"
            min="1"
            max="24"
            value={draft.hourEnd}
            onChange={(e) => set({ hourEnd: e.target.value })}
            className={HOUR_INPUT}
          />
          <span className="text-text-dim">(UTC)</span>
        </div>
      )}
    </div>
  );
}

function MultiplierRow({
  multiplier: m,
  secret,
  onChange,
}: {
  multiplier: Multiplier;
  secret: string;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFrom(m));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  // Toggling sends the row as stored (schedule included) plus the flip, so
  // nothing else about it changes.
  const toggle = () =>
    run(() =>
      adminFetch("/api/admin/multipliers", secret, {
        method: "POST",
        body: JSON.stringify({
          id: m.id,
          name: m.name,
          bonus: m.bonus,
          active: !m.active,
          startsAt: m.starts_at,
          endsAt: m.ends_at,
          schedule: m.schedule,
        }),
      }),
    );

  const save = () =>
    run(async () => {
      await adminFetch("/api/admin/multipliers", secret, {
        method: "POST",
        body: JSON.stringify({
          id: m.id,
          active: m.active,
          ...draftBody(draft),
        }),
      });
      setEditing(false);
    });

  const remove = () => {
    if (!confirm(`Delete "${m.name}"?`)) return;
    run(() =>
      adminFetch(`/api/admin/multipliers?id=${m.id}`, secret, {
        method: "DELETE",
      }),
    );
  };

  const problem = draftProblem(draft);

  return (
    <li className="px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <span className={m.active ? "text-sm" : "text-sm text-text-dim"}>
            {m.name}
          </span>
          <span className="text-sm text-green"> +{toPercent(m.bonus)}%</span>
          <div className="text-xs text-text-dim">
            {scheduleLabel(m.schedule)} · {dateOnly(m.starts_at)} →{" "}
            {dateOnly(m.ends_at)}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={m.active}
              disabled={busy}
              onChange={toggle}
            />
            {m.active ? "on" : "off"}
          </label>
          <button
            type="button"
            onClick={() => {
              setDraft(draftFrom(m));
              setEditing((v) => !v);
            }}
            className="text-cyan bg-transparent border-0 cursor-pointer"
          >
            {editing ? "cancel" : "edit"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="text-red bg-transparent border-0 cursor-pointer disabled:opacity-50"
          >
            delete
          </button>
        </div>
      </div>
      {editing && (
        <div className="space-y-2 border-t border-border pt-2">
          <DraftFields draft={draft} setDraft={setDraft} idPrefix={m.id} />
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy || problem !== null}
              onClick={save}
              className="text-xs text-purple bg-transparent border border-border px-3 py-2 rounded-sm cursor-pointer hover:border-purple disabled:opacity-50"
            >
              save
            </button>
            {problem && <span className="text-xs text-yellow">{problem}</span>}
          </div>
        </div>
      )}
      {error && <p className="text-red text-xs">{error}</p>}
    </li>
  );
}

function NewMultiplier({
  secret,
  onCreated,
}: {
  secret: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = draftProblem(draft);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminFetch("/api/admin/multipliers", secret, {
        method: "POST",
        body: JSON.stringify({ active: true, ...draftBody(draft) }),
      });
      setDraft(EMPTY_DRAFT);
      setOpen(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 text-xs text-purple bg-transparent border border-border px-3 py-2 rounded-sm cursor-pointer hover:border-purple"
      >
        + new multiplier
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2 border border-border rounded-sm px-4 py-3">
      <DraftFields
        draft={draft}
        setDraft={setDraft}
        idPrefix="new-multiplier"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || problem !== null}
          onClick={create}
          className="text-xs text-purple bg-transparent border border-border px-3 py-2 rounded-sm cursor-pointer hover:border-purple disabled:opacity-50"
        >
          create
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-text-dim bg-transparent border-0 cursor-pointer"
        >
          cancel
        </button>
        {problem && <span className="text-xs text-yellow">{problem}</span>}
        {error && <span className="text-xs text-red">{error}</span>}
      </div>
    </div>
  );
}
