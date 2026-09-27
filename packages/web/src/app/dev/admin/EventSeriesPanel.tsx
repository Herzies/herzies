"use client";

import { useState } from "react";
import {
  type AdminEvent,
  adminFetch,
  type CatalogItem,
  datetimeLocalToIso,
  EVENT_TYPE_LABELS,
  EVENT_TYPE_STYLES,
  type EventSeries,
  formatDuration,
  getEventStatus,
  INPUT,
  isoToDatetimeLocal,
  STATUS_STYLES,
  toDatetimeLocalValue,
} from "./admin-shared";
import {
  BossFightConfigFields,
  type BossFightConfigForm,
  bossFightConfigFromRecord,
  bossFightFormToConfig,
  CatalogItemSelect,
  MerchantConfigFields,
  type MerchantConfigForm,
  merchantConfigFromRecord,
  merchantFormToConfig,
} from "./event-fields";

type SeriesType = EventSeries["type"];

type SeriesForm = {
  id?: string;
  type: SeriesType;
  title: string;
  description: string;
  enabled: boolean;
  anchorAt: string;
  intervalDays: string;
  durationDays: string;
  durationHours: string;
  until: string;
  songHunt: { rewardItemId: string; maxClaims: string };
  bossFight: BossFightConfigForm;
  merchant: MerchantConfigForm;
};

/** Starting points per type; everything is editable. */
const PRESETS: Record<
  SeriesType,
  { title: string; description: string; days: number }
> = {
  song_hunt: { title: "Song Hunt", description: "", days: 7 },
  boss_fight: {
    title: "Nohoot Henry",
    description: "Listen to what it hates.",
    days: 4,
  },
  merchant: {
    title: "Good ol' George",
    description: "He's got stuff. Good stuff.",
    days: 2,
  },
};

function newSeriesForm(type: SeriesType = "song_hunt"): SeriesForm {
  const preset = PRESETS[type];
  // Next local midnight, a sensible default first start.
  const start = new Date();
  start.setHours(24, 0, 0, 0);
  return {
    type,
    title: preset.title,
    description: preset.description,
    enabled: true,
    anchorAt: toDatetimeLocalValue(start),
    intervalDays: "7",
    durationDays: String(preset.days),
    durationHours: "0",
    until: "",
    songHunt: { rewardItemId: "", maxClaims: "50" },
    bossFight: {
      hatedGenres: [],
      maxHp: "",
      rewardItemId: "cd",
      topRewardItemId: "cd",
      topCount: "3",
    },
    merchant: { stock: [] },
  };
}

function seriesToForm(s: EventSeries): SeriesForm {
  const t = s.config_template;
  return {
    ...newSeriesForm(s.type),
    id: s.id,
    title: s.title,
    description: s.description ?? "",
    enabled: s.enabled,
    anchorAt: isoToDatetimeLocal(s.anchor_at),
    intervalDays: String(s.interval_days),
    durationDays: String(Math.floor(s.duration_minutes / 1440)),
    durationHours: String(Math.round((s.duration_minutes % 1440) / 60)),
    until: s.until ? isoToDatetimeLocal(s.until) : "",
    songHunt: {
      rewardItemId: typeof t.rewardItemId === "string" ? t.rewardItemId : "",
      maxClaims: typeof t.maxClaims === "number" ? String(t.maxClaims) : "50",
    },
    bossFight:
      s.type === "boss_fight"
        ? bossFightConfigFromRecord(t)
        : newSeriesForm("boss_fight").bossFight,
    merchant:
      s.type === "merchant" ? merchantConfigFromRecord(t) : { stock: [] },
  };
}

/** Form → request body, or an error message. */
function seriesPayload(form: SeriesForm): Record<string, unknown> | string {
  const intervalDays = Number.parseInt(form.intervalDays, 10);
  if (!(intervalDays > 0)) return "Repeat interval must be at least 1 day";
  const durationMinutes =
    (Number.parseInt(form.durationDays, 10) || 0) * 1440 +
    (Number.parseInt(form.durationHours, 10) || 0) * 60;
  if (durationMinutes <= 0) return "Duration must be positive";
  if (Number.isNaN(new Date(form.anchorAt).getTime())) {
    return "First start is required";
  }

  let configTemplate: Record<string, unknown> | string;
  if (form.type === "boss_fight") {
    configTemplate = bossFightFormToConfig(form.bossFight, { template: true });
  } else if (form.type === "merchant") {
    configTemplate = merchantFormToConfig(form.merchant);
  } else {
    const maxClaims = Number.parseInt(form.songHunt.maxClaims, 10);
    if (!(maxClaims > 0)) return "Max claims must be positive";
    configTemplate = {
      ...(form.songHunt.rewardItemId
        ? { rewardItemId: form.songHunt.rewardItemId }
        : {}),
      maxClaims,
    };
  }
  if (typeof configTemplate === "string") return configTemplate;

  return {
    ...(form.id ? { id: form.id } : {}),
    type: form.type,
    title: form.title.trim(),
    description: form.description.trim() || undefined,
    enabled: form.enabled,
    anchorAt: datetimeLocalToIso(form.anchorAt),
    intervalDays,
    durationMinutes,
    until: form.until ? datetimeLocalToIso(form.until) : null,
    configTemplate,
  };
}

