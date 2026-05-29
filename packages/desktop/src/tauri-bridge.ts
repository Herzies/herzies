import type {
  ActiveMultiplier,
  FriendRequestSummary,
  FriendSearchResult,
  GameEvent,
  Herzie,
  HerzieProfile,
  Inventory,
  PendingFriendRequest,
  Trade,
} from "@herzies/shared";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";

export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  friendCode?: string | null;
  content: string;
  itemRefs: string[];
  /** Friend codes @-mentioned in the message body. */
  userRefs?: string[];
  createdAt: string;
}

export interface PendingTradeRequest {
  tradeId: string;
  fromName: string;
  fromFriendCode: string;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  level: number;
  stage: number;
  totalMinutes: number;
}

export type { FriendRequestSummary, FriendSearchResult, PendingFriendRequest };

export interface AppState {
  herzie: Herzie | null;
  nowPlaying: {
    title: string;
    artist: string;
    albumArtUrl?: string;
    vibe?: string;
    tags?: string[];
  } | null;
  multipliers: ActiveMultiplier[] | null;
  isOnline: boolean;
  isConnected: boolean;
  version: string;
  equipped: string[];
  chatMessages: ChatMessage[];
  inventory: Inventory | null;
  inventoryCurrency: number;
  friends: Record<string, HerzieProfile>;
  pendingTradeRequest?: PendingTradeRequest | null;
  pendingFriendRequest?: PendingFriendRequest | null;
  incomingFriendRequests: FriendRequestSummary[];
  outgoingFriendRequests: FriendRequestSummary[];
}

