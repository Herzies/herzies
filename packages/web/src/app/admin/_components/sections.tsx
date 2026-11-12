"use client";

import type { SongHuntConfig, SongHuntHint } from "@herzies/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAdminData } from "./admin-data";
import {
  type AdminEvent,
  adminFetch,
  type CatalogItem,
  datetimeLocalToIso,
  EVENT_TYPE_LABELS,
  type EventSeries,
  getEventStatus,
  INPUT,
  isoToDatetimeLocal,
  STATUS_STYLES,
  toDatetimeLocalValue,
} from "./admin-shared";
import { CheatFlagsPanel } from "./CheatFlagsPanel";
import { EventCalendar } from "./EventCalendar";
import { EventPreview, type PreviewEvent } from "./EventPreview";
import { EventSeriesPanel } from "./EventSeriesPanel";
import {
  BossFightConfigFields,
  type BossFightConfigForm,
  bossFightConfigFromRecord,
  bossFightFormToConfig,
  defaultBossFightConfig,
  defaultMerchantConfig,
  MerchantConfigFields,
  type MerchantConfigForm,
  merchantConfigFromRecord,
  merchantFormToConfig,
} from "./event-fields";
import { NotificationsPanel } from "./NotificationsPanel";
import { SongPoolPanel } from "./SongPoolPanel";
import { XpPanel } from "./XpPanel";

const RARITIES = ["common", "uncommon", "rare", "legendary", "mythic"] as const;

type SongHuntHintForm = {
  text: string;
  unlocksAt: string;
  audioKey?: string;
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
  /** Set when editing an occurrence of a recurring series. */
  seriesId?: string | null;
  skipped?: boolean;
  type: string;
  title: string;
  description: string;
  active: boolean;
  startsAt: string;
  endsAt: string;
  configJson: string;
  songHunt: SongHuntConfigForm;
  bossFight: BossFightConfigForm;
  merchant: MerchantConfigForm;
};

const EQUIP_SLOT_OPTIONS = [
  "head",
  "face",
  "body",
  "scenery",
  "ground",
  "modifier",
] as const;

export type ItemFormState = {
  id: string;
  name: string;
  description: string;
  rarity: (typeof RARITIES)[number];
  sellPrice: string;
  stackable: boolean;
  equipable: boolean;
  equipSlot: "" | (typeof EQUIP_SLOT_OPTIONS)[number];
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
  // The floors come from the game's own curves; only the Tower Guard's
  // reward for the month's best climber is set here.
  tower: JSON.stringify(
    { topRewardItemId: "power-dice-3", excludeHerzies: ["slowtaxi"] },
    null,
    2,
  ),
};

function defaultWindow(): { startsAt: string; endsAt: string } {
  const start = new Date();
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    startsAt: toDatetimeLocalValue(start),
    endsAt: toDatetimeLocalValue(end),
  };
}

function defaultSongHuntConfig(): SongHuntConfigForm {
  return {
    trackTitle: "",
    trackArtist: "",
    rewardItemId: "",
    rewardItemName: "",
    maxClaims: "50",
    hints: [
      { text: "First hint", unlocksAt: toDatetimeLocalValue(new Date()) },
    ],
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
              ? isoToDatetimeLocal(hint.unlocksAt)
              : toDatetimeLocalValue(new Date()),
          audioKey:
            typeof hint.audioKey === "string" ? hint.audioKey : undefined,
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
        unlocksAt: datetimeLocalToIso(h.unlocksAt),
        ...(h.audioKey ? { audioKey: h.audioKey } : {}),
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
    bossFight: defaultBossFightConfig(),
    merchant: defaultMerchantConfig(),
    ...overrides,
  };
}

