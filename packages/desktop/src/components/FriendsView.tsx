import type { Herzie, HerzieProfile } from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { herzies, useWindowFocused } from "../tauri-bridge";
import { ProfileView } from "./ProfileView";
import { View } from "./View";

const FRIEND_POLL_MS = 15_000;

export function FriendsView({
  herzie,
  friends,
  onStartTrade,
  stageOverride,
  openProfileCode,
  onProfileOpened,
}: {
  herzie: Herzie;
  friends: Record<string, HerzieProfile>;
  onStartTrade: (code: string) => void;
  stageOverride?: number | null;
  openProfileCode?: string | null;
  onProfileOpened?: () => void;
}) {
  const [addCode, setAddCode] = useState("");
  const [message, setMessage] = useState("");
  const [selectedFriend, setSelectedFriend] = useState<HerzieProfile | null>(
    null,
  );
  const focused = useWindowFocused();

  const friendCodesKey = herzie.friendCodes.join(",");
  const friendsRef = useRef(friends);
  friendsRef.current = friends;

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

  const handleAddByCode = async (code: string) => {
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    const result = await herzies.friendAdd(normalized);
    setMessage(result.message);
    setTimeout(() => setMessage(""), 3000);
    if (result.success) {
      const refreshed = await herzies.friendLookup([normalized]);
      if (refreshed[normalized]) {
        setSelectedFriend(refreshed[normalized]);
      }
    }
  };

  const handleAdd = async () => {
    const code = addCode.trim().toUpperCase();
    if (!code) return;
    await handleAddByCode(code);
    setAddCode("");
  };

  const handleRemove = async (code: string) => {
    const result = await herzies.friendRemove(code);
    setMessage(result.message);
    setTimeout(() => setMessage(""), 3000);
  };

  const copyFriendCode = async () => {
    await navigator.clipboard.writeText(herzie.friendCode);
    setMessage(`Copied ${herzie.friendCode}!`);
    setTimeout(() => setMessage(""), 3000);
  };

  if (selectedFriend) {
    return (
      <ProfileView
        profile={selectedFriend}
        onBack={() => setSelectedFriend(null)}
        onTrade={() => {
          setSelectedFriend(null);
          onStartTrade(selectedFriend.friendCode);
        }}
        onAdd={async () => {
          await handleAddByCode(selectedFriend.friendCode);
        }}
        onRemove={async () => {
          await handleRemove(selectedFriend.friendCode);
          setSelectedFriend(null);
        }}
        canRemove={herzie.friendCodes.includes(selectedFriend.friendCode)}
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
      title={`Friends (${herzie.friendCodes.length}/20)`}
      colour="green"
      childrenClassName="flex min-h-0 flex-col"
    >
      <div className="mb-2 flex gap-1">
        <input
          className="input flex-1"
          placeholder="HERZ-XXXX"
          value={addCode}
          onChange={(e) => setAddCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button type="button" className="btn" onClick={handleAdd}>
          Add
        </button>
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
            No friends yet. Share your code above!
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
    </View>
  );
}
