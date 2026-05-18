import { levelProgress, xpToNextLevel } from "@herzies/shared";
import { useEffect, useState } from "react";
import { type AppState, herzies } from "../tauri-bridge";
import { Herzie3D } from "./Herzie3D";

export function HomeView({
  state,
  stageOverride,
}: {
  state: AppState;
  stageOverride?: number | null;
}) {
  const { herzie, nowPlaying, multipliers, isConnected } = state;
  const [equipped, setEquipped] = useState<string[]>([]);

  useEffect(() => {
    herzies.fetchInventory().then((data) => {
      if (data) setEquipped(data.equipped ?? []);
    });
  }, []);

  if (!herzie) return null;

  const progress = levelProgress(herzie);
  const toNext = xpToNextLevel(herzie);
  const totalHours = (herzie.totalMinutesListened / 60).toFixed(1);
  const activeMultipliers = multipliers ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: "bold", color: "#7dd3fc" }}>
          {herzie.name}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {!isConnected && (
            <span style={{ fontSize: 10, color: "#f87171" }}>
              connect to internet to grow
            </span>
          )}
          <span
            style={{
              fontSize: 10,
              color: isConnected ? "#4ade80" : "#f87171",
              background: isConnected ? "#4ade8020" : "#f8717120",
              padding: "2px 8px",
              borderRadius: 8,
            }}
          >
            {isConnected ? "online" : "offline"}
          </span>
        </div>
      </div>

      {/* Herzie Art — takes up available space */}
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
          userId={herzie.friendCode}
          stage={stageOverride ?? herzie.stage}
          isPlaying={!!nowPlaying}
          wearables={equipped}
        />
      </div>

      {/* Level & XP */}
      <div style={{ marginBottom: 6 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: "#aaa",
            marginBottom: 3,
          }}
        >
          <span>Level {herzie.level}</span>
          <span>Stage {herzie.stage}</span>
        </div>
        <div
          style={{
            display: "flex",
            gap: 2,
            height: 8,
          }}
        >
          {Array.from({ length: 40 }, (_, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                background: i < Math.round(progress * 40) ? "#4ade80" : "#333",
              }}
            />
          ))}
        </div>
        <div
          style={{
            fontSize: 9,
            color: "#555",
            marginTop: 2,
            textAlign: "right",
          }}
        >
          {Math.ceil(toNext)} XP to next
        </div>
      </div>

      {/* Compact stats row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "#888",
          marginBottom: 6,
        }}
      >
        <span>
          <span style={{ color: "#c084fc" }}>{totalHours}h</span> music
        </span>
        <span>
          <span style={{ color: "#facc15" }}>${herzie.currency}</span>
        </span>
        <span>
          <span style={{ color: "#7dd3fc" }}>{herzie.friendCodes.length}</span>{" "}
          friends
        </span>
        {herzie.streakDays > 0 && (
          <span>
            <span style={{ color: "#facc15" }}>{herzie.streakDays}d</span>{" "}
            streak
          </span>
        )}
      </div>

      {/* Bonuses */}
      {!multipliers ? (
        <div style={{ fontSize: 10, color: "#555", marginBottom: 6 }}>
          <span style={{ color: "#facc15" }}>Bonuses:</span> Log in to get
          bonuses
        </div>
      ) : activeMultipliers.length > 0 ? (
        <div style={{ marginBottom: 6 }}>
          {activeMultipliers.map((m) => (
            <div
              key={m.name}
              style={{
                fontSize: 10,
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span style={{ color: "#facc15" }}>★ {m.name}</span>
              <span style={{ color: "#4ade80" }}>
                +{Math.round(m.bonus * 100)}%
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Now Playing */}
      {nowPlaying ? (
        <div style={{ borderTop: "1px solid #333", paddingTop: 6 }}>
          <div style={{ fontSize: 9, color: "#555", marginBottom: 1 }}>
            ♫ Now Playing
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#e0e0e0",
              fontWeight: "bold",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {nowPlaying.title}
          </div>
          <div
            style={{
              fontSize: 10,
              color: "#888",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {nowPlaying.artist}
          </div>
        </div>
      ) : (
        <div style={{ borderTop: "1px solid #333", paddingTop: 6 }}>
          <div style={{ fontSize: 10, color: "#444", textAlign: "center" }}>
            Play some music to start earning XP
          </div>
        </div>
      )}
    </div>
  );
}
