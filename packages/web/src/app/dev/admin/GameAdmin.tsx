"use client";

import type { SongHuntConfig, SongHuntHint } from "@herzies/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

const SECRET_KEY = "herzies-admin-secret";
const INPUT =
  "w-full bg-bg border border-border rounded-sm px-3 py-2 text-sm focus:outline-none focus:border-purple";
const RARITIES = ["common", "uncommon", "rare", "legendary"] as const;

type CatalogItem = {
  id: string;
  name: string;
  description: string;
  rarity: string;
  sell_price?: number | null;
  stackable?: boolean | null;
  equipable?: boolean | null;
  equip_slot?: string | null;
};

type AdminEvent = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  active: boolean;
  starts_at: string;
  ends_at: string;
  config: Record<string, unknown>;
  created_at: string;
};

type EventStatus = "running" | "scheduled" | "ended" | "inactive";

type SongHuntHintForm = {
  text: string;
  unlocksAt: string;
};

type SongHuntConfigForm = {
  trackTitle: string;
  trackArtist: string;
  rewardItemId: string;
  rewardItemName: string;
  maxClaims: string;
  hints: SongHuntHintForm[];
};

type EventFormState = {
  id?: string;
  type: string;
  title: string;
  description: string;
  active: boolean;
  startsAt: string;
  endsAt: string;
  configJson: string;
  songHunt: SongHuntConfigForm;
};

type ItemFormState = {
  id: string;
  name: string;
  description: string;
  rarity: (typeof RARITIES)[number];
  sellPrice: string;
  stackable: boolean;
  equipable: boolean;
  equipSlot: "" | "head" | "scenery";
};

const EQUIP_SLOT_OPTIONS = ["head", "scenery"] as const;

function getEventStatus(event: AdminEvent, now: Date): EventStatus {
  if (!event.active) return "inactive";
  const start = new Date(event.starts_at);
  const end = new Date(event.ends_at);
  if (now < start) return "scheduled";
  if (now > end) return "ended";
  return "running";
}

const STATUS_STYLES: Record<EventStatus, string> = {
  running: "text-green",
  scheduled: "text-yellow",
  ended: "text-text-dim",
  inactive: "text-red",
};

const DEFAULT_CONFIGS: Record<string, string> = {
  secret_track: JSON.stringify(
    {
      trackTitle: "",
      trackArtist: "",
      rewardItemId: "",
      rewardItemName: "",
      maxClaims: 100,
    },
    null,
    2,
  ),
  song_hunt: JSON.stringify(
    {
      trackTitle: "",
      trackArtist: "",
      rewardItemId: "",
      rewardItemName: "",
      maxClaims: 50,
      hints: [{ text: "First hint", unlocksAt: new Date().toISOString() }],
    },
    null,
    2,
  ),
};

function toLocalDatetimeValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDatetimeValue(value: string): string {
  return new Date(value).toISOString();
}

