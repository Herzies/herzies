import type { Update } from "@tauri-apps/plugin-updater";
import { useState } from "react";
import { cn } from "../lib/utils";
import {
  type AppState,
  herzies,
  installUpdate,
  type UpdateInstallEvent,
} from "../tauri-bridge";
import { View } from "./View";

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
  const [mediaRemoteDebug, setMediaRemoteDebug] = useState<string | null>(null);
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
    <View title="Settings" colour="cyan" childrenClassName="flex flex-col">
      <div className="mb-4">
        <div className="mb-1.5 text-ui text-text-dim">Account</div>
        {state.isOnline ? (
          <button
            type="button"
            className="btn text-red"
            onClick={() => herzies.logout()}
          >
            Logout
          </button>
        ) : (
          <button
            type="button"
            className="btn text-green"
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

      {import.meta.env.DEV && (
        <div className="mb-4">
          <div className="mb-1.5 text-ui text-text-dim">Debug</div>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className="btn"
              onClick={() => herzies.testNotification()}
            >
              Test Notification
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => herzies.testActivity()}
            >
              Test Activity Log
            </button>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const raw = await herzies.debugMediaRemoteNowPlaying();
                let text: string;
                if (raw === null) {
                  text =
                    "(null — no now playing data from adapter; is music playing?)";
                } else {
                  try {
                    text = JSON.stringify(JSON.parse(raw), null, 2);
                  } catch {
                    text = raw;
                  }
                }
                console.log("[MediaRemote]", raw ?? null);
                setMediaRemoteDebug(text);
              }}
            >
              MediaRemote JSON
            </button>
            <button type="button" className="btn" onClick={onPreviewOnboarding}>
              Preview Onboarding
            </button>
          </div>
          {mediaRemoteDebug !== null && (
            <pre className="mt-2 max-h-40 overflow-auto rounded border border-border bg-[#111] p-2 text-[10px] text-text-dim whitespace-pre-wrap break-all">
              {mediaRemoteDebug}
            </pre>
          )}
        </div>
      )}

      {import.meta.env.DEV && (
        <div className="mb-4">
          <div className="mb-1.5 text-ui text-text-dim">Stage Preview</div>
          <div className="flex gap-1">
            {[null, 1, 2, 3].map((s) => (
              <button
                key={s ?? "default"}
                type="button"
                className={cn(
                  "btn",
                  stageOverride === s
                    ? "border-cyan text-cyan"
                    : "border-[#555] text-text-dim",
                )}
                onClick={() => onStageOverride(s)}
              >
                {s === null ? "Default" : `Stage ${s}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {availableUpdate && (
        <div className="mt-auto mb-4">
          <div className="mb-1.5 text-ui text-text-dim">Update</div>
          <div className="mb-1 text-ui text-green">
            Version {availableUpdate.version} available
          </div>
          {updateStatus.kind === "idle" && (
            <button
              type="button"
              className="btn text-green"
              onClick={handleInstallUpdate}
            >
              Install &amp; restart
            </button>
          )}
          {updateStatus.kind === "installing" && (
            <div className="text-[10px] text-text-dim">
              {updateStatus.total
                ? `Downloading ${Math.round(
                    (updateStatus.downloaded / updateStatus.total) * 100,
                  )}%`
                : "Downloading..."}
            </div>
          )}
          {updateStatus.kind === "error" && (
            <div className="text-[10px] text-red">
              Update failed: {updateStatus.message}
            </div>
          )}
        </div>
      )}

      <div className="mt-auto mb-2">
        <button
          type="button"
          className="btn text-red"
          onClick={() => herzies.quit()}
        >
          Quit Herzies
        </button>
      </div>

      <div className="text-ui text-text-dim">
        Herzies Desktop v{state.version}
      </div>
    </View>
  );
}
