import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { useEffect, useRef } from "react";
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
 *     is most likely to throttle or drop a websocket, so trade_watch_loop in
 *     lib.rs still polls as a fallback, at 60s instead of 5s.
 *
 * Connection handling mirrors ChatPanel's: fresh token per connect (a stale
 * access token is the usual reason realtime goes quiet), a generation counter
 * so a stale channel's status callbacks can't trigger reconnects, and capped
 * exponential backoff.
 */
export function useTradeRequests(isOnline: boolean) {
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    let generation = 0;
    let supabase: ReturnType<typeof createClient> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;

    const clearReconnect = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) return;
      const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempts);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      const myGen = ++generation;
      if (channelRef.current) {
        channelRef.current.unsubscribe();
        channelRef.current = null;
      }
      herzies
        .getAuthConfig()
        .then((config) => {
          if (cancelled || myGen !== generation || !config) return;
          if (!supabase) {
            supabase = createClient(config.supabaseUrl, config.anonKey);
          }
          supabase.realtime.setAuth(config.accessToken);

          // Per-user topic. The Broadcast-authorization policy on
          // realtime.messages checks this against auth.uid(), so subscribing to
          // someone else's topic yields nothing rather than their invites.
          const channel = supabase
            .channel(`trade:${config.userId}`, { config: { private: true } })
            // supabase-js types "broadcast" as a literal union its own .on()
            // overloads won't accept for a custom event name, so the arguments
            // are cast. Same shape as ChatPanel's chat subscription.
            .on(
              // biome-ignore lint/suspicious/noExplicitAny: see above
              "broadcast" as any,
              // biome-ignore lint/suspicious/noExplicitAny: see above
              { event: "trade_request" } as any,
              (payload: { payload?: PendingTradeRequest }) => {
                if (cancelled || myGen !== generation) return;
                const request = payload?.payload;
                if (!request?.tradeId) return;
                void herzies.tradeRequestIngest(request);
              },
            )
            .subscribe((status, err) => {
              if (cancelled || myGen !== generation) return;
              if (status === "SUBSCRIBED") {
                reconnectAttempts = 0;
              } else if (
                status === "CHANNEL_ERROR" ||
                status === "TIMED_OUT" ||
                status === "CLOSED"
              ) {
                console.warn("trade realtime:", status, err);
                scheduleReconnect();
              }
            });

          channelRef.current = channel;
        })
        .catch(() => scheduleReconnect());
    };

    connect();

    return () => {
      cancelled = true;
      generation += 1;
      clearReconnect();
      if (channelRef.current) {
        channelRef.current.unsubscribe();
        channelRef.current = null;
      }
    };
  }, [isOnline]);
}