function defaultWindow(): { startsAt: string; endsAt: string } {
  const start = new Date();
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

function defaultSongHuntConfig(): SongHuntConfigForm {
  return {
    trackTitle: "",
    trackArtist: "",
    rewardItemId: "",
    rewardItemName: "",
    maxClaims: "50",
    hints: [{ text: "First hint", unlocksAt: new Date().toISOString() }],
  };
}

function songHuntConfigFromRecord(
  config: Record<string, unknown>,
): SongHuntConfigForm {
  const hints: SongHuntHintForm[] = Array.isArray(config.hints)
    ? config.hints.map((raw) => {
        const hint = raw as Record<string, unknown>;
        return {
          text: typeof hint.text === "string" ? hint.text : "",
          unlocksAt:
            typeof hint.unlocksAt === "string"
              ? hint.unlocksAt
              : new Date().toISOString(),
        };
      })
    : [];

  return {
    trackTitle: typeof config.trackTitle === "string" ? config.trackTitle : "",
    trackArtist:
      typeof config.trackArtist === "string" ? config.trackArtist : "",
    rewardItemId:
      typeof config.rewardItemId === "string" ? config.rewardItemId : "",
    rewardItemName:
      typeof config.rewardItemName === "string" ? config.rewardItemName : "",
    maxClaims:
      typeof config.maxClaims === "number" && Number.isFinite(config.maxClaims)
        ? String(config.maxClaims)
        : "50",
    hints: hints.length > 0 ? hints : defaultSongHuntConfig().hints,
  };
}

function songHuntConfigToPayload(
  form: SongHuntConfigForm,
): SongHuntConfig & { rewardItemName?: string } {
  const maxClaims = Number.parseInt(form.maxClaims, 10);
  const payload: SongHuntConfig & { rewardItemName?: string } = {
    trackTitle: form.trackTitle.trim(),
    trackArtist: form.trackArtist.trim(),
    rewardItemId: form.rewardItemId.trim(),
    maxClaims: Number.isFinite(maxClaims) && maxClaims > 0 ? maxClaims : 50,
    hints: form.hints.map(
      (h): SongHuntHint => ({
        text: h.text.trim(),
        unlocksAt: h.unlocksAt,
      }),
    ),
  };
  if (form.rewardItemName.trim()) {
    payload.rewardItemName = form.rewardItemName.trim();
  }
  return payload;
}

function newEventForm(overrides?: Partial<EventFormState>): EventFormState {
  const { startsAt, endsAt } = defaultWindow();
  return {
    type: "secret_track",
    title: "",
    description: "",
    active: true,
    startsAt,
    endsAt,
    configJson: DEFAULT_CONFIGS.secret_track,
    songHunt: defaultSongHuntConfig(),
    ...overrides,
  };
}

function eventToForm(event: AdminEvent): EventFormState {
  return {
    id: event.id,
    type: event.type,
    title: event.title,
    description: event.description ?? "",
    active: event.active,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    configJson: JSON.stringify(event.config, null, 2),
    songHunt:
      event.type === "song_hunt"
        ? songHuntConfigFromRecord(event.config)
        : defaultSongHuntConfig(),
  };
}

function newItemForm(overrides?: Partial<ItemFormState>): ItemFormState {
  return {
    id: "",
    name: "",
    description: "",
    rarity: "common",
    sellPrice: "",
    stackable: false,
    equipable: false,
    equipSlot: "",
    ...overrides,
  };
}

function itemToForm(item: CatalogItem): ItemFormState {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    rarity: (RARITIES.includes(item.rarity as (typeof RARITIES)[number])
      ? item.rarity
      : "common") as (typeof RARITIES)[number],
    sellPrice: item.sell_price != null ? String(item.sell_price) : "",
    stackable: !!item.stackable,
    equipable: !!item.equipable,
    equipSlot: EQUIP_SLOT_OPTIONS.includes(
      item.equip_slot as (typeof EQUIP_SLOT_OPTIONS)[number],
    )
      ? (item.equip_slot as (typeof EQUIP_SLOT_OPTIONS)[number])
      : "",
  };
}

function itemFormToPayload(form: ItemFormState) {
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    rarity: form.rarity,
    sellPrice: form.sellPrice.trim() === "" ? null : Number(form.sellPrice),
    stackable: form.stackable,
    equipable: form.equipable,
    equipSlot: form.equipable && form.equipSlot ? form.equipSlot : null,
  };
}

async function adminFetch<T>(
  path: string,
  secret: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": secret,
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (body as { error?: string }).error ?? `Request failed (${res.status})`,
    );
  }
  return body as T;
}

function parseEventConfig(json: string): Record<string, unknown> | string {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return "Config must be valid JSON";
  }
}

function buildEventConfig(
  form: EventFormState,
): Record<string, unknown> | string {
  if (form.type === "song_hunt") {
    const { songHunt } = form;
    if (!songHunt.trackTitle.trim()) return "Track title is required";
    if (!songHunt.trackArtist.trim()) return "Track artist is required";
    if (!songHunt.rewardItemId.trim()) return "Reward item is required";
    const maxClaims = Number.parseInt(songHunt.maxClaims, 10);
    if (!Number.isFinite(maxClaims) || maxClaims < 1) {
      return "Max claims must be a positive number";
    }
    if (songHunt.hints.length === 0) return "At least one hint is required";
    for (let i = 0; i < songHunt.hints.length; i++) {
      if (!songHunt.hints[i].text.trim())
        return `Hint ${i + 1} text is required`;
      if (Number.isNaN(new Date(songHunt.hints[i].unlocksAt).getTime())) {
        return `Hint ${i + 1} unlock time is invalid`;
      }
    }
    return { ...songHuntConfigToPayload(songHunt) };
  }
  return parseEventConfig(form.configJson);
}

