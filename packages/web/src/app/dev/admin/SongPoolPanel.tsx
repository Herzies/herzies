"use client";

import { useCallback, useEffect, useState } from "react";
import { type AdminEvent, adminFetch, INPUT } from "./admin-shared";

type SongPoolEntry = {
  id: string;
  trackTitle: string;
  trackArtist: string;
  notes: string | null;
  usedBy: string | null;
};

/**
 * Songs the weekly curator routine picks from, oldest first. A song counts
 * as used once any song hunt has it as its answer; when every song is used
 * the routine falls back to choosing its own.
 */
export function SongPoolPanel({
  secret,
  events,
}: {
  secret: string;
  /** Re-fetch when events change, since that is what marks songs used. */
  events: AdminEvent[];
}) {
  const [songs, setSongs] = useState<SongPoolEntry[]>([]);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUsed, setShowUsed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminFetch<{ songs: SongPoolEntry[] }>(
        "/api/admin/song-pool",
        secret,
      );
      setSongs(res.songs);
      // A load that works clears an earlier failed one; otherwise the old
      // error sticks around until the page is reloaded.
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load song pool");
    }
  }, [secret]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: events is the refresh trigger
  useEffect(() => {
    load();
  }, [load, events]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminFetch("/api/admin/song-pool", secret, {
        method: "POST",
        body: JSON.stringify({
          trackTitle: title,
          trackArtist: artist,
          notes: notes || undefined,
        }),
      });
      setTitle("");
      setArtist("");
      setNotes("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add song");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (song: SongPoolEntry) => {
    if (!confirm(`Remove "${song.trackTitle}" from the pool?`)) return;
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/admin/song-pool?id=${song.id}`, secret, {
        method: "DELETE",
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove song");
    } finally {
      setBusy(false);
    }
  };

  const unused = songs.filter((s) => !s.usedBy);
  const used = songs.filter((s) => s.usedBy);

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-dim max-w-2xl">
        The weekly curator picks next week&apos;s song from here. Use the exact
        title and primary artist as Spotify shows them. A song is marked used
        once any hunt has it as its answer; with nothing left, the curator picks
        one itself.
      </p>

      <form
        onSubmit={add}
        className="grid sm:grid-cols-[1fr_1fr_1.5fr_auto] gap-2 items-end"
      >
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor="pool-title"
          >
            title
          </label>
          <input
            id="pool-title"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor="pool-artist"
          >
            artist
          </label>
          <input
            id="pool-artist"
            required
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label
            className="block text-xs text-text-dim mb-1"
            htmlFor="pool-notes"
          >
            notes for the clue writer (optional)
          </label>
          <input
            id="pool-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={INPUT}
          />
        </div>
        <button
          type="submit"
          disabled={busy || !title.trim() || !artist.trim()}
          className="text-xs text-purple bg-transparent border border-border px-3 py-2 rounded-sm cursor-pointer hover:border-purple disabled:opacity-50"
        >
          + add
        </button>
      </form>

      {error && <p className="text-red text-xs">{error}</p>}

      {unused.length === 0 ? (
        <p className="text-xs text-text-dim">
          Pool is empty — the curator will pick songs itself.
        </p>
      ) : (
        <ul className="border border-border rounded-sm divide-y divide-border text-sm">
          {unused.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-4 px-4 py-2"
            >
              <div className="min-w-0">
                <div className="truncate">
                  {s.trackArtist} – {s.trackTitle}
                </div>
                {s.notes && (
                  <div className="truncate text-xs text-text-dim">
                    {s.notes}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(s)}
                className="shrink-0 text-red text-xs bg-transparent border-0 cursor-pointer disabled:opacity-50"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {used.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowUsed((v) => !v)}
            className="text-xs text-text-dim bg-transparent border-0 cursor-pointer"
          >
            {showUsed ? "hide" : "show"} {used.length} used
          </button>
          {showUsed && (
            <ul className="mt-2 space-y-1 text-xs text-text-dim">
              {used.map((s) => (
                <li key={s.id}>
                  {s.trackArtist} – {s.trackTitle}
                  <span className="text-cyan"> · {s.usedBy}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
