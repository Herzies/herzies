"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  AdminAuthError,
  type AdminEvent,
  adminFetch,
  type CatalogItem,
  type EventSeries,
} from "./admin-shared";

const SECRET_KEY = "herzies-admin-secret";

type AdminData = {
  /** GAME_ADMIN_SECRET when one was entered (local fallback), else "". */
  secret: string;
  setSecret: (secret: string) => void;
  /** The stored secret has been read: requests may go out. */
  ready: boolean;
  /** Not signed in as an admin and no working secret. */
  needsSecret: boolean;
  items: CatalogItem[];
  events: AdminEvent[];
  series: EventSeries[];
  /** Series API failed: almost always 00081 not applied to this database. */
  seriesMissing: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
};

const AdminDataContext = createContext<AdminData | null>(null);

export function useAdminData(): AdminData {
  const data = useContext(AdminDataContext);
  if (!data) throw new Error("useAdminData outside AdminDataProvider");
  return data;
}

/**
 * The catalog, events and series every section works from, loaded once for
 * the whole panel and reloaded after a change.
 */
export function AdminDataProvider({ children }: { children: React.ReactNode }) {
  const [secret, setSecretState] = useState<string | null>(null);
  const [needsSecret, setNeedsSecret] = useState(false);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [series, setSeries] = useState<EventSeries[]>([]);
  const [seriesMissing, setSeriesMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setSecretState(localStorage.getItem(SECRET_KEY) ?? "");
    } catch {
      setSecretState("");
    }
  }, []);

  const setSecret = useCallback((next: string) => {
    try {
      if (next) localStorage.setItem(SECRET_KEY, next);
      else localStorage.removeItem(SECRET_KEY);
    } catch {}
    setSecretState(next);
  }, []);

  const load = useCallback(async () => {
    if (secret === null) return;
    setLoading(true);
    setError(null);
    try {
      const [itemsRes, eventsRes, seriesRes] = await Promise.all([
        adminFetch<{ items: CatalogItem[] }>("/api/admin/items", secret),
        adminFetch<{ events: AdminEvent[] }>("/api/admin/events", secret),
        // Optional: without 00081 applied the rest of the panel still works.
        adminFetch<{ series: EventSeries[] }>(
          "/api/admin/event-series",
          secret,
        ).catch((e) => {
          if (e instanceof AdminAuthError) throw e;
          return null;
        }),
      ]);
      setItems(itemsRes.items);
      setEvents(eventsRes.events);
      setSeries(seriesRes?.series ?? []);
      setSeriesMissing(!seriesRes);
      setNeedsSecret(false);
    } catch (e) {
      if (e instanceof AdminAuthError) setNeedsSecret(true);
      else setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [secret]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AdminDataContext.Provider
      value={{
        secret: secret ?? "",
        setSecret,
        ready: secret !== null,
        needsSecret,
        items,
        events,
        series,
        seriesMissing,
        loading,
        error,
        load,
      }}
    >
      {children}
    </AdminDataContext.Provider>
  );
}