function eventToForm(event: AdminEvent): EventFormState {
  return {
    id: event.id,
    seriesId: event.series_id ?? null,
    skipped: event.skipped ?? false,
    type: event.type,
    title: event.title,
    description: event.description ?? "",
    active: event.active,
    startsAt: isoToDatetimeLocal(event.starts_at),
    endsAt: isoToDatetimeLocal(event.ends_at),
    configJson: JSON.stringify(event.config, null, 2),
    songHunt:
      event.type === "song_hunt"
        ? songHuntConfigFromRecord(event.config)
        : defaultSongHuntConfig(),
    bossFight:
      event.type === "boss_fight"
        ? bossFightConfigFromRecord(event.config, event.boss?.maxHp)
        : defaultBossFightConfig(),
    merchant:
      event.type === "merchant" || event.type === "treat_trader"
        ? merchantConfigFromRecord(event.config)
        : defaultMerchantConfig(),
  };
}

export function newItemForm(overrides?: Partial<ItemFormState>): ItemFormState {
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

export function itemToForm(item: CatalogItem): ItemFormState {
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

export function itemFormToPayload(form: ItemFormState) {
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
  if (form.type === "boss_fight") {
    return bossFightFormToConfig(form.bossFight);
  }
  if (form.type === "merchant" || form.type === "treat_trader") {
    return merchantFormToConfig(form.merchant);
  }
  return parseEventConfig(form.configJson);
}

/**
 * The form as the preview sees it. A form that doesn't validate yet still
 * previews what it has, with the reason alongside.
 */
function formToPreview(form: EventFormState): {
  event: PreviewEvent;
  problem: string | null;
} {
  const built = buildEventConfig(form);
  const problem = typeof built === "string" ? built : null;
  const config =
    typeof built !== "string"
      ? built
      : form.type === "song_hunt"
        ? { ...songHuntConfigToPayload(form.songHunt) }
        : form.type === "boss_fight"
          ? { ...form.bossFight }
          : form.type === "merchant" || form.type === "treat_trader"
            ? { ...form.merchant }
            : {};
  return {
    event: {
      type: form.type,
      title: form.title,
      description: form.description || null,
      startsAt: datetimeLocalToIso(form.startsAt),
      endsAt: datetimeLocalToIso(form.endsAt),
      config,
    },
    problem,
  };
}

function SongHuntConfigFields({
  form,
  setForm,
  catalogItems,
  fieldIdPrefix,
  secret,
}: {
  form: EventFormState;
  setForm: React.Dispatch<React.SetStateAction<EventFormState>>;
  catalogItems: CatalogItem[];
  fieldIdPrefix: string;
  secret: string;
}) {
  const [uploadingHint, setUploadingHint] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

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

  const uploadHintAudio = async (index: number, file: File) => {
    setUploadingHint(index);
    setUploadError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/admin/events/hint-audio", {
        method: "POST",
        headers: secret ? { "x-admin-secret": secret } : {},
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error ?? "Failed to upload audio",
        );
      }
      updateHint(index, { audioKey: (data as { audioKey: string }).audioKey });
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Failed to upload audio");
    } finally {
      setUploadingHint(null);
    }
  };

  const addHint = () => {
    setForm((f) => ({
      ...f,
      songHunt: {
        ...f.songHunt,
        hints: [
          ...f.songHunt.hints,
          { text: "", unlocksAt: toDatetimeLocalValue(new Date()) },
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
              key={index}
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
                  unlocks at
                </label>
                <input
                  id={`${fieldIdPrefix}-hint-${index}-unlock`}
                  type="datetime-local"
                  required
                  value={hint.unlocksAt}
                  onChange={(e) =>
                    updateHint(index, { unlocksAt: e.target.value })
                  }
                  className={INPUT}
                />
              </div>
              <div>
                <label
                  className="block text-xs text-text-dim mb-1"
                  htmlFor={`${fieldIdPrefix}-hint-${index}-audio`}
                >
                  audio snippet (optional, max 3 plays/user)
                </label>
                <input
                  id={`${fieldIdPrefix}-hint-${index}-audio`}
                  type="file"
                  accept="audio/*"
                  disabled={uploadingHint === index}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadHintAudio(index, file);
                    e.target.value = "";
                  }}
                  className="text-xs text-text-dim"
                />
                {uploadingHint === index && (
                  <p className="text-xs text-cyan mt-1">uploading…</p>
                )}
                {hint.audioKey && uploadingHint !== index && (
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-green">
                      uploaded ({hint.audioKey})
                    </span>
                    <button
                      type="button"
                      onClick={() => updateHint(index, { audioKey: undefined })}
                      className="text-xs text-red bg-transparent border-0 cursor-pointer"
                    >
                      clear
                    </button>
                  </div>
                )}
                {uploadError && uploadingHint === null && (
                  <p className="text-xs text-red mt-1">{uploadError}</p>
                )}
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
  secret,
  live,
}: {
  form: EventFormState;
  setForm: React.Dispatch<React.SetStateAction<EventFormState>>;
  onSubmit: (e: React.FormEvent) => void;
  onCancel?: () => void;
  submitLabel: string;
  disabled?: boolean;
  catalogItems: CatalogItem[];
  secret: string;
  live?: AdminEvent["boss"];
}) {
  const [previewing, setPreviewing] = useState(false);
  const preview = previewing ? formToPreview(form) : null;
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
                  bossFight:
                    type === "boss_fight"
                      ? defaultBossFightConfig()
                      : f.bossFight,
                  merchant:
                    type === "merchant" || type === "treat_trader"
                      ? defaultMerchantConfig()
                      : f.merchant,
                };
              });
            }}
            className={INPUT}
          >
            <option value="secret_track">secret_track</option>
            <option value="song_hunt">song_hunt (Orphiez)</option>
            <option value="boss_fight">boss_fight</option>
            <option value="merchant">merchant (Good ol&apos; George)</option>
            <option value="treat_trader">
              treat_trader (Nandor the Treatless, priced in treats)
            </option>
            <option value="tower">tower (the Tower: floors of mobs)</option>
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
            value={form.startsAt}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                startsAt: e.target.value,
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
            value={form.endsAt}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                endsAt: e.target.value,
              }))
            }
            className={INPUT}
          />
        </div>
      </div>
      {form.seriesId ? (
        // Occurrences go live on their own once complete; skip is the off
        // switch (see /api/admin/events).
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={!!form.skipped}
            onChange={(e) =>
              setForm((f) => ({ ...f, skipped: e.target.checked }))
            }
          />
          skip this occurrence
          <span className="text-text-dim">
            (part of a series — goes live by itself once it&apos;s set up)
          </span>
        </label>
      ) : (
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) =>
              setForm((f) => ({ ...f, active: e.target.checked }))
            }
          />
          active
        </label>
      )}
      {form.type === "song_hunt" ? (
        <SongHuntConfigFields
          form={form}
          setForm={setForm}
          catalogItems={catalogItems}
          fieldIdPrefix={form.id ?? "new"}
          secret={secret}
        />
      ) : form.type === "boss_fight" ? (
        <BossFightConfigFields
          boss={form.bossFight}
          update={(patch) =>
            setForm((f) => ({ ...f, bossFight: { ...f.bossFight, ...patch } }))
          }
          catalogItems={catalogItems}
          fieldIdPrefix={form.id ?? "new"}
          live={live}
        />
      ) : form.type === "merchant" || form.type === "treat_trader" ? (
        <MerchantConfigFields
          priceLabel={form.type === "treat_trader" ? "price (treats)" : "price"}
          merchant={form.merchant}
          setMerchant={(merchant) => setForm((f) => ({ ...f, merchant }))}
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
        <button
          type="button"
          onClick={() => setPreviewing((v) => !v)}
          className="text-sm text-cyan bg-transparent border-0 cursor-pointer"
        >
          {previewing ? "hide preview" : "preview"}
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
      {preview && (
        <EventPreview
          event={preview.event}
          problem={preview.problem}
          catalogItems={catalogItems}
        />
      )}
    </form>
  );
}