function SongHuntConfigFields({
  form,
  setForm,
  catalogItems,
  fieldIdPrefix,
}: {
  form: EventFormState;
  setForm: React.Dispatch<React.SetStateAction<EventFormState>>;
  catalogItems: CatalogItem[];
  fieldIdPrefix: string;
}) {
  const updateSongHunt = (patch: Partial<SongHuntConfigForm>) => {
    setForm((f) => ({ ...f, songHunt: { ...f.songHunt, ...patch } }));
  };

  const updateHint = (index: number, patch: Partial<SongHuntHintForm>) => {
    setForm((f) => ({
      ...f,
      songHunt: {
        ...f.songHunt,
        hints: f.songHunt.hints.map((h, i) =>
          i === index ? { ...h, ...patch } : h,
        ),
      },
    }));
  };

  const addHint = () => {
    setForm((f) => ({
      ...f,
      songHunt: {
        ...f.songHunt,
        hints: [
          ...f.songHunt.hints,
          { text: "", unlocksAt: new Date().toISOString() },
        ],
      },
    }));
  };

  const removeHint = (index: number) => {
    setForm((f) => ({
      ...f,
      songHunt: {
        ...f.songHunt,
        hints: f.songHunt.hints.filter((_, i) => i !== index),
      },
    }));
  };

  const onRewardItemChange = (itemId: string) => {
    const item = catalogItems.find((i) => i.id === itemId);
    updateSongHunt({
      rewardItemId: itemId,
      rewardItemName: item?.name ?? form.songHunt.rewardItemName,
    });
  };

  return (
    <div className="space-y-4 border border-border rounded-sm p-4 bg-bg">
      <p className="text-xs text-cyan">song hunt config</p>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-track-title`}
          >
            track title
          </label>
          <input
            id={`${fieldIdPrefix}-track-title`}
            required
            value={form.songHunt.trackTitle}
            onChange={(e) => updateSongHunt({ trackTitle: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-track-artist`}
          >
            track artist
          </label>
          <input
            id={`${fieldIdPrefix}-track-artist`}
            required
            value={form.songHunt.trackArtist}
            onChange={(e) => updateSongHunt({ trackArtist: e.target.value })}
            className={INPUT}
          />
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-reward-item`}
          >
            reward item
          </label>
          <select
            id={`${fieldIdPrefix}-reward-item`}
            required
            value={form.songHunt.rewardItemId}
            onChange={(e) => onRewardItemChange(e.target.value)}
            className={INPUT}
          >
            <option value="">select item…</option>
            {form.songHunt.rewardItemId &&
              !catalogItems.some(
                (i) => i.id === form.songHunt.rewardItemId,
              ) && (
                <option value={form.songHunt.rewardItemId}>
                  {form.songHunt.rewardItemId} (not in catalog)
                </option>
              )}
            {catalogItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.id})
              </option>
            ))}
          </select>
          {form.songHunt.rewardItemId &&
            !catalogItems.some((i) => i.id === form.songHunt.rewardItemId) && (
              <p className="text-yellow text-xs mt-1">
                Item not in catalog — will be auto-created on save if name is
                set.
              </p>
            )}
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${fieldIdPrefix}-reward-name`}
          >
            reward item name (auto-create)
          </label>
          <input
            id={`${fieldIdPrefix}-reward-name`}
            value={form.songHunt.rewardItemName}
            onChange={(e) => updateSongHunt({ rewardItemName: e.target.value })}
            className={INPUT}
            placeholder="used when item id is new"
          />
        </div>
      </div>
      <div className="max-w-xs">
        <label
          className="block text-xs text-text-dim mb-1"
          htmlFor={`${fieldIdPrefix}-max-claims`}
        >
          max claims
        </label>
        <input
          id={`${fieldIdPrefix}-max-claims`}
          type="number"
          min={1}
          required
          value={form.songHunt.maxClaims}
          onChange={(e) => updateSongHunt({ maxClaims: e.target.value })}
          className={INPUT}
        />
      </div>
      <div>
        <div className="flex items-center justify-between gap-4 mb-2">
          <span className="text-xs text-text-dim">
            hints (unlock in order by date)
          </span>
          <button
            type="button"
            onClick={addHint}
            className="text-xs text-purple bg-transparent border border-border px-2 py-1 rounded-sm cursor-pointer hover:border-purple"
          >
            + add hint
          </button>
        </div>
        <div className="space-y-3">
          {form.songHunt.hints.map((hint, index) => (
            <div
              key={`${index}-${hint.unlocksAt}`}
              className="border border-border/60 rounded-sm p-3 space-y-3 bg-bg-panel"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-text-dim">hint {index + 1}</span>
                {form.songHunt.hints.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeHint(index)}
                    className="text-xs text-red bg-transparent border-0 cursor-pointer"
                  >
                    remove
                  </button>
                )}
              </div>
              <div>
                <label
                  className="block text-xs text-text-dim mb-1"
                  htmlFor={`${fieldIdPrefix}-hint-${index}-text`}
                >
                  text
                </label>
                <input
                  id={`${fieldIdPrefix}-hint-${index}-text`}
                  required
                  value={hint.text}
                  onChange={(e) => updateHint(index, { text: e.target.value })}
                  className={INPUT}
                />
              </div>
              <div>
                <label
                  className="block text-xs text-text-dim mb-1"
                  htmlFor={`${fieldIdPrefix}-hint-${index}-unlock`}
                >
                  unlocks at (UTC stored as ISO)
                </label>
                <input
                  id={`${fieldIdPrefix}-hint-${index}-unlock`}
                  type="datetime-local"
                  required
                  value={toLocalDatetimeValue(hint.unlocksAt)}
                  onChange={(e) =>
                    updateHint(index, {
                      unlocksAt: fromLocalDatetimeValue(e.target.value),
                    })
                  }
                  className={INPUT}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EventForm({
  form,
  setForm,
  onSubmit,
  onCancel,
  submitLabel,
  disabled,
  catalogItems,
}: {
  form: EventFormState;
  setForm: React.Dispatch<React.SetStateAction<EventFormState>>;
  onSubmit: (e: React.FormEvent) => void;
  onCancel?: () => void;
  submitLabel: string;
  disabled?: boolean;
  catalogItems: CatalogItem[];
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${form.id ?? "new"}-ev-type`}
          >
            type
          </label>
          <select
            id={`${form.id ?? "new"}-ev-type`}
            value={form.type}
            onChange={(e) => {
              const type = e.target.value;
              setForm((f) => {
                if (f.id) return { ...f, type };
                return {
                  ...f,
                  type,
                  configJson: DEFAULT_CONFIGS[type] ?? f.configJson,
                  songHunt:
                    type === "song_hunt" ? defaultSongHuntConfig() : f.songHunt,
                };
              });
            }}
            className={INPUT}
          >
            <option value="secret_track">secret_track</option>
            <option value="song_hunt">song_hunt</option>
          </select>
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${form.id ?? "new"}-ev-title`}
          >
            title
          </label>
          <input
            id={`${form.id ?? "new"}-ev-title`}
            required
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            className={INPUT}
          />
        </div>
      </div>
      <div>
        <label
          className="block text-xs text-text-dim mb-1"
          htmlFor={`${form.id ?? "new"}-ev-desc`}
        >
          description
        </label>
        <input
          id={`${form.id ?? "new"}-ev-desc`}
          value={form.description}
          onChange={(e) =>
            setForm((f) => ({ ...f, description: e.target.value }))
          }
          className={INPUT}
        />
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${form.id ?? "new"}-ev-start`}
          >
            starts at
          </label>
          <input
            id={`${form.id ?? "new"}-ev-start`}
            type="datetime-local"
            required
            value={toLocalDatetimeValue(form.startsAt)}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                startsAt: fromLocalDatetimeValue(e.target.value),
              }))
            }
            className={INPUT}
          />
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${form.id ?? "new"}-ev-end`}
          >
            ends at
          </label>
          <input
            id={`${form.id ?? "new"}-ev-end`}
            type="datetime-local"
            required
            value={toLocalDatetimeValue(form.endsAt)}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                endsAt: fromLocalDatetimeValue(e.target.value),
              }))
            }
            className={INPUT}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={form.active}
          onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
        />
        active
      </label>
      {form.type === "song_hunt" ? (
        <SongHuntConfigFields
          form={form}
          setForm={setForm}
          catalogItems={catalogItems}
          fieldIdPrefix={form.id ?? "new"}
        />
      ) : (
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${form.id ?? "new"}-ev-config`}
          >
            config (json)
          </label>
          <textarea
            id={`${form.id ?? "new"}-ev-config`}
            rows={10}
            value={form.configJson}
            onChange={(e) =>
              setForm((f) => ({ ...f, configJson: e.target.value }))
            }
            className={`${INPUT} text-xs font-mono`}
          />
        </div>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={disabled || !form.title.trim()}
          className="text-sm text-purple bg-transparent border border-border px-4 py-2 rounded-sm cursor-pointer hover:border-purple disabled:opacity-50"
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-text-dim bg-transparent border-0 cursor-pointer"
          >
            cancel
          </button>
        )}
      </div>
    </form>
  );
}

function ItemForm({
  form,
  setForm,
  onSubmit,
  onCancel,
  submitLabel,
  disabled,
  idReadonly,
}: {
  form: ItemFormState;
  setForm: React.Dispatch<React.SetStateAction<ItemFormState>>;
  onSubmit: (e: React.FormEvent) => void;
  onCancel?: () => void;
  submitLabel: string;
  disabled?: boolean;
  idReadonly?: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${form.id || "new"}-item-id`}
          >
            id
          </label>
          <input
            id={`${form.id || "new"}-item-id`}
            required
            readOnly={idReadonly}
            value={form.id}
            onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
            className={`${INPUT} ${idReadonly ? "opacity-60" : ""}`}
            placeholder="e.g. vinyl-gold"
          />
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${form.id || "new"}-item-name`}
          >
            name
          </label>
          <input
            id={`${form.id || "new"}-item-name`}
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className={INPUT}
          />
        </div>
      </div>
      <div>
        <label
          className="block text-xs text-text-dim mb-1"
          htmlFor={`${form.id || "new"}-item-desc`}
        >
          description
        </label>
        <input
          id={`${form.id || "new"}-item-desc`}
          value={form.description}
          onChange={(e) =>
            setForm((f) => ({ ...f, description: e.target.value }))
          }
          className={INPUT}
        />
      </div>
      <div className="grid sm:grid-cols-3 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${form.id || "new"}-item-rarity`}
          >
            rarity
          </label>
          <select
            id={`${form.id || "new"}-item-rarity`}
            value={form.rarity}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                rarity: e.target.value as (typeof RARITIES)[number],
              }))
            }
            className={INPUT}
          >
            {RARITIES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor={`${form.id || "new"}-item-sell`}
          >
            sell price
          </label>
          <input
            id={`${form.id || "new"}-item-sell`}
            type="number"
            min={0}
            value={form.sellPrice}
            onChange={(e) =>
              setForm((f) => ({ ...f, sellPrice: e.target.value }))
            }
            className={INPUT}
            placeholder="empty = not sellable"
          />
        </div>
      </div>
      <div className="flex gap-6 text-xs">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.stackable}
            onChange={(e) =>
              setForm((f) => ({ ...f, stackable: e.target.checked }))
            }
          />
          stackable
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.equipable}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                equipable: e.target.checked,
                equipSlot: e.target.checked ? f.equipSlot : "",
              }))
            }
          />
          equipable
        </label>
        {form.equipable && (
          <label className="flex items-center gap-2 cursor-pointer">
            slot
            <select
              value={form.equipSlot}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  equipSlot: e.target.value as "" | "head" | "scenery",
                }))
              }
              className={INPUT}
            >
              <option value="">none</option>
              {EQUIP_SLOT_OPTIONS.map((slot) => (
                <option key={slot} value={slot}>
                  {slot}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={disabled || !form.id.trim() || !form.name.trim()}
          className="text-sm text-purple bg-transparent border border-border px-4 py-2 rounded-sm cursor-pointer hover:border-purple disabled:opacity-50"
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-text-dim bg-transparent border-0 cursor-pointer"
          >
            cancel
          </button>
        )}
      </div>
    </form>
  );
}

