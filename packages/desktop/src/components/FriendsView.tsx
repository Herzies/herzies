import type { Herzie, HerzieProfile } from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { ProfileView } from "./ProfileView";
import { View } from "./View";

export function FriendsView({
  herzie,
  friends,
  onStartTrade,
  stageOverride,
}: {
  herzie: Herzie;
  friends: Record<string, HerzieProfile>;
  onStartTrade: (code: string) => void;
  stageOverride?: number | null;
}) {
  const [addCode, setAddCode] = useState("");
  const [message, setMessage] = useState("");
  const [selectedFriend, setSelectedFriend] = useState<HerzieProfile | null>(
    null,
  );

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

  const handleAdd = async () => {
    const code = addCode.trim().toUpperCase();
    if (!code) return;
    const result = await herzies.friendAdd(code);
    setMessage(result.message);
    if (result.success) setAddCode("");
    setTimeout(() => setMessage(""), 3000);
  };

  const handleRemove = async (code: string) => {
    const result = await herzies.friendRemove(code);
    setMessage(result.message);
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
        onRemove={async () => {
          await handleRemove(selectedFriend.friendCode);
          setSelectedFriend(null);
        }}
        stageOverride={stageOverride}
      />
    );
  }

  const showLoading =
    herzie.friendCodes.length > 0 &&
    herzie.friendCodes.some((code) => !friends[code]);

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
        <span className="font-bold text-cyan">{herzie.friendCode}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {herzie.friendCodes.length === 0 ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            No friends yet. Share your code above!
          </div>
        ) : (
          herzie.friendCodes.map((code) => {
            const profile = friends[code];
            return (
              <div
                key={code}
                className="flex items-center justify-between border-b border-border last:border-b-0"
              >
                <button
                  type="button"
                  className={cn(
                    "text-left py-2 w-full group",
                    profile ? "cursor-pointer" : "",
                  )}
                  onClick={() => profile && setSelectedFriend(profile)}
                >
                  <div className="text-ui text-text group-hover:text-cyan">
                    {profile?.name ?? code}
                  </div>
                  <div className="text-[10px] text-text-dim">
                    {profile
                      ? `Lv.${profile.level} · Stage ${profile.stage}`
                      : showLoading
                        ? "Loading..."
                        : code}
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
