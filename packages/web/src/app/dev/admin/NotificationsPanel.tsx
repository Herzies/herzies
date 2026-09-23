"use client";

import {
  type AdminEvent,
  type BossSettingsResponse,
  getEventStatus,
  STATUS_STYLES,
} from "./GameAdmin";

type NotificationRow = {
  name: string;
  trigger: string;
  gate: string;
  delivery: string;
  /** Which event types this row's "live now" listing should be filtered to. */
  eventTypes?: string[];
};

const NOTIFICATION_ROWS: NotificationRow[] = [
  {
    name: "Item granted",
    trigger: "sync tick (game-server.ts)",
    gate: "fires whenever a grant/drop happens",
    delivery: "native + activity log",
  },
  {
    name: "Event complete",
    trigger: "sync tick (game-server.ts)",
    gate: "events.active + time window",
    delivery: "native + activity log",
    eventTypes: ["boss_fight", "song_hunt", "secret_track"],
  },
  {
    name: "Song hunt first-finder",
    trigger: "sync tick, checkSecretTrackEvents (game-server.ts)",
    gate: "event active, not yet in notified_hunts",
    delivery: "native + activity log",
    eventTypes: ["song_hunt", "secret_track"],
  },
  {
    name: "Event starting",
    trigger: "events_watch_loop, 30s poll (lib.rs)",
    gate: "events.active + time window",
    delivery: "native + activity log",
    eventTypes: ["boss_fight", "song_hunt", "secret_track"],
  },
  {
    name: "Boss fight starting",
    trigger:
      "events_watch_loop poll + weekly cron (spawn_scheduled_boss_fight)",
    gate: "boss_fight_settings.auto_spawn, not in boss_fight_skips this week",
    delivery: "native + activity log",
    eventTypes: ["boss_fight"],
  },
  {
    name: "Trade request",
    trigger:
      "Postgres realtime broadcast (broadcast_trade_request), poll fallback",
    gate: "always on",
    delivery: "native",
  },
  {
    name: "Friend request",
    trigger: "desktop client",
    gate: "always on",
    delivery: "native",
  },
];

function LiveEvents({
  events,
  now,
  types,
}: {
  events: AdminEvent[];
  now: Date;
  types: string[];
}) {
  const live = events.filter(
    (e) =>
      types.includes(e.type) &&
      (getEventStatus(e, now) === "running" ||
        getEventStatus(e, now) === "scheduled"),
  );

  if (live.length === 0) {
    return <span className="text-text-dim">none live or scheduled</span>;
  }

  return (
    <ul className="space-y-1">
      {live.map((e) => {
        const status = getEventStatus(e, now);
        return (
          <li key={e.id}>
            <span className={STATUS_STYLES[status]}>{status}</span>
            {" — "}
            {e.title}
          </li>
        );
      })}
    </ul>
  );
}

export function NotificationsPanel({
  events,
  boss,
  now,
}: {
  events: AdminEvent[];
  boss: BossSettingsResponse | null;
  now: Date;
}) {
  return (
    <div className="space-y-6">
      <p className="text-xs text-text-dim max-w-2xl">
        There's no dedicated notifications table — every row below is a
        notification the game actually fires, sourced from{" "}
        <code>packages/shared/src/game-server.ts</code> and{" "}
        <code>packages/desktop/src-tauri/src/lib.rs</code>. The "live now"
        column reflects what's currently active/scheduled among the events
        already loaded on this page.
      </p>

      <div className="overflow-x-auto border border-border rounded-sm">
        <table className="w-full text-sm text-left">
          <thead className="bg-bg-panel text-text-dim text-xs">
            <tr>
              <th className="py-2 px-4 font-normal">notification</th>
              <th className="py-2 px-4 font-normal">trigger</th>
              <th className="py-2 px-4 font-normal">gate</th>
              <th className="py-2 px-4 font-normal">delivery</th>
              <th className="py-2 px-4 font-normal">live now</th>
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_ROWS.map((row) => (
              <tr key={row.name} className="border-t border-border align-top">
                <td className="py-2 px-4 whitespace-nowrap">{row.name}</td>
                <td className="py-2 px-4 text-text-dim">{row.trigger}</td>
                <td className="py-2 px-4 text-text-dim">{row.gate}</td>
                <td className="py-2 px-4 text-text-dim">{row.delivery}</td>
                <td className="py-2 px-4">
                  {row.name === "Boss fight starting" ? (
                    <div className="space-y-1">
                      {boss ? (
                        <>
                          <div>
                            auto-spawn:{" "}
                            <span
                              className={
                                boss.settings.autoSpawn
                                  ? "text-green"
                                  : "text-red"
                              }
                            >
                              {boss.settings.autoSpawn ? "on" : "off"}
                            </span>
                          </div>
                          {boss.skippedWeeks.length > 0 && (
                            <div className="text-yellow">
                              skipped: {boss.skippedWeeks.join(", ")}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-text-dim">
                          boss settings not loaded
                        </span>
                      )}
                      {row.eventTypes && (
                        <LiveEvents
                          events={events}
                          now={now}
                          types={row.eventTypes}
                        />
                      )}
                    </div>
                  ) : row.eventTypes ? (
                    <LiveEvents
                      events={events}
                      now={now}
                      types={row.eventTypes}
                    />
                  ) : (
                    <span className="text-text-dim">n/a</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
