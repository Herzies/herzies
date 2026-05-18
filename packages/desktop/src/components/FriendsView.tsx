import type { Herzie, HerzieProfile } from "@herzies/shared";
import { useCallback, useEffect, useState } from "react";
import { herzies } from "../tauri-bridge";
import { BackButton } from "./BackButton";
import { Herzie3D } from "./Herzie3D";
import { btnStyle, inputStyle } from "./styles";

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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          position: "relative",
          zIndex: 10,
        }}
      >
        <BackButton onClick={onBack} />
        <span style={{ fontSize: 13, fontWeight: "bold", color: "#7dd3fc" }}>
          {profile.name}
        </span>
      </div>

      {profile.appearance && (
        <div
          style={{
            flex: 1,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            minHeight: 0,
          }}
        >
          <Herzie3D
            userId={profile.friendCode}
            stage={stageOverride ?? profile.stage}
          />
        </div>
      )}

      <div
        style={{
          fontSize: 11,
          color: "#aaa",
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span>Level {profile.level}</span>
        <span>Stage {profile.stage}</span>
      </div>

      {profile.topArtists && profile.topArtists.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>
            Top Artists
          </div>
          {profile.topArtists.map((a, i) => (
            <div
              key={a.name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                padding: "2px 0",
                borderBottom: "1px solid #222",
              }}
            >
              <span style={{ color: "#e0e0e0" }}>
                {i + 1}. {a.name}
              </span>
              <span style={{ color: "#666" }}>{a.plays} plays</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        <button style={{ ...btnStyle, color: "#c084fc" }} onClick={onTrade}>
          Trade
        </button>
        {confirmRemove ? (
          <>
            <button
              style={{ ...btnStyle, color: "#f87171" }}
              onClick={onRemove}
            >
              Yes, remove
            </button>
            <button style={btnStyle} onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            style={{ ...btnStyle, color: "#f87171" }}
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          fontSize: 13,
          fontWeight: "bold",
          color: "#7dd3fc",
          marginBottom: 8,
        }}
      >
        Friends ({herzie.friendCodes.length}/20)
      </div>

      {/* Add friend */}
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder="HERZ-XXXX"
          value={addCode}
          onChange={(e) => setAddCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button style={btnStyle} onClick={handleAdd}>
          Add
        </button>
      </div>

      {message && (
        <div
          style={{
            fontSize: 11,
            color: message.includes("!") ? "#4ade80" : "#f87171",
            marginBottom: 6,
          }}
        >
          {message}
        </div>
      )}

      {/* Friend code */}
      <div style={{ fontSize: 10, color: "#666", marginBottom: 8 }}>
        Your code:{" "}
        <span style={{ color: "#7dd3fc", fontWeight: "bold" }}>
          {herzie.friendCode}
        </span>
      </div>

      {/* Friend list */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {herzie.friendCodes.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: "#555",
              textAlign: "center",
              paddingTop: 20,
            }}
          >
            No friends yet. Share your code above!
          </div>
        ) : !friends ? (
          <div
            style={{
              fontSize: 12,
              color: "#555",
              textAlign: "center",
              paddingTop: 20,
            }}
          >
            Loading...
          </div>
        ) : (
          herzie.friendCodes.map((code) => {
            const profile = friends[code];
            return (
              <div
                key={code}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "4px 0",
                  borderBottom: "1px solid #222",
                }}
              >
                <div
                  style={{ cursor: profile ? "pointer" : "default" }}
                  onClick={() => profile && setSelectedFriend(profile)}
                >
                  <div style={{ fontSize: 12, color: "#e0e0e0" }}>
                    {profile?.name ?? code}
                  </div>
                  <div style={{ fontSize: 10, color: "#666" }}>
                    {profile
                      ? `Lv.${profile.level} · Stage ${profile.stage}`
                      : code}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
