"use client";

import { getItem, Herzie3D, RARITY_COLORS } from "@herzies/shared";
import { useCallback, useEffect, useState } from "react";
import Container from "@/components/container";
import { createSupabaseClient } from "@/lib/supabase";

const POLL_INTERVAL = 10_000;

const STAGE_LABELS: Record<number, string> = {
  1: "baby",
  2: "teen",
  3: "champion",
};

const STAGE_COLOR_CLASS: Record<number, string> = {
  1: "text-yellow",
  2: "text-cyan",
  3: "text-purple",
};

interface HerzieRow {
  name: string;
  stage: number;
  level: number;
  xp: number;
  appearance: {
    headIndex: number;
    eyesIndex: number;
    mouthIndex: number;
    accessoryIndex: number;
    limbsIndex?: number;
    bodyIndex?: number;
    legsIndex?: number;
    colorScheme: string;
  };
  total_minutes_listened: number;
  genre_minutes: Record<string, number>;
  friend_code: string;
  friend_codes: string[];
  now_playing: { title: string; artist: string } | null;
  created_at: string;
  equipped: string[] | null;
}

interface RecentTrack {
  track_name: string;
  artist_name: string;
  listened_at: string;
}

interface TopArtist {
  name: string;
  plays: number;
}

interface FriendProfile {
  name: string;
  friend_code: string;
  stage: number;
  level: number;
  now_playing: { title: string; artist: string } | null;
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${Math.floor(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.floor(mins % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function HerzieDetail({
  herzie: initial,
  recentTracks,
  topArtists,
}: {
  herzie: HerzieRow;
  recentTracks: RecentTrack[];
  topArtists: TopArtist[];
}) {
  const [herzie, setHerzie] = useState(initial);
  const [friends, setFriends] = useState<FriendProfile[]>([]);

  const refresh = useCallback(async () => {
    const supabase = createSupabaseClient();
    const { data } = await supabase
      .from("herzies")
      .select(
        "name, stage, level, xp, appearance, total_minutes_listened, genre_minutes, friend_code, friend_codes, now_playing, created_at, equipped",
      )
      .eq("name", initial.name)
      .single();
    if (data) setHerzie(data as HerzieRow);
  }, [initial.name]);

  useEffect(() => {
    if (herzie.friend_codes.length === 0) return;
    const supabase = createSupabaseClient();
    supabase
      .from("herzies")
      .select("name, friend_code, stage, level, now_playing")
      .in("friend_code", herzie.friend_codes)
      .then(({ data }) => {
        if (data) setFriends(data as FriendProfile[]);
      });
  }, [herzie.friend_codes]);

  useEffect(() => {
    const interval = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [refresh]);

  const age = daysSince(herzie.created_at);

  return (
    <Container className="py-12 flex flex-col gap-6">
      {/* Header: art + info */}
      <div className="flex gap-8 items-start flex-wrap">
        <div className="relative mx-auto">
          <div className="shrink-0">
            <Herzie3D
              userId={herzie.friend_code}
              stage={herzie.stage}
              size={5}
              isPlaying={!!herzie.now_playing}
              wearables={herzie.equipped ?? []}
              ariaLabel={`${herzie.name}, a stage ${herzie.stage} herzie`}
            />
          </div>
        </div>

        <div className="flex-1 min-w-[200px]">
          <h1 className="text-[22px] m-0">{herzie.name}</h1>
          <div
            className={`text-[13px] mt-1 ${STAGE_COLOR_CLASS[herzie.stage] ?? "text-text"}`}
          >
            {STAGE_LABELS[herzie.stage]} (stage {herzie.stage})
          </div>

          <div className="flex gap-6 mt-4 flex-wrap">
            <Stat
              label="level"
              value={String(herzie.level)}
              colorClass="text-yellow"
            />
            <Stat
              label="listened"
              value={formatMinutes(herzie.total_minutes_listened)}
              colorClass="text-green"
            />
            <Stat label="age" value={`${age}d`} colorClass="text-text-dim" />
            <Stat
              label="friendzies"
              value={String(herzie.friend_codes.length)}
              colorClass="text-cyan"
            />
          </div>

          {/* Equipped */}
          {(herzie.equipped?.length ?? 0) > 0 && (
            <div className="mt-4">
              <div className="text-[11px] text-text-dim mb-1">
                // wearables
              </div>
              <div className="text-[13px] flex flex-wrap gap-x-3 gap-y-1">
                {herzie.equipped?.map((id) => {
                  const item = getItem(id);
                  if (!item) return null;
                  return (
                    <span
                      key={id}
                      style={{ color: RARITY_COLORS[item.rarity] }}
                      title={item.description}
                    >
                      {item.name}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Now playing */}
          {herzie.now_playing && (
            <div className="mt-4">
              <div className="text-[11px] text-text-dim mb-1">
                // now playing
              </div>
              <div className="text-[13px] text-cyan">
                &#9834; {herzie.now_playing.title}
                <span className="text-text-dim">
                  {" "}
                  — {herzie.now_playing.artist}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Recently Played */}
      <Panel title="recently played">
        {recentTracks.length === 0 ? (
          <p className="text-text-dim text-[13px] m-0">
            no listening activity yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {recentTracks.map((track, i) => (
              <div
                key={`${track.listened_at}-${i}`}
                className="flex justify-between items-center text-[13px] px-2 py-1.5 rounded bg-bg"
              >
                <span>
                  <span className="text-cyan">&#9834; {track.track_name}</span>
                  <span className="text-text-dim"> — {track.artist_name}</span>
                </span>
                <span className="text-text-dim text-[11px] shrink-0 ml-3">
                  {formatTimeAgo(track.listened_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Top Artists */}
      <Panel title="top artists">
        {topArtists.length === 0 ? (
          <p className="text-text-dim text-[13px] m-0">
            no listening activity yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {topArtists.map((artist, i) => (
              <div
                key={artist.name}
                className="flex justify-between items-center text-[13px] px-2 py-1.5 rounded bg-bg"
              >
                <span>
                  <span className="text-yellow mr-2">{i + 1}.</span>
                  <span className="text-green">{artist.name}</span>
                </span>
                <span className="text-text-dim text-[11px]">
                  {artist.plays} {artist.plays === 1 ? "play" : "plays"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Friends */}
      <Panel title={`friendzies (${herzie.friend_codes.length})`}>
        {herzie.friend_codes.length === 0 ? (
          <p className="text-text-dim text-[13px] m-0">no friendzies yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {friends.map((f) => (
              <a
                key={f.friend_code}
                href={`/herzie/${encodeURIComponent(f.name)}`}
                className="flex justify-between items-center text-[13px] no-underline text-inherit px-2 py-1.5 rounded bg-bg"
              >
                <span>
                  <span className="text-cyan">{f.name}</span>
                  <span className="text-text-dim">
                    {" "}
                    lv.{f.level} {STAGE_LABELS[f.stage]}
                  </span>
                </span>
                {f.now_playing && (
                  <span className="text-cyan text-xs">
                    &#9834; {f.now_playing.title}
                  </span>
                )}
              </a>
            ))}
            {herzie.friend_codes
              .filter((code) => !friends.find((f) => f.friend_code === code))
              .map((code) => (
                <div
                  key={code}
                  className="text-[13px] text-text-dim px-2 py-1.5"
                >
                  {code} — offline
                </div>
              ))}
          </div>
        )}
      </Panel>
    </Container>
  );
}

function Stat({
  label,
  value,
  colorClass,
}: {
  label: string;
  value: string;
  colorClass: string;
}) {
  return (
    <div>
      <div className={`text-lg font-bold ${colorClass}`}>{value}</div>
      <div className="text-[11px] text-text-dim">{label}</div>
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-bg-panel border border-border rounded-md p-4">
      <h2 className="text-[13px] text-text-dim mb-3 font-normal">// {title}</h2>
      {children}
    </div>
  );
}
