import type {
  FriendRequestSummary,
  FriendSearchResult,
  Herzie,
  HerzieProfile,
} from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import {
  herzies,
  type LeaderboardEntry,
  useWindowFocused,
} from "../tauri-bridge";
import { ProfileView } from "./ProfileView";
import { View } from "./View";

const FRIEND_POLL_MS = 15_000;
const SEARCH_DEBOUNCE_MS = 350;

type Tab = "friends" | "requests" | "add" | "leaderboard";

export function FriendsView({
  herzie,
  friends,
  incomingRequests,
  outgoingRequests,
  onStartTrade,
  stageOverride,
  openProfileCode,
  onProfileOpened,
  tab,
  onTabChange,
  onActivity,
}: {
  herzie: Herzie;
  friends: Record<string, HerzieProfile>;
  incomingRequests: FriendRequestSummary[];
  outgoingRequests: FriendRequestSummary[];
  onStartTrade: (code: string) => void;
  stageOverride?: number | null;
  openProfileCode?: string | null;
  onProfileOpened?: () => void;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onActivity?: (message: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [selectedFriend, setSelectedFriend] = useState<HerzieProfile | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<FriendSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[] | null>(
    null,
  );
  const focused = useWindowFocused();

  const friendCodesKey = herzie.friendCodes.join(",");
  const friendsRef = useRef(friends);
  friendsRef.current = friends;

  const flash = (text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(""), 3000);
  };

  // Background refresh when codes change and any profile is missing from cache.
  useEffect(() => {
    if (!friendCodesKey) return;
    const codes = friendCodesKey.split(",");
    if (codes.every((code) => friendsRef.current[code])) return;
    herzies.friendLookup(codes);
  }, [friendCodesKey]);

  // Poll friend profiles while focused (now playing / online status).
  useEffect(() => {
    if (!focused || !friendCodesKey) return;
    const codes = friendCodesKey.split(",");
    const poll = () => herzies.friendLookup(codes);
    poll();
    const interval = setInterval(poll, FRIEND_POLL_MS);
    return () => clearInterval(interval);
  }, [focused, friendCodesKey]);

  // Open profile from chat (or other external navigation).
  useEffect(() => {
    if (!openProfileCode) return;
    const cached = friendsRef.current[openProfileCode];
    if (cached) {
      setSelectedFriend(cached);
      onProfileOpened?.();
      return;
    }
    herzies.friendLookup([openProfileCode]).then((result) => {
      const profile = result[openProfileCode];
      if (profile) setSelectedFriend(profile);
      onProfileOpened?.();
    });
  }, [openProfileCode, onProfileOpened]);

  // Debounced search (code or name).
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      const results = await herzies.friendSearch(q).catch(() => []);
      setSearchResults(results);
      setSearching(false);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  // Fetch the leaderboard when its tab is opened and refresh while focused.
  useEffect(() => {
    if (tab !== "leaderboard") return;
    let cancelled = false;
    const load = () =>
      herzies
        .fetchLeaderboard()
        .then((res) => {
          if (!cancelled) setLeaderboard(res.entries);
        })
        .catch(() => {});
    load();
    if (!focused) return;
    const interval = setInterval(load, FRIEND_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tab, focused]);

  const outgoingCodes = new Set(outgoingRequests.map((r) => r.friendCode));

  const handleSendRequest = async (code: string) => {
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    const result = await herzies.friendAdd(normalized);
    flash(result.message);
    onActivity?.(result.message);
    if (result.success) {
      setSearchResults((prev) =>
        prev.map((r) =>
          r.friendCode === normalized
            ? { ...r, relationship: "pending_sent" }
            : r,
        ),
      );
    }
  };

  const handleAccept = async (requestId: string) => {
    const result = await herzies.friendRequestAccept(requestId);
    flash(result.message);
  };

  const handleDecline = async (requestId: string) => {
    const result = await herzies.friendRequestDecline(requestId);
    flash(result.message);
  };

  const handleCancel = async (requestId: string) => {
    const result = await herzies.friendRequestCancel(requestId);
    flash(result.message);
  };

  const handleRemove = async (code: string) => {
    const result = await herzies.friendRemove(code);
    flash(result.message);
  };

  const copyFriendCode = async () => {
    await navigator.clipboard.writeText(herzie.friendCode);
    flash(`Copied ${herzie.friendCode}!`);
  };

  if (selectedFriend) {
    const code = selectedFriend.friendCode;
    return (
      <ProfileView
        profile={selectedFriend}
        onBack={() => setSelectedFriend(null)}
        onTrade={() => {
          setSelectedFriend(null);
          onStartTrade(code);
        }}
        onAdd={async () => {
          await handleSendRequest(code);
        }}
        onRemove={async () => {
          await handleRemove(code);
          setSelectedFriend(null);
        }}
        canRemove={herzie.friendCodes.includes(code)}
        isFriend={herzie.friendCodes.includes(code)}
        requestPending={outgoingCodes.has(code)}
        stageOverride={stageOverride}
      />
    );
  }

  const showLoading =
    herzie.friendCodes.length > 0 &&
    herzie.friendCodes.some((code) => !friends[code]);

  const sortedCodes = [...herzie.friendCodes].sort(
    (a, b) =>
      Number(!!friends[b]?.nowPlaying) - Number(!!friends[a]?.nowPlaying),
  );

  return (
    <View
      title="Social"
      colour="green"
      childrenClassName="flex min-h-0 flex-col"
    >
      <div className="mb-2 flex gap-1 border-b border-border text-ui">
        <TabButton
          active={tab === "friends"}
          onClick={() => onTabChange("friends")}
        >
          Friends ({herzie.friendCodes.length}/20)
        </TabButton>
        <TabButton
          active={tab === "requests"}
          onClick={() => onTabChange("requests")}
        >
          Requests
          {incomingRequests.length > 0 && (
            <span className="ml-1 text-green">({incomingRequests.length})</span>
          )}
        </TabButton>
        <TabButton active={tab === "add"} onClick={() => onTabChange("add")}>
          Add friend
        </TabButton>
        <TabButton
          active={tab === "leaderboard"}
          onClick={() => onTabChange("leaderboard")}
        >
          Leaderboard
        </TabButton>
      </div>

      {message && (
        <div
          className={cn(
            "mb-1.5 text-ui",
            message.includes("!") ? "text-green" : "text-red",
          )}
        >
          {message}
        </div>
      )}

      {tab === "friends" && (
        <>
          <div className="mb-2 text-[10px] text-text-dim">
            Your code:{" "}
            <button
              type="button"
              className="cursor-pointer border-none bg-transparent p-0 font-bold text-cyan hover:text-cyan/80"
              title="Copy friend code"
              onClick={copyFriendCode}
            >
              {herzie.friendCode}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {herzie.friendCodes.length === 0 ? (
              <div className="pt-5 text-center text-ui text-text-dim">
                No friends yet. Add some from the Add friend tab!
              </div>
            ) : (
              sortedCodes.map((code) => {
                const profile = friends[code];
                const online = !!profile?.nowPlaying;
                return (
                  <div
                    key={code}
                    className="flex items-center justify-between border-b border-border last:border-b-0"
                  >
                    <button
                      type="button"
                      className={cn(
                        "text-left py-1.5 w-full group",
                        profile ? "cursor-pointer" : "",
                      )}
                      onClick={() => profile && setSelectedFriend(profile)}
                    >
                      <div className="flex items-center gap-1 text-ui text-text group-hover:text-cyan">
                        {online && (
                          <span className="text-cyan" title="Listening now">
                            ●
                          </span>
                        )}
                        {profile?.name ?? code}
                        {profile?.globalRank && (
                          <span
                            className="text-[10px] text-text-dim"
                            title={
                              profile.globalTotal
                                ? `Ranked #${profile.globalRank} of ${profile.globalTotal}`
                                : undefined
                            }
                          >
                            #{profile.globalRank}
                          </span>
                        )}
                      </div>
                      <div
                        className={cn(
                          "text-[10px] line-clamp-1",
                          online ? "text-cyan" : "text-text-dim",
                        )}
                      >
                        {profile ? (
                          online && profile.nowPlaying ? (
                            <>
                              ♪ {profile.nowPlaying.title}
                              <span className="text-text-dim">
                                {" "}
                                — {profile.nowPlaying.artist}
                              </span>
                            </>
                          ) : (
                            `Lv.${profile.level} · Stage ${profile.stage}`
                          )
                        ) : showLoading ? (
                          "Loading..."
                        ) : (
                          code
                        )}
                      </div>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {tab === "requests" && (
        <div className="min-h-0 flex-1 overflow-auto">
          {incomingRequests.length === 0 ? (
            <div className="pt-5 text-center text-ui text-text-dim">
              No friend requests right now.
            </div>
          ) : (
            incomingRequests.map((req) => (
              <div
                key={req.requestId}
                className="flex items-center justify-between gap-2 border-b border-border py-1.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-ui text-text">{req.name}</div>
                  <div className="text-[10px] text-text-dim">
                    {req.friendCode}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className="btn text-green"
                    onClick={() => handleAccept(req.requestId)}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn text-text-dim"
                    onClick={() => handleDecline(req.requestId)}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "add" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <input
            className="input mb-2"
            placeholder="Search by name or HERZ-XXXX"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="min-h-0 flex-1 overflow-auto">
            {search.trim() ? (
              <SearchResults
                results={searchResults}
                searching={searching}
                onSend={handleSendRequest}
              />
            ) : null}

            {outgoingRequests.length > 0 && !search.trim() && (
              <div>
                <div className="mb-1 text-[10px] text-text-dim">Sent</div>
                {outgoingRequests.map((req) => (
                  <div
                    key={req.requestId}
                    className="flex items-center justify-between gap-2 border-b border-border py-1.5 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-ui text-text">
                        {req.name}
                      </div>
                      <div className="text-[10px] text-text-dim">
                        {req.friendCode}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn shrink-0 text-text-dim"
                      onClick={() => handleCancel(req.requestId)}
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!search.trim() && outgoingRequests.length === 0 && (
              <div className="pt-5 text-center text-ui text-text-dim">
                Search for a herzie by name or friend code.
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "leaderboard" && (
        <div className="min-h-0 flex-1 overflow-auto">
          {leaderboard === null ? (
            <div className="pt-5 text-center text-ui text-text-dim">
              Loading…
            </div>
          ) : leaderboard.length === 0 ? (
            <div className="pt-5 text-center text-ui text-text-dim">
              No herzies on the leaderboard yet.
            </div>
          ) : (
            leaderboard.map((entry) => {
              const isMe = entry.name === herzie.name;
              return (
                <div
                  key={`${entry.rank}-${entry.name}`}
                  className="flex items-center gap-2 border-b border-border py-1.5 last:border-b-0"
                >
                  <span
                    className={cn(
                      "w-6 shrink-0 text-right text-ui font-bold",
                      entry.rank === 1 ? "text-yellow" : "text-text-dim",
                    )}
                  >
                    {entry.rank}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "truncate text-ui",
                        isMe ? "font-bold text-cyan" : "text-text",
                      )}
                    >
                      {entry.name}
                      <span className="ml-1 text-[10px] text-text-dim">
                        Lv.{entry.level} · Stage {entry.stage}
                      </span>
                    </div>
                  </div>
                  <span className="shrink-0 text-[10px] text-green">
                    {formatMinutes(entry.totalMinutes)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </View>
  );
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer border-none bg-transparent px-1.5 pb-1.5 pt-0.5",
        active ? "font-bold text-green" : "text-text-dim hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

function SearchResults({
  results,
  searching,
  onSend,
}: {
  results: FriendSearchResult[];
  searching: boolean;
  onSend: (code: string) => void;
}) {
  if (searching && results.length === 0) {
    return (
      <div className="pt-5 text-center text-ui text-text-dim">Searching…</div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="pt-5 text-center text-ui text-text-dim">No matches.</div>
    );
  }
  return (
    <>
      {results.map((r) => (
        <div
          key={r.friendCode}
          className="flex items-center justify-between gap-2 border-b border-border py-1.5 last:border-b-0"
        >
          <div className="min-w-0">
            <div className="truncate text-ui text-text">{r.name}</div>
            <div className="text-[10px] text-text-dim">
              {r.friendCode} · Lv.{r.level}
            </div>
          </div>
          {r.relationship === "friends" ? (
            <span className="shrink-0 text-[10px] text-text-dim">Friends</span>
          ) : r.relationship === "pending_sent" ? (
            <span className="shrink-0 text-[10px] text-text-dim">
              Requested
            </span>
          ) : r.relationship === "pending_received" ? (
            <button
              type="button"
              className="btn shrink-0 text-green"
              onClick={() => onSend(r.friendCode)}
              title="They already requested you"
            >
              Accept
            </button>
          ) : (
            <button
              type="button"
              className="btn shrink-0 text-green"
              onClick={() => onSend(r.friendCode)}
            >
              Add
            </button>
          )}
        </div>
      ))}
    </>
  );
}
