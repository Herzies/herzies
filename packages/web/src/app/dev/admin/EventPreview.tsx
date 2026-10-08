"use client";

import { MERCHANT_NAME, TREAT_TRADER_NAME } from "@herzies/shared";
import { useState } from "react";
import { isEventConfigComplete } from "@/lib/event-config";
import {
  type CatalogItem,
  datetimeLocalToIso,
  EVENT_TYPE_STYLES,
  formatDuration,
  INPUT,
  toDatetimeLocalValue,
} from "./admin-shared";

/** What the preview needs of an event, saved or still in the form. */
export type PreviewEvent = {
  type: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  config: Record<string, unknown>;
};

type Hint = { text: string; unlocksAt: string; audioKey?: string };
/** Numbers, or the form's strings while it is still being filled in. */
type StockLine = {
  itemId: string;
  price: number | string;
  perPlayerLimit?: number | string | null;
  totalStock?: number | string | null;
};

const present = (v: unknown) => v != null && v !== "";

/**
 * Roughly what a player sees of an event in the desktop Events tab, at a
 * chosen moment — a look-alike of EventsView / BossFightPanel / MerchantPanel,
 * not the real components, so it can drift. Unlike the player view it keeps
 * locked hints readable (dimmed), because checking them is the point.
 */
export function EventPreview({
  event,
  catalogItems,
  problem,
}: {
  event: PreviewEvent;
  catalogItems: CatalogItem[];
  /** Why the form can't be saved yet, shown above the preview. */
  problem?: string | null;
}) {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  // Default to now while it runs, otherwise its first minute.
  const [asOf, setAsOf] = useState(() => {
    const now = new Date();
    return toDatetimeLocalValue(now >= start && now < end ? now : start);
  });
  const at = new Date(datetimeLocalToIso(asOf));
  const moment = Number.isNaN(at.getTime()) ? start : at;

  const item = (id: unknown) =>
    typeof id === "string" && id
      ? (catalogItems.find((i) => i.id === id) ?? { id, name: id, rarity: "" })
      : null;

  const warnings: string[] = [];
  if (problem) warnings.push(problem);
  if (!isEventConfigComplete(event.type, event.config)) {
    warnings.push("Incomplete — a series occurrence stays in draft like this");
  }
  if (!(end > start)) warnings.push("Ends before it starts");

  const phase =
    moment < start
      ? `starts in ${formatDuration(start.getTime() - moment.getTime())}`
      : moment >= end
        ? "ended"
        : `live · ${formatDuration(end.getTime() - moment.getTime())} left`;

  const setTo = (d: Date) => setAsOf(toDatetimeLocalValue(d));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 text-xs">
        <label className="block">
          <span className="block text-text-dim mb-1">as of</span>
          <input
            type="datetime-local"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className={`${INPUT} text-xs py-1`}
          />
        </label>
        {[
          ["start", start],
          ["now", new Date()],
          ["last hour", new Date(end.getTime() - 3_600_000)],
        ].map(([label, d]) => (
          <button
            key={label as string}
            type="button"
            onClick={() => setTo(d as Date)}
            className="text-cyan bg-transparent border-0 cursor-pointer pb-1.5"
          >
            {label as string}
          </button>
        ))}
      </div>

      {warnings.map((w) => (
        <p key={w} className="text-orange text-xs">
          ⚠ {w}
        </p>
      ))}

      <div
        className={`max-w-sm border rounded-sm p-4 ${EVENT_TYPE_STYLES[event.type] ?? "border-border"}`}
      >
        <div className="flex justify-between text-[10px] uppercase tracking-wide mb-3">
          <span>
            {event.type === "merchant"
              ? MERCHANT_NAME
              : event.type === "treat_trader"
                ? TREAT_TRADER_NAME
                : event.type.replace("_", " ")}
          </span>
          <span className="text-text-dim normal-case">{phase}</span>
        </div>
        <div className="text-text">
          {event.type === "song_hunt" ? (
            <SongHuntPreview event={event} moment={moment} item={item} />
          ) : event.type === "boss_fight" ? (
            <BossPreview event={event} item={item} />
          ) : event.type === "merchant" || event.type === "treat_trader" ? (
            <MerchantPreview event={event} item={item} />
          ) : (
            <>
              <div className="font-bold">{event.title || "(untitled)"}</div>
              <pre className="text-[10px] text-text-dim mt-2 whitespace-pre-wrap">
                {JSON.stringify(event.config, null, 2)}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type ItemLookup = (
  id: unknown,
) => Pick<CatalogItem, "id" | "name" | "rarity"> | null;

function ItemName({ item }: { item: ReturnType<ItemLookup> }) {
  if (!item) return <span className="text-red">none</span>;
  return (
    <span className="text-text underline">
      {item.name}
      {item.rarity ? (
        <span className="text-text-dim no-underline"> ({item.rarity})</span>
      ) : null}
    </span>
  );
}

function SongHuntPreview({
  event,
  moment,
  item,
}: {
  event: PreviewEvent;
  moment: Date;
  item: ItemLookup;
}) {
  const c = event.config;
  const hints = (Array.isArray(c.hints) ? c.hints : []) as Hint[];
  const reward = item(c.rewardItemId);
  const rewardName =
    typeof c.rewardItemName === "string" ? c.rewardItemName : null;
  return (
    <>
      <div className="text-center text-cyan">{event.title || "(untitled)"}</div>
      {event.description && (
        <div className="text-xs text-text-dim mt-2">{event.description}</div>
      )}
      <div className="mt-3 text-center text-[10px] text-text-dim space-y-0.5">
        <div>
          Reward:{" "}
          {reward && rewardName && reward.name === reward.id ? (
            <span className="text-text underline">
              {rewardName} <span className="text-text-dim">(new item)</span>
            </span>
          ) : (
            <ItemName item={reward} />
          )}
        </div>
        <div>Rewards left: {String(c.maxClaims ?? "—")}</div>
      </div>
      <div className="mt-4 text-[10px] text-text-dim mb-1">Clues</div>
      {hints.length === 0 && (
        <div className="text-xs text-text-dim">No clues.</div>
      )}
      {hints.map((h, i) => {
        const unlocksAt = new Date(h.unlocksAt);
        const unlocked = moment >= unlocksAt;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: hints have no id
            key={i}
            className="border-b border-border py-1 text-xs"
          >
            <span className={unlocked ? "" : "text-text-dim"}>
              {i + 1}. {h.text || <em>(empty)</em>}
            </span>
            {h.audioKey && unlocked && (
              <span className="ml-3 text-cyan">▶ play (3/3 left)</span>
            )}
            {!unlocked && (
              <div className="text-[10px] text-text-dim">
                locked · unlocks in{" "}
                {formatDuration(unlocksAt.getTime() - moment.getTime())}
                {h.audioKey ? " · has audio" : ""}
              </div>
            )}
          </div>
        );
      })}
      <div className="mt-3 text-[10px] text-text-dim">
        Answer (hidden from players): {String(c.trackArtist || "?")} –{" "}
        {String(c.trackTitle || "?")}
      </div>
    </>
  );
}

function BossPreview({
  event,
  item,
}: {
  event: PreviewEvent;
  item: ItemLookup;
}) {
  const c = event.config;
  const genres = (
    Array.isArray(c.hatedGenres) ? c.hatedGenres : []
  ) as string[];
  const maxHp = Number(c.maxHp);
  return (
    <>
      <div className="text-center text-[16px] font-bold text-red">
        {event.title || "(untitled)"}
      </div>
      {event.description && (
        <div className="text-xs text-text-dim mt-2 text-center">
          {event.description}
        </div>
      )}
      <div className="mt-3 h-2 bg-red/20 rounded-sm">
        <div className="h-full bg-red rounded-sm w-full" />
      </div>
      <div className="text-[10px] text-text-dim text-center mt-1">
        HP{" "}
        {Number.isFinite(maxHp) && maxHp > 0
          ? `${maxHp} / ${maxHp}`
          : "rolled at spawn"}
      </div>
      <div className="mt-3 flex flex-wrap gap-1 justify-center">
        {genres.length > 0 ? (
          genres.map((g) => (
            <span
              key={g}
              className="text-[10px] border border-red text-red rounded-full px-2"
            >
              {g}
            </span>
          ))
        ) : (
          <span className="text-[10px] text-text-dim">
            hated genres rolled at spawn
          </span>
        )}
      </div>
      <div className="mt-3 text-[10px] text-text-dim space-y-0.5">
        <div>
          Hidden until defeated — reward:{" "}
          <ItemName item={item(c.rewardItemId)} />
        </div>
        {present(c.topRewardItemId) && (
          <div>
            top {String(c.topCount ?? 3)} also get:{" "}
            <ItemName item={item(c.topRewardItemId)} />
          </div>
        )}
      </div>
    </>
  );
}

function MerchantPreview({
  event,
  item,
}: {
  event: PreviewEvent;
  item: ItemLookup;
}) {
  const stock = (
    Array.isArray(event.config.stock) ? event.config.stock : []
  ) as StockLine[];
  const treats = event.type === "treat_trader";
  return (
    <>
      <div
        className={`text-center font-bold ${treats ? "text-orange" : "text-yellow"}`}
      >
        {event.title || (treats ? TREAT_TRADER_NAME : MERCHANT_NAME)}
      </div>
      {event.description && (
        <div className="text-xs text-text-dim mt-2 text-center">
          {event.description}
        </div>
      )}
      <div className="mt-3">
        {stock.length === 0 && (
          <div className="text-xs text-text-dim">Nothing for sale.</div>
        )}
        {stock.map((line, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: form lines may share an empty itemId
            key={i}
            className="flex justify-between gap-3 border-b border-border py-1 text-xs"
          >
            <div>
              <ItemName item={item(line.itemId)} />
              <div className="text-[10px] text-text-dim">
                {[
                  present(line.totalStock) ? `${line.totalStock} left` : null,
                  present(line.perPlayerLimit)
                    ? `0/${line.perPlayerLimit} bought`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "unlimited"}
              </div>
            </div>
            <span
              className={`whitespace-nowrap ${treats ? "text-orange" : "text-yellow"}`}
            >
              {present(line.price) ? line.price : "?"}{" "}
              {treats ? "treats" : "coins"}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
