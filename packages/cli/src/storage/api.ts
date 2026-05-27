/**
 * Game server API client.
 *
 * All server communication goes through the game server API.
 * No direct Supabase access from the CLI.
 */

import type {
  EventNotification,
  GameEvent,
  Herzie,
  HerzieProfile,
  Inventory,
  PendingTradeRequest,
  SyncRequest,
  SyncResponse,
  Trade,
  TradeOffer,
} from "@herzies/shared";
import { loadSession, saveSession } from "./state.js";

const API_BASE = process.env.HERZIES_API_URL ?? "https://www.herzies.app/api";

/** Refresh the access token if it's near expiry */
async function ensureFreshToken(): Promise<void> {
  const session = loadSession();
  if (!session?.refreshToken) return;
  if (session.expiresAt > Date.now() + 10 * 60 * 1000) return;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });

    if (!res.ok) return;

    const data = await res.json();
    saveSession({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + (data.expiresIn ?? 3600) * 1000,
      userId: session.userId,
    });
  } catch {
    // Token refresh failed — continue with existing token
  }
}

/** Get the current access token, refreshing if needed */
async function getToken(): Promise<string | null> {
  await ensureFreshToken();
  const session = loadSession();
  return session?.accessToken ?? null;
}

/** Make an authenticated request to the game server */
async function apiFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await getToken();
  if (!token) throw new Error("Not logged in");

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
}

/** Check if the user is logged in */
export function isLoggedIn(): boolean {
  return loadSession() !== null;
}

/**
 * Sync heartbeat — sends observations to the game server.
 * Server calculates XP, checks events, and returns authoritative state.
 */
