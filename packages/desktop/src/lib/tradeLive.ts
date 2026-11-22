import type { Trade, TradeUpdate } from "@herzies/shared";
import { stableMerge } from "./stableMerge";

/**
 * Live trade changes: every change to a trade is broadcast to both sides the
 * moment it commits (00157_trade_live_updates.sql), on the per-user trade
 * channel useTradeRequests keeps open at the app root. TradeView applies
 * them, and polls only as a fallback, faster while the channel is down.
 */

type Listener = (update: TradeUpdate) => void;
const listeners = new Set<Listener>();
let channelLive = false;

/** A trade_update from the channel (useTradeRequests). */
export function publishTradeUpdate(update: TradeUpdate): void {
  for (const l of listeners) l(update);
}

/** Calls `listener` with every trade_update until the returned unsubscribe. */
export function onTradeUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the trade channel is subscribed, so updates are arriving. */
export function setTradeChannelLive(live: boolean): void {
  channelLive = live;
}

export function tradeChannelLive(): boolean {
  return channelLive;
}

const TERMINAL: ReadonlySet<Trade["state"]> = new Set([
  "completed",
  "cancelled",
]);

/** Whether a trade is over: completed or cancelled, for good. */
export function isFinished(state: Trade["state"] | undefined): boolean {
  return state !== undefined && TERMINAL.has(state);
}

/**
 * `next` (a poll answer or a broadcast) over the trade as held, if any.
 *
 * A broadcast and a poll can cross on the way in, so an older picture
 * (a lower `version`) never replaces a newer one, and a finished trade stays
 * finished. The names come once, from the first poll (see tradePoll): until
 * that's in, there's no trade to show and a nameless update is dropped (the
 * poll brings it). Unchanged parts keep their identity, so nothing
 * re-renders for a repeat.
 */
export function mergeTrade(
  prev: Trade | null,
  next: TradeUpdate,
): Trade | null {
  // Nothing held yet, or a different trade: it starts with the names.
  if (!prev || next.id !== prev.id) {
    const { initiatorName, targetName } = next;
    return initiatorName !== undefined && targetName !== undefined
      ? { ...next, initiatorName, targetName }
      : (prev ?? null);
  }
  if (isFinished(prev.state)) return prev;
  if (
    prev.version !== undefined &&
    next.version !== undefined &&
    next.version < prev.version
  ) {
    return prev;
  }
  return stableMerge(prev, {
    ...next,
    initiatorName: next.initiatorName ?? prev.initiatorName,
    targetName: next.targetName ?? prev.targetName,
  });
}
