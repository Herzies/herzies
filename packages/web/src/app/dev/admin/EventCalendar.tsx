"use client";

import {
  type AdminEvent,
  EVENT_TYPE_LABELS,
  EVENT_TYPE_STYLES,
  type EventStatus,
  getEventStatus,
} from "./admin-shared";

const WEEKS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TYPE_ORDER = [
  "boss_fight",
  "song_hunt",
  "merchant",
  "treat_trader",
  "secret_track",
];

/** Local midnight of this week's Monday. */
function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const STATUS_CHIP: Record<EventStatus, string> = {
  running: "font-bold",
  scheduled: "",
  "needs setup": "border-dashed opacity-80",
  "awaiting approval": "border-dashed",
  skipped: "line-through opacity-40",
  ended: "opacity-50",
  inactive: "opacity-40",
};

/**
 * Rolling five-week view from this week's Monday, in the admin's local time.
 * Events overlap freely, so each day stacks every event touching it; a
 * multi-day event repeats on each of its days, labelled on the first.
 */
export function EventCalendar({
  events,
  now,
  selectedId,
  onSelect,
}: {
  events: AdminEvent[];
  now: Date;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const first = startOfWeek(now);
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    return d;
  });
  const rangeEnd = new Date(first.getTime() + WEEKS * 7 * DAY_MS + DAY_MS);

  const visible = events
    .filter(
      (e) => new Date(e.ends_at) > first && new Date(e.starts_at) < rangeEnd,
    )
    .sort(
      (a, b) =>
        TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
        a.starts_at.localeCompare(b.starts_at),
    );

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="grid grid-cols-7 min-w-[720px] border-l border-t border-border">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="text-xs text-text-dim px-2 py-1 border-r border-b border-border bg-bg-panel"
            >
              {d}
            </div>
          ))}
          {days.map((day) => {
            const dayEnd = new Date(day);
            dayEnd.setDate(dayEnd.getDate() + 1);
            const onDay = visible.filter(
              (e) =>
                new Date(e.starts_at) < dayEnd && new Date(e.ends_at) > day,
            );
            const isToday = day.getTime() === today.getTime();
            const isPast = dayEnd <= now;
            return (
              <div
                key={day.toISOString()}
                className={`min-h-24 border-r border-b border-border p-1 space-y-1 ${isPast ? "bg-bg-panel/50" : ""}`}
              >
                <div
                  className={`text-xs ${isToday ? "text-purple font-bold" : "text-text-dim"}`}
                >
                  {day.getDate() === 1 || day === days[0]
                    ? day.toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })
                    : day.getDate()}
                </div>
                {onDay.map((e) => {
                  const start = new Date(e.starts_at);
                  const startsToday = start >= day && start < dayEnd;
                  const status = getEventStatus(e, now);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => onSelect(e.id)}
                      title={`${e.title} — ${status}\n${start.toLocaleString()} → ${new Date(e.ends_at).toLocaleString()}`}
                      className={`block w-full text-left text-[11px] leading-tight px-1 py-0.5 border-l-2 border rounded-sm truncate cursor-pointer ${EVENT_TYPE_STYLES[e.type] ?? "border-border text-text"} ${STATUS_CHIP[status]} ${selectedId === e.id ? "ring-1 ring-purple" : ""}`}
                    >
                      {status === "needs setup" && "! "}
                      {status === "awaiting approval" && "? "}
                      {startsToday
                        ? `${start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} ${e.title}`
                        : `… ${e.title}`}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-text-dim">
        {TYPE_ORDER.map((t) => (
          <span key={t} className="flex items-center gap-1">
            <span
              className={`inline-block w-2.5 h-2.5 border ${EVENT_TYPE_STYLES[t]}`}
            />
            {EVENT_TYPE_LABELS[t]}
          </span>
        ))}
        <span>
          <span className="font-bold">bold</span> live
        </span>
        <span>! needs setup</span>
        <span>? awaiting your approval</span>
        <span className="line-through">skipped</span>
      </div>
    </div>
  );
}
