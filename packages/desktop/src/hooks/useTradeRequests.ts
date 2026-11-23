import type { TradeUpdate } from "@herzies/shared";
import { useEffect } from "react";
import { useBroadcast } from "../lib/realtime";
import { publishTradeUpdate, setTradeChannelLive } from "../lib/tradeLive";
import { herzies, type PendingTradeRequest } from "../tauri-bridge";

/**
 * Receives incoming trade requests over Realtime Broadcast.
 *
 * Replaces the 5s /trade-pending poll that ran for as long as the window was
 * hidden — the largest single source of backend calls in the app, and still a
 * delivery path that made an invite take up to 5s to show up. A DB trigger now
 * broadcasts each new request to a private per-user topic
 * (00058_trade_request_broadcast.sql) and it arrives immediately.
 *
 * Two things this must get right, both of which the 5s poll got for free:
 *
 *  1. **It has to stay subscribed while the window is hidden**, which is the
 *     only time the notification matters. So this is a hook mounted once at the
 *     app root, NOT a component tied to a view — ChatPanel's channel is torn
 *     down and rebuilt on every navigation away from Home, which would be a
 *     correctness bug here rather than just wasted reconnects.
 *  2. **It must not be the only path.** A hidden window is exactly where the OS
 *     is most likely to throttle or drop a websocket. The fallback is the
 *     `pendingTradeRequest` every /sync carries (at most 60s apart while hidden,
 *     notification included) — so a missed broadcast means an invite up to a
 *     minute late, not a lost one. (A dedicated 5s /trade-pending poll used to
 *     cover this, at ~17k calls a day per idle install; it was dropped
 *     without first confirming broadcasts survive a long stay in the tray.)
 *
 * The same channel carries every change to a trade you're in
 * (`trade_update`, 00157_trade_live_updates.sql), handed to an open
 * TradeView through lib/tradeLive.
 *
 * Connection handling (fresh token per connect, generation counter, capped
 * backoff) is useBroadcast's, shared with ChatPanel.
 */
export function useTradeRequests(isOnline: boolean) {
  const live = useBroadcast<{
    trade_request: PendingTradeRequest;
    trade_update: TradeUpdate;
  }>(isOnline, {
    // Per-user topic. The Broadcast-authorization policy on realtime.messages
    // checks this against auth.uid(), so subscribing to someone else's topic
    // yields nothing rather than their invites.
    topic: (userId) => `trade:${userId}`,
    on: {
      trade_request: (request) => {
        if (!request?.tradeId) return;
        void herzies.tradeRequestIngest(request);
      },
      trade_update: (update) => {
        if (update?.id) publishTradeUpdate(update);
      },
    },
    label: "trade",
  });
  useEffect(() => setTradeChannelLive(live), [live]);
}