export const herzies = {
  getState: () => invoke<AppState>("get_state"),

  onStateUpdate: (cb: (state: AppState) => void) => {
    let cancelled = false;
    const unlisten = listen<AppState>("state-update", (event) => {
      if (!cancelled) cb(event.payload);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  },

  login: () => invoke<boolean>("login"),
  logout: () => invoke<void>("logout"),
  registerHerzie: (name: string) => invoke<void>("register_herzie", { name }),

  friendAdd: (code: string) =>
    invoke<{ success: boolean; message: string }>("friend_add", { code }),
  friendRemove: (code: string) =>
    invoke<{ success: boolean; message: string }>("friend_remove", { code }),
  friendLookup: (codes: string[]) =>
    invoke<Record<string, HerzieProfile>>("friend_lookup", { codes }),
  friendRequestAccept: (requestId: string) =>
    invoke<{ success: boolean; message: string }>("friend_request_accept", {
      requestId,
    }),
  friendRequestDecline: (requestId: string) =>
    invoke<{ success: boolean; message: string }>("friend_request_decline", {
      requestId,
    }),
  friendRequestCancel: (requestId: string) =>
    invoke<{ success: boolean; message: string }>("friend_request_cancel", {
      requestId,
    }),
  friendSearch: (query: string) =>
    invoke<FriendSearchResult[]>("friend_search", { query }),

  fetchInventory: () =>
    invoke<{
      inventory: Inventory;
      currency: number;
      equipped: string[];
    } | null>("fetch_inventory"),
  sellItem: (itemId: string, quantity: number) =>
    invoke<{
      earned: number;
      newCurrency: number;
      inventory: Inventory;
    } | null>("sell_item", { itemId, quantity }),
  equipItem: (itemId: string, action: "equip" | "unequip") =>
    invoke<{ equipped: string[] }>("equip_item", { itemId, action }),

  tradeCreate: (targetCode: string) =>
    invoke<{ tradeId: string } | null>("trade_create", { targetCode }),
  tradeJoin: (tradeId: string) => invoke<boolean>("trade_join", { tradeId }),
  tradeOffer: (
    tradeId: string,
    offer: { items: Record<string, number>; currency: number },
  ) => invoke<boolean>("trade_offer", { tradeId, offer }),
  tradeLock: (tradeId: string) => invoke<boolean>("trade_lock", { tradeId }),
  tradeAccept: (tradeId: string) =>
    invoke<{ completed: boolean } | null>("trade_accept", { tradeId }),
  tradeCancel: (tradeId: string) =>
    invoke<boolean>("trade_cancel", { tradeId }),
  tradePoll: (tradeId: string) =>
    invoke<Trade | null>("trade_poll", { tradeId }),

  fetchActiveEvents: () =>
    invoke<{ events: GameEvent[] }>("fetch_active_events"),

  fetchPreviousHunt: () =>
    invoke<{ events: GameEvent[] }>("fetch_previous_hunt"),

  fetchLeaderboard: () =>
    invoke<{ entries: LeaderboardEntry[] }>("fetch_leaderboard"),

  getAuthConfig: () =>
    invoke<{
      supabaseUrl: string;
      anonKey: string;
      accessToken: string;
      userId: string;
    } | null>("get_auth_config"),

  chatFetch: () => invoke<{ messages: ChatMessage[] } | null>("chat_fetch"),
  chatSend: (content: string, itemRefs: string[], userRefs: string[]) =>
    invoke<{ message: ChatMessage } | null>("chat_send", {
      content,
      itemRefs,
      userRefs,
    }),

  /** Open a URL in the system browser (WKWebView does not navigate external https). */
  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),

  testNotification: () => invoke<void>("test_notification"),
  testActivity: () => invoke<void>("test_activity"),
  /** macOS only — raw MediaRemote JSON for debugging Now Playing detection. */
  debugMediaRemoteNowPlaying: () =>
    invoke<string | null>("debug_media_remote_now_playing"),
  quit: () => invoke<void>("quit"),

  /**
   * Deep-link payloads from notification clicks.
   *   - `"trade:<tradeId>"` — open TradeView and auto-join the trade
   *   - `"friends:requests"` — open FriendsView on the Requests tab
   *   - any other string — treated as an item ID, opens InventoryView focused on that item
   */
  onDeepLink: (cb: (payload: string) => void) => {
    let cancelled = false;
    const unlisten = listen<string>("deep-link", (event) => {
      if (!cancelled) cb(event.payload);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  },

  onActivity: (cb: (message: string) => void) => {
    let cancelled = false;
    const unlisten = listen<string>("activity", (event) => {
      if (!cancelled) cb(event.payload);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  },
};

/**
 * Tracks whether the Tauri window currently has focus. The tray window is
 * hidden when blurred (200ms after on_blur in tray.rs), so this doubles as
 * "is the window actually visible to the user." Use it to pause animation
 * timers that would otherwise keep burning CPU while the window is invisible.
 */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    // Sandbox / Vite dev runs in a plain browser — no Tauri window APIs.
    if (!isTauri()) return;

    const w = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    w.onFocusChanged(({ payload }) => setFocused(payload)).then((fn) => {
      unlisten = fn;
    });
    w.isFocused()
      .then((v) => setFocused(v))
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);
  return focused;
}

export type UpdateInstallEvent =
  | { kind: "started"; contentLength: number | undefined }
  | { kind: "progress"; downloaded: number; total: number | undefined }
  | { kind: "finished" };

/**
 * Thin wrapper around @tauri-apps/plugin-updater. Returns the Update handle if
 * a newer version is available, or null if the app is current. Resolves to
 * null (instead of throwing) on transient network or signature errors so the
 * caller can decide whether to surface anything.
 */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch (err) {
    console.warn("Update check failed:", err);
    return null;
  }
}

/**
 * Download + install + relaunch. Streams progress through onProgress so the
 * caller can render a percentage. Throws if download/install fails — the
 * caller should surface the error.
 */
export async function installUpdate(
  update: Update,
  onProgress?: (e: UpdateInstallEvent) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | undefined;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength;
        onProgress?.({ kind: "started", contentLength: total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.({ kind: "progress", downloaded, total });
        break;
      case "Finished":
        onProgress?.({ kind: "finished" });
        break;
    }
  });
  await relaunch();
}
