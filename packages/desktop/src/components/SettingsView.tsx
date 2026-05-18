import type { Update } from "@tauri-apps/plugin-updater";
import { useState } from "react";
import {
  type AppState,
  herzies,
  installUpdate,
  type UpdateInstallEvent,
} from "../tauri-bridge";
import { btnStyle } from "./styles";

export function SettingsView({
  state,
  stageOverride,
  onStageOverride,
  onPreviewOnboarding,
  availableUpdate,
  onUpdateInstalled,
}: {
  state: AppState;
  stageOverride: number | null;
  onStageOverride: (v: number | null) => void;
  onPreviewOnboarding: () => void;
  availableUpdate: Update | null;
  onUpdateInstalled: () => void;
}) {
  const [loggingIn, setLoggingIn] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<
    | { kind: "idle" }
    | { kind: "installing"; downloaded: number; total: number | undefined }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const handleInstallUpdate = async () => {
    if (!availableUpdate) return;
    setUpdateStatus({ kind: "installing", downloaded: 0, total: undefined });
    try {
      await installUpdate(availableUpdate, (e: UpdateInstallEvent) => {
        if (e.kind === "started") {
          setUpdateStatus({
            kind: "installing",
            downloaded: 0,
            total: e.contentLength,
          });
        } else if (e.kind === "progress") {
          setUpdateStatus({
            kind: "installing",
            downloaded: e.downloaded,
            total: e.total,
          });
        }
      });
      // installUpdate calls relaunch(); we won't actually reach here, but
      // reset state defensively in case it returns instead of relaunching.
      onUpdateInstalled();
      setUpdateStatus({ kind: "idle" });
    } catch (err) {
      setUpdateStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          fontSize: 13,
          fontWeight: "bold",
          color: "#e0e0e0",
          marginBottom: 12,
        }}
      >
        Settings
      </div>

      {/* Account */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>
          Account
        </div>
        {state.isOnline ? (
          <button
            style={{ ...btnStyle, color: "#f87171" }}
            onClick={() => herzies.logout()}
          >
            Logout
          </button>
        ) : (
          <button
            style={{ ...btnStyle, color: "#4ade80" }}
            disabled={loggingIn}
            onClick={async () => {
              setLoggingIn(true);
              await herzies.login();
              setLoggingIn(false);
            }}
          >
            {loggingIn ? "Logging in..." : "Login"}
          </button>
        )}
      </div>

      {/* Debug (dev-only) */}
      {import.meta.env.DEV && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>
            Debug
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <button style={btnStyle} onClick={() => herzies.testNotification()}>
              Test Notification
            </button>
            <button style={btnStyle} onClick={() => herzies.testActivity()}>
              Test Activity Log
            </button>
            <button style={btnStyle} onClick={onPreviewOnboarding}>
              Preview Onboarding
            </button>
          </div>
        </div>
      )}

      {/* Dev-only stage selector */}
      {import.meta.env.DEV && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>
            Stage Preview
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {[null, 1, 2, 3].map((s) => (
              <button
                key={s ?? "default"}
                style={{
                  ...btnStyle,
                  color: stageOverride === s ? "#7dd3fc" : "#888",
                  borderColor: stageOverride === s ? "#7dd3fc" : "#555",
                }}
                onClick={() => onStageOverride(s)}
              >
                {s === null ? "Default" : `Stage ${s}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Update */}
      {availableUpdate && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>
            Update
          </div>
          <div style={{ fontSize: 11, color: "#4ade80", marginBottom: 4 }}>
            Version {availableUpdate.version} available
          </div>
          {updateStatus.kind === "idle" && (
            <button
              style={{ ...btnStyle, color: "#4ade80" }}
              onClick={handleInstallUpdate}
            >
              Install &amp; restart
            </button>
          )}
          {updateStatus.kind === "installing" && (
            <div style={{ fontSize: 10, color: "#888" }}>
              {updateStatus.total
                ? `Downloading ${Math.round(
                    (updateStatus.downloaded / updateStatus.total) * 100,
                  )}%`
                : "Downloading..."}
            </div>
          )}
          {updateStatus.kind === "error" && (
            <div style={{ fontSize: 10, color: "#f87171" }}>
              Update failed: {updateStatus.message}
            </div>
          )}
        </div>
      )}

      {/* Quit */}
      <div style={{ marginTop: "auto", marginBottom: 8 }}>
        <button
          style={{ ...btnStyle, color: "#f87171" }}
          onClick={() => herzies.quit()}
        >
          Quit Herzies
        </button>
      </div>

      {/* Version */}
      <div style={{ fontSize: 11, color: "#555" }}>
        Herzies Desktop v{state.version}
      </div>
    </div>
  );
}
