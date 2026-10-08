import type { Update } from "@tauri-apps/plugin-updater";
import { useState } from "react";
import { cn } from "../lib/utils";
import type { AppState } from "../tauri-bridge";
import { herzies } from "../tauri-bridge";
import { Checkbox } from "./Checkbox";
import { View } from "./View";

type UpdateInstallStatus =
  | { kind: "idle" }
  | { kind: "installing"; downloaded: number; total: number | undefined }
  | { kind: "error"; message: string };

export function SettingsView({
  state,
  stageOverride,
  onStageOverride,
  onPreviewOnboarding,
  onPreviewLoading,
  onTestUpdateAlert,
  onTestWhatsNew,
  availableUpdate,
  installStatus,
  onInstallUpdate,
  hasActiveEventOverride,
  debugBossOverride,
  onToggleDebugBoss,
  debugMerchantOverride,
  onToggleDebugMerchant,
  debugTreatTraderOverride,
  onToggleDebugTreatTrader,
  onToggleActiveEventOverride,
  onSpawnDebugDrop,
}: {
  state: AppState;
  stageOverride: number | null;
  onStageOverride: (v: number | null) => void;
  onPreviewOnboarding: () => void;
  onPreviewLoading: () => void;
  onTestUpdateAlert: () => void;
  onTestWhatsNew: () => void;
  availableUpdate: Update | null;
  installStatus: UpdateInstallStatus;
  onInstallUpdate: () => void;
  hasActiveEventOverride: boolean;
  debugBossOverride: boolean;
  onToggleDebugBoss: () => void;
  debugMerchantOverride: boolean;
  onToggleDebugMerchant: () => void;
  debugTreatTraderOverride: boolean;
  onToggleDebugTreatTrader: () => void;
  onToggleActiveEventOverride: () => void;
  /** `diceOnly` narrows the spawned drop to a dice-type item — see the
   * "Spawn Dice Drop" button below. */
  onSpawnDebugDrop: (diceOnly?: boolean) => void;
}) {
  const [loggingIn, setLoggingIn] = useState(false);
  const [mediaRemoteDebug, setMediaRemoteDebug] = useState<string | null>(null);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const shareListening = state.herzie?.shareListening ?? true;

  const shortcuts: { key: string; label: string }[] = [
    { key: "H", label: "Home" },
    { key: "I", label: "Herzie" },
    { key: "T", label: "Town" },
    { key: "F", label: "Social" },
    { key: "S", label: "Settings" },
    { key: "C", label: "Open chat" },
    { key: "Esc", label: "Close chat or dialog" },
  ];

  return (
    <View
      title="Settings"
      colour="cyan"
      childrenClassName="flex min-h-0 flex-col overflow-y-auto"
    >
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
              try {
                await herzies.login();
              } catch {
                // Failures are surfaced on the splash screen.
              } finally {
                setLoggingIn(false);
              }
            }}
          >
            {loggingIn ? "Logging in..." : "Login"}
          </button>
        )}
      </div>

      {state.herzie && (
        <div className="mb-4">
          <div className="mb-1.5 text-ui text-text-dim">Privacy</div>
          <Checkbox
            checked={shareListening}
            disabled={!state.isOnline || savingPrivacy}
            onChange={async (share) => {
              setSavingPrivacy(true);
              setPrivacyError(null);
              try {
                await herzies.setShareListening(share);
              } catch (e) {
                setPrivacyError(String(e));
              } finally {
                setSavingPrivacy(false);
              }
            }}
            className="items-start"
          >
            <span className="min-w-0">
              <span className="block text-ui">
                Share what you're listening to
              </span>
              <span className="block text-ui-sm text-text-dim">
                Turn off to hide what you're listening to right now, and your
                listening history for others. You'll still earn XP, drops, and
                will be able to participate in events.
              </span>
            </span>
          </Checkbox>
          {privacyError && (
            <div className="mt-1 text-[10px] text-red">
              Couldn't save: {privacyError}
            </div>
          )}
        </div>
      )}

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
            <button type="button" className="btn" onClick={onPreviewLoading}>
              Preview Loading
            </button>
            <button type="button" className="btn" onClick={onTestUpdateAlert}>
              Test Update Alert
            </button>
            <button type="button" className="btn" onClick={onTestWhatsNew}>
              Test What's New
            </button>
            <button
              type="button"
              className={cn(
                "btn",
                hasActiveEventOverride
                  ? "border-cyan text-cyan"
                  : "border-[#555] text-text-dim",
              )}
              onClick={onToggleActiveEventOverride}
            >
              {hasActiveEventOverride ? "Orphiez: On" : "Test Orphiez"}
            </button>
            <button
              type="button"
              className={cn(
                "btn",
                debugBossOverride
                  ? "border-red text-red"
                  : "border-[#555] text-text-dim",
              )}
              onClick={onToggleDebugBoss}
            >
              {debugBossOverride ? "Boss Fight: On" : "Test Boss Fight"}
            </button>
            <button
              type="button"
              className={cn(
                "btn",
                debugMerchantOverride
                  ? "border-yellow text-yellow"
                  : "border-[#555] text-text-dim",
              )}
              onClick={onToggleDebugMerchant}
            >
              {debugMerchantOverride ? "George: On" : "Test George"}
            </button>
            <button
              type="button"
              className={cn(
                "btn",
                debugTreatTraderOverride
                  ? "border-red text-red"
                  : "border-[#555] text-text-dim",
              )}
              onClick={onToggleDebugTreatTrader}
            >
              {debugTreatTraderOverride ? "Nandor: On" : "Test Nandor"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => onSpawnDebugDrop()}
            >
              Spawn Item Drop
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => onSpawnDebugDrop(true)}
            >
              Spawn Dice Drop
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

      <div className="mb-4">
        <div className="mb-1.5 text-ui text-text-dim">Keyboard shortcuts</div>
        <div className="flex flex-col gap-0.5">
          {shortcuts.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-ui-sm">
              <kbd className="inline-flex min-w-[18px] justify-center rounded border border-border bg-bg-panel px-1 py-px text-ui-sm text-text">
                {s.key}
              </kbd>
              <span className="text-text-dim">{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {availableUpdate && (
        <div className="mt-auto mb-4">
          <div className="mb-1.5 text-ui text-text-dim">Update</div>
          <div className="mb-1 text-ui text-green">
            Version {availableUpdate.version} available
          </div>
          {installStatus.kind !== "installing" && (
            <button
              type="button"
              className="btn text-green"
              onClick={onInstallUpdate}
            >
              {installStatus.kind === "error"
                ? "Try again"
                : "Install & restart"}
            </button>
          )}
          {installStatus.kind === "installing" && (
            <div className="text-[10px] text-text-dim">
              {installStatus.total
                ? `Downloading ${Math.round(
                    (installStatus.downloaded / installStatus.total) * 100,
                  )}%`
                : "Installing..."}
            </div>
          )}
          {installStatus.kind === "error" && (
            <div className="text-[10px] text-red">
              Update failed: {installStatus.message}
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