export function ItemForm({
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
                  equipSlot: e.target.value as
                    | ""
                    | "head"
                    | "face"
                    | "body"
                    | "scenery"
                    | "ground",
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
  defaultEditing = false,
}: {
  event: AdminEvent;
  secret: string;
  onChange: () => void;
  catalogItems: CatalogItem[];
  defaultEditing?: boolean;
}) {
  const now = new Date();
  const status = getEventStatus(event, now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(defaultEditing);
  const [previewing, setPreviewing] = useState(false);
  const fromSeries = !!event.series_id;
  const [form, setForm] = useState(() => eventToForm(event));

  useEffect(() => {
    if (!editing) setForm(eventToForm(event));
  }, [event, editing]);

  /** Re-save the event as it is, plus `extra` (skip, activate, approve). */
  const quickSave = async (extra: Record<string, unknown>) => {
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
          startsAt: event.starts_at,
          endsAt: event.ends_at,
          config: event.config,
          ...extra,
        }),
      });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = () =>
    quickSave(
      fromSeries ? { skipped: !event.skipped } : { active: !event.active },
    );

  const remove = async () => {
    const prompt = fromSeries
      ? `Delete this "${event.title}" for good? The series won't recreate it.`
      : `Delete event "${event.title}"?`;
    if (!confirm(prompt)) return;
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
          // Saving the form is the admin curating it, which approves any
          // pending curator proposal it replaces.
          ...(fromSeries ? { skipped: !!form.skipped, approve: true } : {}),
          startsAt: datetimeLocalToIso(form.startsAt),
          endsAt: datetimeLocalToIso(form.endsAt),
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
        <td className="py-3 px-4">
          <div className="font-medium">{event.title}</div>
          <div className="text-text-dim text-xs mt-0.5">
            {EVENT_TYPE_LABELS[event.type] ?? event.type}
            {fromSeries && (
              <span className="ml-2 text-cyan">
                recurring{event.customized ? " · edited" : ""}
              </span>
            )}
          </div>
          {event.type === "song_hunt" &&
            typeof event.config.trackTitle === "string" && (
              <div className="text-xs mt-1">
                <span className="text-text-dim">answer: </span>
                {String(event.config.trackArtist)} – {event.config.trackTitle}
                {Array.isArray(event.config.hints) && (
                  <span className="text-text-dim">
                    {" "}
                    · {event.config.hints.length} hints
                  </span>
                )}
              </div>
            )}
          {event.description && (
            <div className="text-text-dim text-xs mt-1 max-w-xs">
              {event.description}
            </div>
          )}
        </td>
        <td className="py-3 px-4">
          <span className={STATUS_STYLES[status]}>{status}</span>
          {!event.active &&
            status !== "inactive" &&
            status !== "skipped" &&
            status !== "needs setup" &&
            status !== "awaiting approval" && (
              <span className="text-text-dim text-xs block">flag off</span>
            )}
        </td>
        <td className="py-3 px-4 text-xs text-text-dim whitespace-nowrap">
          <div>{new Date(event.starts_at).toLocaleString()}</div>
          <div>→ {new Date(event.ends_at).toLocaleString()}</div>
        </td>
        <td className="py-3 px-4 text-xs text-text-dim max-w-[200px] truncate">
          {typeof event.config.rewardItemId === "string"
            ? event.config.rewardItemId
            : Array.isArray(event.config.stock)
              ? `${event.config.stock.length} item${event.config.stock.length === 1 ? "" : "s"} for sale`
              : "—"}
          {event.boss && (
            <div className="mt-0.5">
              hp {Math.round(event.boss.hp)} / {Math.round(event.boss.maxHp)}
              {event.boss.killed && <span className="text-green"> killed</span>}
              {event.boss.escaped && <span className="text-red"> escaped</span>}
            </div>
          )}
        </td>
        <td className="py-3 px-4 text-right whitespace-nowrap">
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing((v) => !v)}
            className="text-purple text-xs bg-transparent border-0 cursor-pointer disabled:opacity-50 mr-3"
          >
            {editing ? "close" : "edit"}
          </button>
          {!editing && (
            <button
              type="button"
              onClick={() => setPreviewing((v) => !v)}
              className="text-cyan text-xs bg-transparent border-0 cursor-pointer mr-3"
            >
              {previewing ? "hide preview" : "preview"}
            </button>
          )}
          {status === "awaiting approval" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => quickSave({ approve: true })}
              className="text-green text-xs bg-transparent border-0 cursor-pointer disabled:opacity-50 mr-3"
            >
              approve
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={toggleActive}
            className="text-cyan text-xs bg-transparent border-0 cursor-pointer disabled:opacity-50 mr-3"
          >
            {fromSeries
              ? event.skipped
                ? "unskip"
                : "skip"
              : event.active
                ? "deactivate"
                : "activate"}
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
      {previewing && !editing && (
        <tr className="border-t border-border bg-bg-panel">
          <td colSpan={5} className="p-4">
            <EventPreview
              event={{
                type: event.type,
                title: event.title,
                description: event.description,
                startsAt: event.starts_at,
                endsAt: event.ends_at,
                config: event.config,
              }}
              catalogItems={catalogItems}
            />
          </td>
        </tr>
      )}
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
              secret={secret}
              live={event.boss}
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
  openId,
}: {
  events: AdminEvent[];
  secret: string;
  onChange: () => void;
  emptyLabel: string;
  catalogItems: CatalogItem[];
  /** Row to open in edit mode on mount. */
  openId?: string;
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
              defaultEditing={e.id === openId}
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
      // Keep the target: granting several items to the same player is the
      // common case, and clearing it left the button disabled after a grant.
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

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="text-red text-xs border border-red/30 bg-red/5 px-4 py-2 rounded-md">
      {error}
    </p>
  );
}