function EventRow({
  event,
  secret,
  onChange,
  catalogItems,
}: {
  event: AdminEvent;
  secret: string;
  onChange: () => void;
  catalogItems: CatalogItem[];
}) {
  const now = new Date();
  const status = getEventStatus(event, now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => eventToForm(event));

  useEffect(() => {
    if (!editing) setForm(eventToForm(event));
  }, [event, editing]);

  const toggleActive = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminFetch("/api/admin/events", secret, {
        method: "POST",
        body: JSON.stringify({
          id: event.id,
          type: event.type,
          title: event.title,
          description: event.description ?? undefined,
          active: !event.active,
          startsAt: event.starts_at,
          endsAt: event.ends_at,
          config: event.config,
        }),
      });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete event "${event.title}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/admin/events?id=${event.id}`, secret, {
        method: "DELETE",
      });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    const config = buildEventConfig(form);
    if (typeof config === "string") {
      setError(config);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminFetch("/api/admin/events", secret, {
        method: "POST",
        body: JSON.stringify({
          id: event.id,
          type: form.type,
          title: form.title,
          description: form.description || undefined,
          active: form.active,
          startsAt: form.startsAt,
          endsAt: form.endsAt,
          config,
        }),
      });
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr className="border-t border-border align-top">
        <td className="py-3 pr-4">
          <div className="font-medium">{event.title}</div>
          <div className="text-text-dim text-xs mt-0.5">{event.type}</div>
          {event.description && (
            <div className="text-text-dim text-xs mt-1 max-w-xs">
              {event.description}
            </div>
          )}
        </td>
        <td className="py-3 pr-4">
          <span className={STATUS_STYLES[status]}>{status}</span>
          {!event.active && status !== "inactive" && (
            <span className="text-text-dim text-xs block">flag off</span>
          )}
        </td>
        <td className="py-3 pr-4 text-xs text-text-dim whitespace-nowrap">
          <div>{new Date(event.starts_at).toLocaleString()}</div>
          <div>→ {new Date(event.ends_at).toLocaleString()}</div>
        </td>
        <td className="py-3 pr-4 text-xs text-text-dim max-w-[200px] truncate">
          {typeof event.config.rewardItemId === "string"
            ? event.config.rewardItemId
            : "—"}
        </td>
        <td className="py-3 text-right whitespace-nowrap">
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing((v) => !v)}
            className="text-purple text-xs bg-transparent border-0 cursor-pointer disabled:opacity-50 mr-3"
          >
            {editing ? "close" : "edit"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={toggleActive}
            className="text-cyan text-xs bg-transparent border-0 cursor-pointer disabled:opacity-50 mr-3"
          >
            {event.active ? "deactivate" : "activate"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="text-red text-xs bg-transparent border-0 cursor-pointer disabled:opacity-50"
          >
            delete
          </button>
          {error && !editing && (
            <div className="text-red text-xs mt-1">{error}</div>
          )}
        </td>
      </tr>
      {editing && (
        <tr className="border-t border-border bg-bg-panel">
          <td colSpan={5} className="p-4">
            <p className="text-xs text-cyan mb-4">edit event</p>
            <EventForm
              form={form}
              setForm={setForm}
              onSubmit={saveEdit}
              onCancel={() => {
                setEditing(false);
                setError(null);
                setForm(eventToForm(event));
              }}
              submitLabel="save changes"
              disabled={busy}
              catalogItems={catalogItems}
            />
            {error && <p className="text-red text-xs mt-2">{error}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function ItemRow({
  item,
  secret,
  onChange,
}: {
  item: CatalogItem;
  secret: string;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => itemToForm(item));

  useEffect(() => {
    if (!editing) setForm(itemToForm(item));
  }, [item, editing]);

  const remove = async () => {
    if (!confirm(`Delete item "${item.name}" (${item.id})?`)) return;
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/admin/items?id=${item.id}`, secret, {
        method: "DELETE",
      });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    const sellPrice = form.sellPrice.trim();
    if (
      sellPrice !== "" &&
      (Number.isNaN(Number(sellPrice)) || Number(sellPrice) < 0)
    ) {
      setError("Sell price must be a non-negative number");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminFetch("/api/admin/items", secret, {
        method: "POST",
        body: JSON.stringify(itemFormToPayload(form)),
      });
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr className="border-t border-border align-top">
        <td className="py-2 px-4 text-purple text-xs">{item.id}</td>
        <td className="py-2 px-4">
          <div>{item.name}</div>
          <div className="text-text-dim text-xs">{item.description}</div>
        </td>
        <td className="py-2 px-4 text-xs">{item.rarity}</td>
        <td className="py-2 px-4 text-xs text-text-dim">
          {item.sell_price ?? "—"}
        </td>
        <td className="py-2 px-4 text-xs text-text-dim">
          {item.stackable ? "stack " : ""}
          {item.equipable
            ? `equip${item.equip_slot ? ` (${item.equip_slot})` : ""}`
            : ""}
          {!item.stackable && !item.equipable ? "—" : ""}
        </td>
        <td className="py-2 px-4 text-right whitespace-nowrap">
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing((v) => !v)}
            className="text-purple text-xs bg-transparent border-0 cursor-pointer disabled:opacity-50 mr-3"
          >
            {editing ? "close" : "edit"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="text-red text-xs bg-transparent border-0 cursor-pointer disabled:opacity-50"
          >
            delete
          </button>
          {error && !editing && (
            <div className="text-red text-xs mt-1">{error}</div>
          )}
        </td>
      </tr>
      {editing && (
        <tr className="border-t border-border bg-bg-panel">
          <td colSpan={6} className="p-4">
            <p className="text-xs text-cyan mb-4">edit item</p>
            <ItemForm
              form={form}
              setForm={setForm}
              onSubmit={saveEdit}
              onCancel={() => {
                setEditing(false);
                setError(null);
                setForm(itemToForm(item));
              }}
              submitLabel="save changes"
              disabled={busy}
              idReadonly
            />
            {error && <p className="text-red text-xs mt-2">{error}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function EventsTable({
  events,
  secret,
  onChange,
  emptyLabel,
  catalogItems,
}: {
  events: AdminEvent[];
  secret: string;
  onChange: () => void;
  emptyLabel: string;
  catalogItems: CatalogItem[];
}) {
  if (events.length === 0) {
    return <p className="text-text-dim text-xs py-4">{emptyLabel}</p>;
  }

  return (
    <div className="overflow-x-auto border border-border rounded-sm">
      <table className="w-full text-sm text-left">
        <thead className="bg-bg-panel text-text-dim text-xs">
          <tr>
            <th className="py-2 px-4 font-normal">event</th>
            <th className="py-2 px-4 font-normal">status</th>
            <th className="py-2 px-4 font-normal">window</th>
            <th className="py-2 px-4 font-normal">reward</th>
            <th className="py-2 px-4 font-normal text-right">actions</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              secret={secret}
              onChange={onChange}
              catalogItems={catalogItems}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GrantItemPanel({
  secret,
  catalogItems,
}: {
  secret: string;
  catalogItems: CatalogItem[];
}) {
  const [itemId, setItemId] = useState("");
  const [targetMode, setTargetMode] = useState<"name" | "friendCode">("name");
  const [target, setTarget] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    const qty = Number.parseInt(quantity, 10);
    if (!itemId) {
      setError("Select an item");
      return;
    }
    if (!target.trim()) {
      setError("Enter a herzie name or friend code");
      return;
    }
    if (!Number.isFinite(qty) || qty < 1) {
      setError("Quantity must be a positive number");
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { itemId, quantity: qty };
      if (targetMode === "name") payload.herzieName = target.trim();
      else payload.friendCode = target.trim();
      const res = await adminFetch<{
        ok: boolean;
        itemId: string;
        quantity: number;
        total: number;
      }>("/api/admin/grant-item", secret, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const name = catalogItems.find((i) => i.id === itemId)?.name ?? itemId;
      setResult(
        `Granted ${res.quantity}× ${name} to ${target.trim()} (new total: ${res.total})`,
      );
      setTarget("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to grant item");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="border border-border rounded-sm p-6 bg-bg-panel space-y-4"
    >
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor="grant-item-id"
          >
            item
          </label>
          <select
            id="grant-item-id"
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            className={INPUT}
          >
            <option value="">select item…</option>
            {catalogItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.id})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor="grant-quantity"
          >
            quantity
          </label>
          <input
            id="grant-quantity"
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className={INPUT}
          />
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor="grant-target-mode"
          >
            target by
          </label>
          <select
            id="grant-target-mode"
            value={targetMode}
            onChange={(e) => {
              setTargetMode(e.target.value as "name" | "friendCode");
              setTarget("");
            }}
            className={INPUT}
          >
            <option value="name">herzie name</option>
            <option value="friendCode">friend code</option>
          </select>
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor="grant-target"
          >
            {targetMode === "name" ? "herzie name" : "friend code"}
          </label>
          <input
            id="grant-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={INPUT}
            placeholder={targetMode === "name" ? "e.g. Pixel" : "e.g. ABC123"}
          />
        </div>
      </div>
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={busy || !itemId || !target.trim()}
          className="text-sm text-purple bg-transparent border border-border px-4 py-2 rounded-sm cursor-pointer hover:border-purple disabled:opacity-50"
        >
          {busy ? "granting…" : "grant item"}
        </button>
        {result && <span className="text-green text-xs">{result}</span>}
        {error && <span className="text-red text-xs">{error}</span>}
      </div>
    </form>
  );
}

export function GameAdmin() {
  const [secret, setSecret] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEventForm, setShowEventForm] = useState(false);
  const [showItemForm, setShowItemForm] = useState(false);
  const [eventForm, setEventForm] = useState<EventFormState>(() =>
    newEventForm(),
  );
  const [itemForm, setItemForm] = useState<ItemFormState>(() => newItemForm());

  useEffect(() => {
    const stored = localStorage.getItem(SECRET_KEY);
    if (stored) {
      setSecret(stored);
      setSecretInput(stored);
    }
  }, []);

  const load = useCallback(async () => {
    if (!secret) return;
    setLoading(true);
    setError(null);
    try {
      const [itemsRes, eventsRes] = await Promise.all([
        adminFetch<{ items: CatalogItem[] }>("/api/admin/items", secret),
        adminFetch<{ events: AdminEvent[] }>("/api/admin/events", secret),
      ]);
      setItems(itemsRes.items);
      setEvents(eventsRes.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [secret]);

  useEffect(() => {
    if (secret) load();
  }, [secret, load]);

  const saveSecret = () => {
    localStorage.setItem(SECRET_KEY, secretInput);
    setSecret(secretInput);
  };

  const clearSecret = () => {
    localStorage.removeItem(SECRET_KEY);
    setSecret("");
    setSecretInput("");
    setItems([]);
    setEvents([]);
  };

  const now = new Date();
  const { running, previous } = useMemo(() => {
    const runningList: AdminEvent[] = [];
    const previousList: AdminEvent[] = [];
    for (const e of events) {
      const status = getEventStatus(e, now);
      if (status === "running" || status === "scheduled") {
        runningList.push(e);
      } else {
        previousList.push(e);
      }
    }
    return { running: runningList, previous: previousList };
  }, [events, now]);

  const createEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret) return;
    const config = buildEventConfig(eventForm);
    if (typeof config === "string") {
      setError(config);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await adminFetch("/api/admin/events", secret, {
        method: "POST",
        body: JSON.stringify({
          type: eventForm.type,
          title: eventForm.title,
          description: eventForm.description || undefined,
          active: eventForm.active,
          startsAt: eventForm.startsAt,
          endsAt: eventForm.endsAt,
          config,
        }),
      });
      setShowEventForm(false);
      setEventForm(newEventForm());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setLoading(false);
    }
  };

  const createItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret) return;
    const sellPrice = itemForm.sellPrice.trim();
    if (
      sellPrice !== "" &&
      (Number.isNaN(Number(sellPrice)) || Number(sellPrice) < 0)
    ) {
      setError("Sell price must be a non-negative number");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await adminFetch("/api/admin/items", secret, {
        method: "POST",
        body: JSON.stringify(itemFormToPayload(itemForm)),
      });
      setShowItemForm(false);
      setItemForm(newItemForm());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setLoading(false);
    }
  };

  if (!secret) {
    return (
      <section className="border border-border rounded-sm p-6 bg-bg-panel max-w-md">
        <h2 className="text-sm text-cyan mb-4">authenticate</h2>
        <label
          className="block text-xs text-text-dim mb-2"
          htmlFor="admin-secret"
        >
          Admin secret
        </label>
        <input
          id="admin-secret"
          type="password"
          value={secretInput}
          onChange={(e) => setSecretInput(e.target.value)}
          className={`${INPUT} mb-4`}
          placeholder="GAME_ADMIN_SECRET"
        />
        <button
          type="button"
          onClick={saveSecret}
          disabled={!secretInput.trim()}
          className="text-sm text-purple bg-transparent border border-border px-4 py-2 rounded-sm cursor-pointer hover:border-purple disabled:opacity-50"
        >
          connect
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <span className="text-green">connected</span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-cyan bg-transparent border-0 cursor-pointer disabled:opacity-50"
        >
          {loading ? "loading…" : "refresh"}
        </button>
        <button
          type="button"
          onClick={clearSecret}
          className="text-text-dim bg-transparent border-0 cursor-pointer"
        >
          disconnect
        </button>
      </div>

      {error && (
        <p className="text-red text-xs border border-red/30 bg-red/5 px-4 py-2 rounded-sm">
          {error}
        </p>
      )}

      <section>
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <h2 className="text-sm text-cyan">items catalog</h2>
          <button
            type="button"
            onClick={() => {
              setShowItemForm((v) => !v);
              if (showItemForm) setItemForm(newItemForm());
            }}
            className="text-xs text-purple bg-transparent border border-border px-3 py-1.5 rounded-sm cursor-pointer hover:border-purple"
          >
            {showItemForm ? "cancel" : "+ new item"}
          </button>
        </div>

        {showItemForm && (
          <div className="border border-border rounded-sm p-6 bg-bg-panel mb-6">
            <p className="text-xs text-text-dim mb-4">new item</p>
            <ItemForm
              form={itemForm}
              setForm={setItemForm}
              onSubmit={createItem}
              onCancel={() => {
                setShowItemForm(false);
                setItemForm(newItemForm());
              }}
              submitLabel="create item"
              disabled={loading}
            />
          </div>
        )}

        <div className="overflow-x-auto border border-border rounded-sm">
          <table className="w-full text-sm text-left">
            <thead className="bg-bg-panel text-text-dim text-xs">
              <tr>
                <th className="py-2 px-4 font-normal">id</th>
                <th className="py-2 px-4 font-normal">name</th>
                <th className="py-2 px-4 font-normal">rarity</th>
                <th className="py-2 px-4 font-normal">sell</th>
                <th className="py-2 px-4 font-normal">flags</th>
                <th className="py-2 px-4 font-normal text-right">actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-4 px-4 text-text-dim text-xs">
                    No items in catalog.
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    secret={secret}
                    onChange={load}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm text-cyan mb-4">grant item to player</h2>
        <GrantItemPanel secret={secret} catalogItems={items} />
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <h2 className="text-sm text-cyan">events</h2>
          <button
            type="button"
            onClick={() => {
              setShowEventForm((v) => !v);
              if (showEventForm) setEventForm(newEventForm());
            }}
            className="text-xs text-purple bg-transparent border border-border px-3 py-1.5 rounded-sm cursor-pointer hover:border-purple"
          >
            {showEventForm ? "cancel" : "+ new event"}
          </button>
        </div>

        {showEventForm && (
          <div className="border border-border rounded-sm p-6 bg-bg-panel mb-8">
            <p className="text-xs text-text-dim mb-4">new event</p>
            <EventForm
              form={eventForm}
              setForm={setEventForm}
              onSubmit={createEvent}
              onCancel={() => {
                setShowEventForm(false);
                setEventForm(newEventForm());
              }}
              submitLabel="create event"
              disabled={loading}
              catalogItems={items}
            />
          </div>
        )}

        <h3 className="text-xs text-text-dim mb-2 uppercase tracking-wide">
          running & upcoming
        </h3>
        <EventsTable
          events={running}
          secret={secret}
          onChange={load}
          emptyLabel="No active or scheduled events."
          catalogItems={items}
        />

        <h3 className="text-xs text-text-dim mb-2 mt-8 uppercase tracking-wide">
          previous
        </h3>
        <EventsTable
          events={previous}
          secret={secret}
          onChange={load}
          emptyLabel="No ended or inactive events."
          catalogItems={items}
        />
      </section>
    </div>
  );
}
