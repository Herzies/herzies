"use client";

import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { AdminStats } from "@/app/api/admin/stats/route";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminData } from "./admin-data";
import { AdminAuthError, adminFetch, EVENT_TYPE_LABELS } from "./admin-shared";

const REFRESH_MS = 30_000;

const signupsChart = {
  count: { label: "Signups", color: "var(--chart-1)" },
} satisfies ChartConfig;

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function until(iso: string, now: number): string {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const OUTCOME_VARIANT: Record<string, "default" | "secondary" | "destructive"> =
  {
    victory: "default",
    escaped: "secondary",
    wiped: "destructive",
  };

export function Overview() {
  const { secret, ready, needsSecret } = useAdminData();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStats(await adminFetch<AdminStats>("/api/admin/stats", secret));
      setError(null);
    } catch (e) {
      if (!(e instanceof AdminAuthError)) {
        setError(e instanceof Error ? e.message : "Failed to load stats");
      }
    }
  }, [secret]);

  useEffect(() => {
    if (!ready || needsSecret) return;
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load, ready, needsSecret]);

  if (error && !stats) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!stats) return <OverviewSkeleton />;

  const now = new Date(stats.generatedAt).getTime();
  const { herzies, signups, store } = stats;

  return (
    <div className="grid gap-4 md:gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Online now"
          value={herzies.online}
          note={`${herzies.listening} listening, ${herzies.active24h} active in the last 24h`}
          live
        />
        <Kpi
          label="Active this week"
          value={herzies.active7d}
          note={`of ${herzies.total.toLocaleString()} herzies`}
        />
        <Kpi
          label="Signups today"
          value={signups.today}
          note={`${signups.last7d} in the last 7 days`}
        />
        <Kpi
          label="Store orders, 7 days"
          value={store.completed7d}
          note={`${store.completed30d} in 30 days, ${store.failed7d} failed or expired this week`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Signups</CardTitle>
          <CardDescription>
            New herzies per day, last 30 days (UTC)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={signupsChart} className="h-56 w-full">
            <BarChart data={signups.daily} margin={{ left: -20, right: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(d: string) =>
                  new Date(`${d}T00:00:00Z`).toLocaleDateString("en", {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })
                }
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(d) =>
                      new Date(`${d}T00:00:00Z`).toLocaleDateString("en", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      })
                    }
                  />
                }
              />
              <Bar
                dataKey="count"
                fill="var(--color-count)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Live now</CardTitle>
            <CardDescription>
              Herzies whose app synced in the last 2 minutes
            </CardDescription>
          </CardHeader>
          <CardContent>
            {stats.liveNow.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody is online.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Herzie</TableHead>
                    <TableHead>Playing</TableHead>
                    <TableHead className="text-right">Seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.liveNow.map((h) => (
                    <TableRow key={`${h.name}-${h.lastSyncedAt}`}>
                      <TableCell>
                        <span className="font-medium">{h.name}</span>{" "}
                        <span className="text-muted-foreground">
                          lv {h.level}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground">
                        {h.title
                          ? `${h.title}${h.artist ? ` by ${h.artist}` : ""}`
                          : "Idle"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {ago(h.lastSyncedAt, now)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Events</CardTitle>
            <CardDescription>Running now and coming up</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {stats.events.running.length === 0 &&
              stats.events.upcoming.length === 0 && (
                <p className="text-muted-foreground">
                  No events running or scheduled.
                </p>
              )}
            {stats.events.running.map((e) => (
              <EventLine
                key={e.id}
                title={e.title}
                type={e.type}
                badge={<Badge>Live</Badge>}
                when={`ends in ${until(e.endsAt, now)}`}
              />
            ))}
            {stats.events.upcoming.map((e) => (
              <EventLine
                key={e.id}
                title={e.title}
                type={e.type}
                badge={<Badge variant="secondary">Scheduled</Badge>}
                when={`starts in ${until(e.startsAt, now)}`}
              />
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent boss fights</CardTitle>
        </CardHeader>
        <CardContent>
          {stats.bossFights.length === 0 ? (
            <p className="text-sm text-muted-foreground">No boss fights yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Raiders</TableHead>
                  <TableHead className="text-right">Ended</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.bossFights.map((b) => (
                  <TableRow key={b.eventId}>
                    <TableCell>
                      <Badge
                        variant={OUTCOME_VARIANT[b.outcome] ?? "secondary"}
                      >
                        {b.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell>{b.rosterSize}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {ago(b.endedAt, now)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({
  label,
  value,
  note,
  live,
}: {
  label: string;
  value: number;
  note: string;
  live?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl font-semibold tabular-nums">
          {value.toLocaleString()}
        </CardTitle>
        {live && (
          <CardAction>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2 rounded-full bg-green animate-pulse" />
              live
            </span>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {note}
      </CardContent>
    </Card>
  );
}

function EventLine({
  title,
  type,
  badge,
  when,
}: {
  title: string;
  type: string;
  badge: React.ReactNode;
  when: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      {badge}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">
          {EVENT_TYPE_LABELS[type] ?? type}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{when}</span>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="grid gap-4 md:gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {["a", "b", "c", "d"].map((k) => (
          <Skeleton key={k} className="h-32 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
      <div className="grid gap-4 md:gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
