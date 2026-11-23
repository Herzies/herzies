import {
  createClient,
  type RealtimeChannel,
  type RealtimeChannelOptions,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { herzies } from "../tauri-bridge";

/**
 * One Supabase client — so one Realtime websocket — for the whole app.
 *
 * Chat and trade invites each used to create their own client, which meant
 * two sockets per user (Realtime is billed on peak concurrent connections),
 * and ChatPanel built a fresh one every time Home remounted.
 */
let client: SupabaseClient | null = null;

export function realtimeClient(
  supabaseUrl: string,
  anonKey: string,
): SupabaseClient {
  if (!client) client = createClient(supabaseUrl, anonKey);
  return client;
}

/** Channels still leaving, by topic. */
const leaving = new Map<string, Promise<unknown>>();

/**
 * A fresh channel on the shared client.
 *
 * realtime-js hands back the *existing* channel for a topic until that one has
 * finished leaving, so reconnecting (or remounting) straight after a teardown
 * could re-bind onto the dying channel. This waits for any earlier channel on
 * the same topic to be fully removed first.
 */
export async function openChannel(
  supabase: SupabaseClient,
  topic: string,
  opts: RealtimeChannelOptions,
): Promise<RealtimeChannel> {
  await leaving.get(topic);
  return supabase.channel(topic, opts);
}

/** Unsubscribes and removes a channel opened with `openChannel`. */
export function closeChannel(channel: RealtimeChannel) {
  if (!client) return;
  const topic = channel.subTopic;
  const done: Promise<unknown> = client
    .removeChannel(channel)
    .catch(() => {})
    .finally(() => {
      if (leaving.get(topic) === done) leaving.delete(topic);
    });
  leaving.set(topic, done);
}

/** What each Broadcast event on a channel carries, by event name. */
type BroadcastEvents = Record<string, unknown>;

export interface BroadcastOptions<E extends BroadcastEvents> {
  /** The private topic to join, given the signed-in user's id. */
  topic: (userId: string) => string;
  /** A handler per Broadcast event to listen for, called with its payload
   * (absent if the sender sent none). One topic is one channel, so every
   * event on it is listened to here. */
  on: { [K in keyof E]: (payload: E[K] | undefined) => void };
  /** Called on every (re)subscribe, e.g. to resync what was missed. */
  onSubscribed?: () => void;
  /** Prefix for the status warnings in the console. */
  label: string;
}

/**
 * Listens to a private Broadcast topic's events while `enabled`, and says
 * whether the channel is currently subscribed.
 *
 * Pulls a fresh token on every connect (a stale access token is the usual
 * reason realtime goes quiet), keeps a generation counter so a stale
 * channel's callbacks can't trigger reconnects, and reconnects with capped
 * exponential backoff whenever the channel errors or closes. The callbacks
 * are read through a ref, so they needn't be stable.
 */
export function useBroadcast<E extends BroadcastEvents>(
  enabled: boolean,
  opts: BroadcastOptions<E>,
): boolean {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let generation = 0;
    let channel: RealtimeChannel | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;

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
      // Tear down any previous channel so we don't stack subscriptions.
      if (channel) {
        closeChannel(channel);
        channel = null;
      }
      herzies
        .getAuthConfig()
        .then(async (config) => {
          if (cancelled || myGen !== generation || !config) return;
          // One socket for the app, one channel per feature.
          const supabase = realtimeClient(config.supabaseUrl, config.anonKey);
          supabase.realtime.setAuth(config.accessToken);
          // Private topics need auth (setAuth above) and pass the
          // Broadcast-authorization policy on realtime.messages.
          const fresh = await openChannel(
            supabase,
            optsRef.current.topic(config.userId),
            { config: { private: true } },
          );
          if (cancelled || myGen !== generation) {
            closeChannel(fresh);
            return;
          }
          for (const event of Object.keys(optsRef.current.on)) {
            fresh.on("broadcast", { event }, (message) => {
              if (cancelled || myGen !== generation) return;
              optsRef.current.on[event]?.(message.payload);
            });
          }
          channel = fresh.subscribe((status, err) => {
            if (cancelled || myGen !== generation) return;
            if (status === "SUBSCRIBED") {
              reconnectAttempts = 0;
              setSubscribed(true);
              optsRef.current.onSubscribed?.();
            } else if (
              status === "CHANNEL_ERROR" ||
              status === "TIMED_OUT" ||
              status === "CLOSED"
            ) {
              console.warn(`${optsRef.current.label} realtime:`, status, err);
              setSubscribed(false);
              scheduleReconnect();
            }
          });
        })
        .catch(() => scheduleReconnect());
    };

    connect();

    return () => {
      cancelled = true;
      generation += 1;
      clearTimeout(reconnectTimer ?? undefined);
      if (channel) closeChannel(channel);
      setSubscribed(false);
    };
  }, [enabled]);

  return subscribed;
}
