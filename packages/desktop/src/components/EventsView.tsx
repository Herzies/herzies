import type { GameEvent } from "@herzies/shared";
import { getItem, RARITY_COLORS as ITEM_RARITY_COLORS } from "@herzies/shared";
import { useEffect, useState } from "react";
import { herzies, useWindowFocused } from "../tauri-bridge";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { View } from "./View";

function formatCountdown(endsAt: string): string {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "ended";
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  if (days > 0) return `${days}d ${h}h left`;
  if (hours > 0) return `${hours}h left`;
  return "< 1h left";
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  if (ms < 1000) return `${ms}ms ago`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

type SongHuntConfig = {
  trackTitle: string;
  trackArtist: string;
  rewardItemId: string;
  maxClaims: number;
  hints: Array<{
    text: string;
    unlocksAt: string;
    unlocked: boolean;
  }>;
  firstFinders: Array<{
    name: string;
    claimedAt: string;
  }>;
};

const EVENTS_POLL_MS = 10_000;

export function EventsView({
  eventsTabVisible,
}: {
  /** Tab stays mounted but hidden; only poll while user is on Events. */
  eventsTabVisible: boolean;
}) {
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [previousHunt, setPreviousHunt] = useState<GameEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [inspectOverlay, setInspectOverlay] = useState<"item" | null>(null);
  const focused = useWindowFocused();

  useEffect(() => {
    herzies.fetchPreviousHunt().then((data) => {
      setPreviousHunt(data.events[0]);
    });
  }, []);

  useEffect(() => {
    herzies
      .fetchActiveEvents()
      .then((data) => {
        setEvents(data.events);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!focused || !eventsTabVisible) return;

    const refresh = () => {
      herzies.fetchActiveEvents().then((data) => setEvents(data.events));
    };

    refresh();
    const interval = setInterval(refresh, EVENTS_POLL_MS);
    return () => clearInterval(interval);
  }, [focused, eventsTabVisible]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-dim">
        Loading...
      </div>
    );
  }

  const hunt = events.find((e) => e.type === "song_hunt");
  const previousHuntConfig = previousHunt?.config as SongHuntConfig;

  if (!hunt && previousHunt) {
    return (
      <View title="Events" colour="red">
        <div>
          <div>
            <h2 className="text-ui-2xl mb-3 font-bold">
              Song Hunt{" "}
              <span className="text-ui text-text-dim">
                (
                {Intl.DateTimeFormat("en-US", {
                  day: "numeric",
                  month: "short",
                }).format(getNextMonday())}
                )
              </span>
            </h2>

            <div className="text-ui-lg">
              Starts in {countDownToMonday(getNextMonday())}.
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-border">
            <h2 className="text-ui-lg mb-3 font-bold">
              Previous{" "}
              <span className="text-ui text-text-dim">
                (
                {Intl.DateTimeFormat("en-US", {
                  day: "numeric",
                  month: "short",
                }).format(new Date(previousHunt?.startsAt ?? ""))}
                )
              </span>
            </h2>

            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <h2 className="text-ui font-bold text-text-dim">Type:</h2>
                  <div className="text-ui">Song Hunt</div>
                </div>

                <div className="flex flex-col gap-1">
                  <h2 className="text-ui font-bold text-text-dim">Answer:</h2>
                  <div className="text-ui">
                    {previousHuntConfig?.trackArtist} -{" "}
                    {previousHuntConfig?.trackTitle}
                  </div>
                </div>

                {previousHuntConfig.rewardItemId ? (
                  <div className="flex flex-col gap-1">
                    <h2 className="text-ui font-bold text-text-dim">Reward:</h2>
                    <div className="text-ui">
                      {getItem(previousHuntConfig.rewardItemId)?.name}
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-col gap-1">
                  <h2 className="text-ui font-bold text-text-dim">Finders:</h2>
                  <div className="max-h-28 overflow-y-auto">
                    {previousHuntConfig?.firstFinders?.map((finder, i) => (
                      <div key={finder.name} className="text-ui text-yellow">
                        {i + 1}. {finder.name}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </View>
    );
  }

  if (!hunt) {
    return (
      <div className="flex h-full items-center justify-center text-center text-xs text-text-dim">
        No active Song Hunt. Check back Monday!
      </div>
    );
  }

  const config = hunt.config as {
    rewardItemId: string;
    maxClaims: number;
    hints: Array<{
      text: string;
      unlocksAt: string;
      unlocked: boolean;
    }>;
    firstFinders: Array<{
      name: string;
      claimedAt: string;
    }>;
  };

  const rewardItem = getItem(config.rewardItemId);

  return (
    <View title="Events" colour="red" childrenClassName="flex flex-col h-full">
      <div className="grid flex-1 place-items-center">
        <div>
          <div className="text-center">{hunt.title}</div>
          <div className="text-ui-sm text-text-dim">{hunt.description}</div>

          <div className="mt-3 flex flex-col gap-0.5 text-center text-[10px] text-text-dim">
            <div>Duration: {formatCountdown(hunt.endsAt)}</div>
            {rewardItem ? (
              <>
                <div>
                  Reward:{" "}
                  <button
                    className="cursor-pointer border-none bg-transparent text-ui underline"
                    style={{ color: ITEM_RARITY_COLORS[rewardItem.rarity] }}
                    type="button"
                    onClick={() => setInspectOverlay("item")}
                  >
                    {rewardItem.name}
                  </button>
                </div>
                <div>
                  Rewards left: {config.maxClaims - config.firstFinders.length}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div>
        <div>
          <div className="mb-2.5">
            <div className="mb-1 text-[10px] text-text-dim">Clues</div>
            {config.hints.map((hint, i) => (
              <div
                key={hint.unlocksAt}
                className="mb-1 border-b border-border py-1"
              >
                {hint.unlocked ? (
                  <div className="text-ui text-text">
                    {i + 1}. {hint.text}
                  </div>
                ) : (
                  <>
                    <div className="font-mono text-ui text-text-dim">
                      {i + 1}.{" "}
                      <span className={hint.unlocked ? "" : "blur-[1px]"}>
                        {hint.text}
                      </span>
                    </div>
                    <div className="text-ui-sm text-[#444]">
                      unlocks{" "}
                      {formatCountdown(hint.unlocksAt).replace(" left", "")}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          <div>
            <div className="mb-1 text-[10px] text-text-dim">
              Finders ({config?.firstFinders?.length ?? 0})
            </div>
            {config?.firstFinders?.length &&
            config?.firstFinders?.length > 0 ? (
              <div className="max-h-28 overflow-y-auto">
                {config.firstFinders.map((finder, i) => (
                  <div
                    key={`${finder.name}-${finder.claimedAt}`}
                    className="flex justify-between border-b border-border py-0.5 text-ui last:border-b-0"
                  >
                    <span className="text-yellow">
                      {i + 1}. {finder.name}
                    </span>
                    <span className="text-text-dim">
                      {timeAgo(finder.claimedAt)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-ui text-text-dim">
                No one has found it yet...
              </div>
            )}
          </div>
        </div>
      </div>

      {inspectOverlay === "item" && (
        <ItemInspectOverlay
          itemId={config.rewardItemId}
          onClose={() => setInspectOverlay(null)}
        />
      )}
    </View>
  );
}

function countDownToMonday(date: Date): string {
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  if (diff <= 0) return "Today";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const remainderMs = diff % (1000 * 60 * 60 * 24);
  const hours = Math.floor(remainderMs / (1000 * 60 * 60));

  if (days > 0) {
    return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  }
  // If less than 1 day left, show just hours
  const onlyHours = Math.floor(diff / (1000 * 60 * 60));
  return `${onlyHours}h`;
}

function getNextMonday(): Date {
  const now = new Date();
  const day = now.getDay();
  const daysUntilMonday = (8 - day) % 7 || 7;
  const nextMonday = new Date(now);
  nextMonday.setHours(0, 0, 0, 0);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  return nextMonday;
}