function describeCadence(s: EventSeries): string {
  const anchor = new Date(s.anchor_at);
  const every =
    s.interval_days === 7
      ? "weekly"
      : s.interval_days === 1
        ? "daily"
        : s.interval_days % 7 === 0
          ? `every ${s.interval_days / 7} weeks`
          : `every ${s.interval_days} days`;
  const when = anchor.toLocaleString(undefined, {
    weekday: s.interval_days % 7 === 0 ? "short" : undefined,
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${every} · ${when} · lasts ${formatDuration(s.duration_minutes * 60_000)}`;
}

export function EventSeriesPanel({
  series,
  events,
  secret,
  catalogItems,
  now,
  onChange,
}: {
  series: EventSeries[];
  events: AdminEvent[];
  secret: string;
  catalogItems: CatalogItem[];
  now: Date;
  onChange: () => void;
}) {
  const [form, setForm] = useState<SeriesForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (body: Record<string, unknown> | string) => {
    if (typeof body === "string") {
      setError(body);
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      await adminFetch("/api/admin/event-series", secret, {
        method: "POST",
        body: JSON.stringify(body),
      });
      onChange();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form && (await save(seriesPayload(form)))) setForm(null);
  };

  const toggleEnabled = (s: EventSeries) =>
    save(seriesPayload({ ...seriesToForm(s), enabled: !s.enabled }));

  const remove = async (s: EventSeries) => {
    if (
      !confirm(
        `Delete series "${s.title}"? Upcoming untouched occurrences go with it; live, edited and skipped ones stay.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/admin/event-series?id=${s.id}`, secret, {
        method: "DELETE",
      });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-dim max-w-2xl">
        A series writes its occurrences out four weeks ahead. Each one is then
        its own event: click it on the calendar to curate, edit or skip it. Song
        hunts and George stay unpublished (&quot;needs setup&quot;) until they
        have a track and hints / something to sell.
      </p>

      {series.length === 0 ? (
        <p className="text-text-dim text-xs">No recurring series yet.</p>
      ) : (
        <div className="overflow-x-auto border border-border rounded-sm">
          <table className="w-full text-sm text-left">
            <thead className="bg-bg-panel text-text-dim text-xs">
              <tr>
                <th className="py-2 px-4 font-normal">series</th>
                <th className="py-2 px-4 font-normal">schedule</th>
                <th className="py-2 px-4 font-normal">next</th>
                <th className="py-2 px-4 font-normal text-right">actions</th>
              </tr>
            </thead>
            <tbody>
              {series.map((s) => {
                const next = events
                  .filter(
                    (e) => e.series_id === s.id && new Date(e.ends_at) > now,
                  )
                  .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
                const status = next ? getEventStatus(next, now) : null;
                return (
                  <tr key={s.id} className="border-t border-border align-top">
                    <td className="py-3 px-4">
                      <div className="font-medium">{s.title}</div>
                      <span
                        className={`inline-block mt-1 text-[11px] px-1 border ${EVENT_TYPE_STYLES[s.type]}`}
                      >
                        {EVENT_TYPE_LABELS[s.type]}
                      </span>
                      {!s.enabled && (
                        <span className="ml-2 text-xs text-red">paused</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs text-text-dim">
                      {describeCadence(s)}
                      {s.until && (
                        <div>
                          until {new Date(s.until).toLocaleDateString()}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs">
                      {next && status ? (
                        <>
                          <span className={STATUS_STYLES[status]}>
                            {status}
                          </span>
                          <div className="text-text-dim">
                            {status === "running"
                              ? `ends in ${formatDuration(new Date(next.ends_at).getTime() - now.getTime())}`
                              : `in ${formatDuration(new Date(next.starts_at).getTime() - now.getTime())}`}
                          </div>
                        </>
                      ) : (
                        <span className="text-text-dim">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap text-xs">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setError(null);
                          setForm(seriesToForm(s));
                        }}
                        className="text-purple bg-transparent border-0 cursor-pointer disabled:opacity-50 mr-3"
                      >
                        edit
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggleEnabled(s)}
                        className="text-cyan bg-transparent border-0 cursor-pointer disabled:opacity-50 mr-3"
                      >
                        {s.enabled ? "pause" : "resume"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(s)}
                        className="text-red bg-transparent border-0 cursor-pointer disabled:opacity-50"
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && !form && <p className="text-red text-xs">{error}</p>}

      {form ? (
        <div className="border border-border rounded-sm p-6 bg-bg-panel">
          <p className="text-xs text-text-dim mb-4">
            {form.id ? "edit series" : "new series"}
          </p>
          <SeriesFormFields
            form={form}
            setForm={setForm}
            catalogItems={catalogItems}
            onSubmit={submit}
            onCancel={() => {
              setForm(null);
              setError(null);
            }}
            busy={busy}
          />
          {error && <p className="text-red text-xs mt-2">{error}</p>}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setForm(newSeriesForm())}
          className="text-xs text-purple bg-transparent border border-border px-3 py-1.5 rounded-sm cursor-pointer hover:border-purple"
        >
          + new series
        </button>
      )}
    </div>
  );
}

function SeriesFormFields({
  form,
  setForm,
  catalogItems,
  onSubmit,
  onCancel,
  busy,
}: {
  form: SeriesForm;
  setForm: React.Dispatch<React.SetStateAction<SeriesForm | null>>;
  catalogItems: CatalogItem[];
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const update = (patch: Partial<SeriesForm>) =>
    setForm((f) => (f ? { ...f, ...patch } : f));
  const idp = form.id ?? "new-series";

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${idp}-type`}
          >
            type
          </label>
          <select
            id={`${idp}-type`}
            value={form.type}
            disabled={!!form.id}
            onChange={(e) =>
              setForm(newSeriesForm(e.target.value as SeriesType))
            }
            className={INPUT}
          >
            <option value="song_hunt">song hunt</option>
            <option value="boss_fight">boss fight</option>
            <option value="merchant">Good ol&apos; George</option>
          </select>
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${idp}-title`}
          >
            title
          </label>
          <input
            id={`${idp}-title`}
            required
            value={form.title}
            onChange={(e) => update({ title: e.target.value })}
            className={INPUT}
          />
        </div>
      </div>
      <div>
        <label
          className="block text-xs text-text-dim mb-1"
          htmlFor={`${idp}-desc`}
        >
          description
        </label>
        <input
          id={`${idp}-desc`}
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
          className={INPUT}
        />
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${idp}-anchor`}
          >
            first start (sets the weekday and time)
          </label>
          <input
            id={`${idp}-anchor`}
            type="datetime-local"
            required
            value={form.anchorAt}
            onChange={(e) => update({ anchorAt: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${idp}-until`}
          >
            last start before (optional)
          </label>
          <input
            id={`${idp}-until`}
            type="datetime-local"
            value={form.until}
            onChange={(e) => update({ until: e.target.value })}
            className={INPUT}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${idp}-interval`}
          >
            repeat every (days)
          </label>
          <input
            id={`${idp}-interval`}
            type="number"
            min={1}
            required
            value={form.intervalDays}
            onChange={(e) => update({ intervalDays: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${idp}-dur-d`}
          >
            lasts (days)
          </label>
          <input
            id={`${idp}-dur-d`}
            type="number"
            min={0}
            value={form.durationDays}
            onChange={(e) => update({ durationDays: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${idp}-dur-h`}
          >
            + hours
          </label>
          <input
            id={`${idp}-dur-h`}
            type="number"
            min={0}
            max={23}
            value={form.durationHours}
            onChange={(e) => update({ durationHours: e.target.value })}
            className={INPUT}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        enabled
      </label>

      {form.type === "song_hunt" && (
        <div className="grid sm:grid-cols-2 gap-4 border border-border rounded-sm p-4 bg-bg">
          <div>
            <label
              className="block text-xs text-text-dim mb-1"
              htmlFor={`${idp}-hunt-reward`}
            >
              default reward item
            </label>
            <CatalogItemSelect
              id={`${idp}-hunt-reward`}
              value={form.songHunt.rewardItemId}
              onChange={(rewardItemId) =>
                update({ songHunt: { ...form.songHunt, rewardItemId } })
              }
              catalogItems={catalogItems}
              emptyLabel="choose each week"
            />
          </div>
          <div>
            <label
              className="block text-xs text-text-dim mb-1"
              htmlFor={`${idp}-hunt-claims`}
            >
              max claims
            </label>
            <input
              id={`${idp}-hunt-claims`}
              type="number"
              min={1}
              value={form.songHunt.maxClaims}
              onChange={(e) =>
                update({
                  songHunt: { ...form.songHunt, maxClaims: e.target.value },
                })
              }
              className={INPUT}
            />
          </div>
          <p className="sm:col-span-2 text-xs text-text-dim">
            Track and hints are set per week on each occurrence.
          </p>
        </div>
      )}
      {form.type === "boss_fight" && (
        <BossFightConfigFields
          boss={form.bossFight}
          update={(patch) =>
            update({ bossFight: { ...form.bossFight, ...patch } })
          }
          catalogItems={catalogItems}
          fieldIdPrefix={idp}
          template
        />
      )}
      {form.type === "merchant" && (
        <>
          <MerchantConfigFields
            merchant={form.merchant}
            setMerchant={(merchant) => update({ merchant })}
            catalogItems={catalogItems}
            fieldIdPrefix={idp}
          />
          <p className="text-xs text-text-dim">
            Default stock for every visit. Leave it empty to stock each visit by
            hand.
          </p>
        </>
      )}

      {form.id && (
        <p className="text-xs text-yellow">
          Saving regenerates upcoming occurrences you haven&apos;t edited or
          skipped.
        </p>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy || !form.title.trim()}
          className="text-sm text-purple bg-transparent border border-border px-4 py-2 rounded-sm cursor-pointer hover:border-purple disabled:opacity-50"
        >
          {form.id ? "save series" : "create series"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-text-dim bg-transparent border-0 cursor-pointer"
        >
          cancel
        </button>
      </div>
    </form>
  );
}
