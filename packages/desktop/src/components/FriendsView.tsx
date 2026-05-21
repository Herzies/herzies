import type { Herzie, HerzieProfile } from "@herzies/shared";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { BackButton } from "./BackButton";
import { Herzie3D } from "./Herzie3D";

function FriendProfileView({
  profile,
  onBack,
  onTrade,
  onRemove,
  stageOverride,
}: {
  profile: HerzieProfile;
  onBack: () => void;
  onTrade: () => void;
  onRemove: () => void;
  stageOverride?: number | null;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <div className="relative z-10 mb-2 flex items-center justify-between">
        <BackButton onClick={onBack} />
        <span className="text-ui-lg font-bold text-cyan">{profile.name}</span>
      </div>

      {profile.appearance && (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Herzie3D
            userId={profile.friendCode}
            stage={stageOverride ?? profile.stage}
          />
        </div>
      )}

      <div className="mb-2 flex justify-between text-ui text-text-dim">
        <span>Level {profile.level}</span>
        <span>Stage {profile.stage}</span>
      </div>

      {profile.topArtists && profile.topArtists.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] text-text-dim">Top Artists</div>
          {profile.topArtists.map((a, i) => (
            <div
              key={a.name}
              className="flex justify-between border-b border-[#222] py-0.5 text-ui"
            >
              <span className="text-text">
                {i + 1}. {a.name}
              </span>
              <span className="text-text-dim">{a.plays} plays</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <button type="button" className="btn text-purple" onClick={onTrade}>
          Trade
        </button>
        {confirmRemove ? (
          <>
            <button type="button" className="btn text-red" onClick={onRemove}>
              Yes, remove
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setConfirmRemove(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn text-red"
            onClick={() => setConfirmRemove(true)}
          >
            Remove friend
          </button>
        )}
      </div>
    </div>
  );
}

export function FriendsView({
  herzie,
  onStartTrade,
  stageOverride,
}: {
  herzie: Herzie;
  onStartTrade: (code: string) => void;
  stageOverride?: number | null;
}) {
  const [friends, setFriends] = useState<Record<string, HerzieProfile> | null>(
    null,
  );
  const [addCode, setAddCode] = useState("");
  const [message, setMessage] = useState("");
  const [selectedFriend, setSelectedFriend] = useState<HerzieProfile | null>(
    null,
  );

  const loadFriends = useCallback(async () => {
    if (herzie.friendCodes.length === 0) {
      setFriends({});
      return;
    }
    const data = await herzies.friendLookup(herzie.friendCodes);
    setFriends(data);
  }, [herzie.friendCodes]);

  useEffect(() => {
    loadFriends();
  }, [loadFriends]);

  const handleAdd = async () => {
    const code = addCode.trim().toUpperCase();
    if (!code) return;
    const result = await herzies.friendAdd(code);
    setMessage(result.message);
    if (result.success) {
      setAddCode("");
      loadFriends();
    }
    setTimeout(() => setMessage(""), 3000);
  };

  const handleRemove = async (code: string) => {
    const result = await herzies.friendRemove(code);
    setMessage(result.message);
    if (result.success) loadFriends();
    setTimeout(() => setMessage(""), 3000);
  };

  if (selectedFriend) {
    return (
      <FriendProfileView
        profile={selectedFriend}
        onBack={() => setSelectedFriend(null)}
        onTrade={() => {
          setSelectedFriend(null);
          onStartTrade(selectedFriend.friendCode);
        }}
        onRemove={async () => {
          await handleRemove(selectedFriend.friendCode);
          setSelectedFriend(null);
        }}
        stageOverride={stageOverride}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 text-ui-lg font-bold text-cyan">
        Friends ({herzie.friendCodes.length}/20)
      </div>

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
        <span className="font-bold text-cyan">{herzie.friendCode}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto h-[100px]">
        {herzie.friendCodes.length === 0 ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            No friends yet. Share your code above!
          </div>
        ) : !friends ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            Loading...
          </div>
        ) : (
          herzie.friendCodes.map((code) => {
            const profile = friends[code];
            return (
              <div
                key={code}
                className="flex items-center justify-between border-b border-[#222] py-1"
              >
                <button
                  type="button"
                  className={cn("text-left", profile ? "cursor-pointer" : "")}
                  onClick={() => profile && setSelectedFriend(profile)}
                >
                  <div className="text-ui text-text">
                    {profile?.name ?? code}
                  </div>
                  <div className="text-[10px] text-text-dim">
                    {profile
                      ? `Lv.${profile.level} · Stage ${profile.stage}`
                      : code}
                  </div>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
