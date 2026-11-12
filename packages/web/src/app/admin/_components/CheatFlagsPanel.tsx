"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CheatFlag,
  CheatFlagsResponse,
} from "@/app/api/admin/cheat-flags/route";
import { adminFetch } from "./admin-shared";

const KINDS: Record<CheatFlag["kind"], string> = {
  listening: "Listening",
  "monthly-xp": "Monthly XP",
  "boss-damage": "Boss damage",
};

export function CheatFlagsPanel({ secret }: { secret: string }) {
  const [data, setData] = useState<CheatFlagsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await adminFetch<CheatFlagsResponse>("/api/admin/cheat-flags", secret),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [secret]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted max-w-xl">
          Accounts whose numbers look wrong. A flag is a lead to check by hand,
          not proof; nothing here acts on an account.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="border border-border rounded-sm px-3 py-2 text-sm disabled:opacity-50"
        >
          {loading ? "Checking..." : "Refresh"}
        </button>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      {data && data.flags.length === 0 && (
        <p className="text-sm text-muted">Nothing flagged.</p>
      )}
      {data && data.flags.length > 0 && (
        <ul className="divide-y divide-border border border-border rounded-sm">
          {data.flags.map((f) => (
            <li
              key={`${f.kind}-${f.userId}-${f.at}-${f.detail}`}
              className="p-3 flex flex-wrap items-baseline gap-x-3 gap-y-1"
            >
              <span
                className={`text-xs uppercase tracking-wide ${f.severity === "high" ? "text-red-500" : "text-yellow-500"}`}
              >
                {f.severity}
              </span>
              <span className="text-xs text-muted">{KINDS[f.kind]}</span>
              <span className="font-medium">
                {f.name} <span className="text-muted">Lv {f.level}</span>
              </span>
              <span className="text-sm w-full">{f.detail}</span>
              <span className="text-xs text-muted w-full">{f.baseline}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
