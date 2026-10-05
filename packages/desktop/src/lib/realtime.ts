import {
  createClient,
  type RealtimeChannel,
  type RealtimeChannelOptions,
  type SupabaseClient,
} from "@supabase/supabase-js";

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