export async function apiSync(
  nowPlaying: { title: string; artist: string; genre?: string } | null,
  minutesListened: number,
  genres: string[],
): Promise<SyncResponse | null> {
  try {
    const body: SyncRequest = { nowPlaying, minutesListened, genres };
    const res = await apiFetch("/sync", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;
    return (await res.json()) as SyncResponse;
  } catch {
    return null;
  }
}

/** Register a local herzie with the game server (creates DB row) */
export async function apiRegisterHerzie(
  herzie: Herzie,
): Promise<Herzie | null> {
  try {
    const res = await apiFetch("/herzie", {
      method: "POST",
      body: JSON.stringify({
        name: herzie.name,
        appearance: herzie.appearance,
        friendCode: herzie.friendCode,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.herzie as Herzie;
  } catch {
    return null;
  }
}

/** Fetch own herzie from the game server */
export async function apiGetMe(): Promise<Herzie | null> {
  try {
    const res = await apiFetch("/me");
    if (!res.ok) return null;
    const data = await res.json();
    return data.herzie as Herzie;
  } catch {
    return null;
  }
}

/** Delete the user's herzie via the game server */
export async function apiDeleteHerzie(): Promise<boolean> {
  try {
    const res = await apiFetch("/me", { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Add friend via game server (validates ownership server-side) */
export async function apiAddFriend(
  myCode: string,
  theirCode: string,
): Promise<boolean> {
  try {
    const res = await apiFetch("/friends/add", {
      method: "POST",
      body: JSON.stringify({ myCode, theirCode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Remove friend via game server */
export async function apiRemoveFriend(
  myCode: string,
  theirCode: string,
): Promise<boolean> {
  try {
    const res = await apiFetch("/friends/remove", {
      method: "POST",
      body: JSON.stringify({ myCode, theirCode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fetch inventory via game server */
export async function apiFetchInventory(): Promise<{
  inventory: Inventory;
  currency: number;
  equipped: string[];
} | null> {
  try {
    const res = await apiFetch("/inventory");
    if (!res.ok) return null;
    const data = await res.json();
    return {
      inventory: data.inventory as Inventory,
      currency: (data.currency ?? 0) as number,
      equipped: (data.equipped as string[]) ?? [],
    };
  } catch {
    return null;
  }
}

/** Equip or unequip an item */
export async function apiEquipItem(
  itemId: string,
  action: "equip" | "unequip",
): Promise<{ equipped: string[] } | null> {
  try {
    const res = await apiFetch("/inventory/equip", {
      method: "POST",
      body: JSON.stringify({ itemId, action }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Sell items for currency */
export async function apiSellItem(
  itemId: string,
  quantity: number,
): Promise<{
  earned: number;
  newCurrency: number;
  inventory: Inventory;
} | null> {
  try {
    const res = await apiFetch("/inventory/sell", {
      method: "POST",
      body: JSON.stringify({ itemId, quantity }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Create a trade request */
export async function apiCreateTrade(
  targetFriendCode: string,
): Promise<{ tradeId: string } | null> {
  try {
    const res = await apiFetch("/trade/create", {
      method: "POST",
      body: JSON.stringify({ targetFriendCode }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Join a pending trade */
export async function apiJoinTrade(tradeId: string): Promise<boolean> {
  try {
    const res = await apiFetch("/trade/join", {
      method: "POST",
      body: JSON.stringify({ tradeId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Update your trade offer */
export async function apiUpdateTradeOffer(
  tradeId: string,
  offer: TradeOffer,
): Promise<boolean> {
  try {
    const res = await apiFetch("/trade/offer", {
      method: "POST",
      body: JSON.stringify({ tradeId, offer }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Lock your side of the trade */
export async function apiLockTrade(tradeId: string): Promise<boolean> {
  try {
    const res = await apiFetch("/trade/lock", {
      method: "POST",
      body: JSON.stringify({ tradeId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Accept the trade (after both locked) */
export async function apiAcceptTrade(
  tradeId: string,
): Promise<{ completed: boolean } | null> {
  try {
    const res = await apiFetch("/trade/accept", {
      method: "POST",
      body: JSON.stringify({ tradeId }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Cancel a trade */
export async function apiCancelTrade(tradeId: string): Promise<boolean> {
  try {
    const res = await apiFetch("/trade/cancel", {
      method: "POST",
      body: JSON.stringify({ tradeId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll trade status */
export async function apiPollTrade(tradeId: string): Promise<Trade | null> {
  try {
    const res = await apiFetch(
      `/trade/status?tradeId=${encodeURIComponent(tradeId)}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.trade as Trade;
  } catch {
    return null;
  }
}

/** Check for pending incoming trade requests */
export async function apiCheckPendingTrades(): Promise<PendingTradeRequest | null> {
  try {
    const res = await apiFetch("/trade/pending");
    if (!res.ok) return null;
    const data = await res.json();
    return data.pending ?? null;
  } catch {
    return null;
  }
}

export type OnlineStatus = "online" | "offline" | "unauthorized";

/** Check if the user is authenticated and the server is reachable */
export async function checkOnline(): Promise<OnlineStatus> {
  try {
    const res = await apiFetch("/me");
    if (res.ok) return "online";
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return "offline";
  } catch {
    return "offline";
  }
}

/** Fetch active events */
export async function apiFetchActiveEvents(): Promise<GameEvent[]> {
  try {
    const res = await fetch(`${API_BASE}/events/active`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.events as GameEvent[];
  } catch {
    return [];
  }
}

/** Check if a herzie name is already taken */
export async function apiIsNameTaken(name: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${API_BASE}/name-check?name=${encodeURIComponent(name)}`,
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.taken === true;
  } catch {
    return false;
  }
}

/** Look up a single herzie by friend code (public, no auth needed) */
export async function apiLookupHerzie(
  friendCode: string,
): Promise<HerzieProfile | null> {
  try {
    const res = await fetch(
      `${API_BASE}/lookup?code=${encodeURIComponent(friendCode)}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.herzie ?? null;
  } catch {
    return null;
  }
}

/** Look up multiple herzies by friend codes (public, no auth needed) */
export async function apiLookupHerzies(
  friendCodes: string[],
): Promise<Map<string, HerzieProfile>> {
  const result = new Map<string, HerzieProfile>();
  if (friendCodes.length === 0) return result;
  try {
    const res = await fetch(
      `${API_BASE}/lookup?codes=${encodeURIComponent(friendCodes.join(","))}`,
    );
    if (!res.ok) return result;
    const data = await res.json();
    for (const h of data.herzies ?? []) {
      result.set(h.friendCode, h);
    }
  } catch {
    // Graceful degradation — works offline
  }
  return result;
}