function SectionHeading({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {action}
    </div>
  );
}

const TOGGLE_BUTTON =
  "text-xs text-purple bg-transparent border border-border px-3 py-1.5 rounded-md cursor-pointer hover:border-purple";

/** Calendar, one-off events, what's live and what's past. */
export function EventsSection() {
  const { secret, items, events, load, loading, error } = useAdminData();
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Occurrence picked on the calendar, shown open for editing. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEventForm, setShowEventForm] = useState(false);
  const [eventForm, setEventForm] = useState<EventFormState>(() =>
    newEventForm(),
  );

  const now = new Date();
  const { upcoming, previous } = useMemo(() => {
    const upcomingList: AdminEvent[] = [];
    const previousList: AdminEvent[] = [];
    // Series run four weeks ahead; the list only needs the next one of each.
    const nextOfSeries = new Map<string, AdminEvent>();
    for (const e of events) {
      const status = getEventStatus(e, now);
      if (status === "running") {
        upcomingList.push(e);
      } else if (
        status === "scheduled" ||
        status === "needs setup" ||
        status === "awaiting approval" ||
        (status === "skipped" && new Date(e.ends_at) > now)
      ) {
        if (!e.series_id) {
          upcomingList.push(e);
          continue;
        }
        const seen = nextOfSeries.get(e.series_id);
        if (!seen || e.starts_at < seen.starts_at) {
          nextOfSeries.set(e.series_id, e);
        }
      } else {
        previousList.push(e);
      }
    }
    upcomingList.push(...nextOfSeries.values());
    upcomingList.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return { upcoming: upcomingList, previous: previousList };
  }, [events, now]);

  const selected = selectedId
    ? events.find((e) => e.id === selectedId)
    : undefined;

  const createEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    const config = buildEventConfig(eventForm);
    if (typeof config === "string") {
      setLocalError(config);
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      await adminFetch("/api/admin/events", secret, {
        method: "POST",
        body: JSON.stringify({
          type: eventForm.type,
          title: eventForm.title,
          description: eventForm.description || undefined,
          active: eventForm.active,
          startsAt: datetimeLocalToIso(eventForm.startsAt),
          endsAt: datetimeLocalToIso(eventForm.endsAt),
          config,
        }),
      });
      setShowEventForm(false);
      setEventForm(newEventForm());
      await load();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <ErrorNote error={localError ?? error} />
      <div>
        <SectionHeading
          title="Calendar"
          action={
            <button
              type="button"
              onClick={() => {
                setShowEventForm((v) => !v);
                if (showEventForm) setEventForm(newEventForm());
              }}
              className={TOGGLE_BUTTON}
            >
              {showEventForm ? "cancel" : "+ one-off event"}
            </button>
          }
        />

        {showEventForm && (
          <div className="border border-border rounded-lg p-6 bg-bg-panel mb-8">
            <p className="text-xs text-text-dim mb-4">new one-off event</p>
            <EventForm
              form={eventForm}
              setForm={setEventForm}
              onSubmit={createEvent}
              onCancel={() => {
                setShowEventForm(false);
                setEventForm(newEventForm());
              }}
              submitLabel="create event"
              disabled={busy || loading}
              catalogItems={items}
              secret={secret}
            />
          </div>
        )}

        <EventCalendar
          events={events}
          now={now}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
        />

        {selected && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs text-text-dim uppercase tracking-wide">
                selected
              </h3>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="text-xs text-text-dim bg-transparent border-0 cursor-pointer"
              >
                close
              </button>
            </div>
            <EventsTable
              // Remount per selection so the row opens in edit mode.
              key={selected.id}
              events={[selected]}
              secret={secret}
              onChange={load}
              emptyLabel=""
              catalogItems={items}
              openId={selected.id}
            />
          </div>
        )}
      </div>

      <div>
        <h3 className="text-xs text-text-dim mb-2 uppercase tracking-wide">
          live & upcoming
        </h3>
        <EventsTable
          events={upcoming}
          secret={secret}
          onChange={load}
          emptyLabel="Nothing live or scheduled."
          catalogItems={items}
        />
      </div>

      <div>
        <h3 className="text-xs text-text-dim mb-2 uppercase tracking-wide">
          previous
        </h3>
        <EventsTable
          events={previous}
          secret={secret}
          onChange={load}
          emptyLabel="No ended or inactive events."
          catalogItems={items}
        />
      </div>
    </div>
  );
}

/** Recurring series (00081). */
export function SeriesSection() {
  const { secret, items, events, series, seriesMissing, load, error } =
    useAdminData();
  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      {seriesMissing && (
        <p className="text-yellow text-xs">
          Couldn&apos;t load series. This database probably doesn&apos;t have
          migration 00081_event_series yet.
        </p>
      )}
      <EventSeriesPanel
        series={series}
        events={events}
        secret={secret}
        catalogItems={items}
        now={new Date()}
        onChange={load}
      />
    </div>
  );
}

export function SongPoolSection() {
  const { secret, events } = useAdminData();
  return <SongPoolPanel secret={secret} events={events} />;
}

export function XpSection() {
  const { secret } = useAdminData();
  return <XpPanel secret={secret} />;
}

export function NotificationsSection() {
  const { events, series } = useAdminData();
  return (
    <NotificationsPanel events={events} series={series} now={new Date()} />
  );
}

/** Hand an item to a player. */
export function GrantSection() {
  const { secret, items } = useAdminData();
  return <GrantItemPanel secret={secret} catalogItems={items} />;
}

export function CheatFlagsSection() {
  const { secret } = useAdminData();
  return <CheatFlagsPanel secret={secret} />;
}
