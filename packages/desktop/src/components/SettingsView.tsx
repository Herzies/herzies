import { CLASS_DEFS, CLASS_IDS, type HerzieClass } from "@herzies/shared";
import type { Update } from "@tauri-apps/plugin-updater";
import { useState } from "react";
import { cn } from "../lib/utils";
import type { AppState } from "../tauri-bridge";
import { herzies } from "../tauri-bridge";
import { Checkbox } from "./Checkbox";
import { TabButton } from "./TabButton";
import { debugDropLoot } from "./town/combat/fight";
import {
  aimSensitivity,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  setAimSensitivity,
} from "./town/combat/sensitivity";
import { setFpsShown, useFpsShown } from "./town/fps";
import {
  defaultPixelSize,
  PIXEL_SIZE_MAX,
  PIXEL_SIZE_MIN,
  setTownPixelSize,
  useTownPixelSize,
} from "./town/pixelSize";
import { goToMap, useTownMap } from "./town/runtime";
import { setSfxMuted, sfxMuted } from "./town/sfx";
import { View } from "./View";

/** Debug > Teleport: straight to a map's spawn, no portal needed. */
const TELEPORTS = [
  ["home", "Home"],
  ["arena", "Training grounds"],
] as const;

/** Debug is for dev builds only. */
const TABS = ["Account", "Controls", "Debug"] as const;
type SettingsTab = (typeof TABS)[number];
const tabs: readonly SettingsTab[] = import.meta.env.DEV
  ? TABS
  : TABS.filter((t) => t !== "Debug");

type UpdateInstallStatus =
  | { kind: "idle" }
  | { kind: "installing"; downloaded: number; total: number | undefined }
  | { kind: "error"; message: string };

export function SettingsView({
  state,
  stageOverride,
  onStageOverride,
  classOverride,
  onClassOverride,
  onTestClassChoice,
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
  /** Dev-only: draws the herzie holding a class's gear, to eyeball it. */
  classOverride: HerzieClass | null;
  onClassOverride: (v: HerzieClass | null) => void;
  /** Dev-only: opens the class choice; choosing in it is real. */
  onTestClassChoice: () => void;
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
  const townMap = useTownMap();
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const [aim, setAim] = useState(aimSensitivity);
  const [townSounds, setTownSounds] = useState(() => !sfxMuted());
  const fpsShown = useFpsShown();
  const pixelSize = useTownPixelSize();
  const [tab, setTab] = useState<SettingsTab>("Account");
  const shareListening = state.herzie?.shareListening ?? true;

  const shortcuts: { key: string; label: string }[] = [
    { key: "H", label: "Home" },
    { key: "I", label: "Deck" },
    { key: "B", label: "Bag" },
    { key: "T", label: "Town" },
    { key: "F", label: "Social" },
    { key: "P", label: "Premium shop" },
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
      <div className="mb-3 flex shrink-0 gap-1 border-b border-border text-ui">
        {tabs.map((t) => (
          <TabButton key={t} active={tab === t} onClick={() => setTab(t)}>
            {t}
          </TabButton>
        ))}
      </div>

      {tab === "Account" && (
        <>
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
                    Turn off to hide what you're listening to right now, and
                    your listening history for others. You'll still earn XP,
                    drops, and will be able to participate in events.
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
        </>
      )}

      {tab === "Controls" && (
        <>
          <div className="mb-4">
            <div className="mb-1.5 text-ui text-text-dim">Aiming</div>
            <label className="flex items-center gap-2 text-ui">
              <span className="shrink-0">Mouse sensitivity</span>
              <input
                type="range"
                min={SENSITIVITY_MIN}
                max={SENSITIVITY_MAX}
                step={0.05}
                value={aim}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setAim(v);
                  setAimSensitivity(v);
                }}
                className="min-w-0 flex-1"
              />
              <span className="w-10 shrink-0 text-right tabular-nums text-text-dim">
                {aim.toFixed(2)}×
              </span>
            </label>
          </div>
          <div className="mb-4">
            <div className="mb-1.5 text-ui text-text-dim">Sound</div>
            <button
              type="button"
              className={cn(
                "btn",
                townSounds
                  ? "border-cyan text-cyan"
                  : "border-[#555] text-text-dim",
              )}
              onClick={() => {
                setSfxMuted(townSounds);
                setTownSounds(!townSounds);
              }}
            >
              {townSounds ? "Town sounds: On" : "Town sounds: Off"}
            </button>
          </div>
          <div className="mb-4">
            <div className="mb-1.5 text-ui text-text-dim">
              Keyboard shortcuts
            </div>
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
        </>
      )}

      {tab === "Debug" && (
        <>
          <div className="mb-4">
            <div className="mb-1.5 text-ui text-text-dim">Town</div>
            <label className="flex items-center gap-2 text-ui">
              <span className="shrink-0">Pixel size</span>
              <input
                type="range"
                min={PIXEL_SIZE_MIN}
                max={PIXEL_SIZE_MAX}
                step={1}
                value={pixelSize ?? defaultPixelSize()}
                onChange={(e) => setTownPixelSize(Number(e.target.value))}
                className="min-w-0 flex-1"
              />
              <span className="w-10 shrink-0 text-right tabular-nums text-text-dim">
                {pixelSize ?? defaultPixelSize()}px
              </span>
              <button
                type="button"
                className="btn"
                disabled={pixelSize === null}
                onClick={() => setTownPixelSize(null)}
              >
                Reset
              </button>
            </label>
            <div className="mt-0.5 text-ui-sm text-text-dim">
              Screen pixels per Town pixel. Unset, the game's own (
              {defaultPixelSize()}px).
            </div>
            <div className="mt-2 flex items-center gap-1 text-ui">
              <span className="mr-1 shrink-0">Teleport</span>
              {TELEPORTS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={cn(
                    "btn",
                    townMap.id === id
                      ? "border-cyan text-cyan"
                      : "border-[#555] text-text-dim",
                  )}
                  onClick={() => goToMap(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
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
                className={cn(
                  "btn",
                  fpsShown
                    ? "border-cyan text-cyan"
                    : "border-[#555] text-text-dim",
                )}
                onClick={() => setFpsShown(!fpsShown)}
              >
                {fpsShown ? "Town FPS: On" : "Town FPS"}
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
              <button
                type="button"
                className="btn"
                onClick={onPreviewOnboarding}
              >
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
                className="btn border-[#555] text-text-dim"
                title="Drops a random item in front of you in the Town (nothing is granted)"
                onClick={debugDropLoot}
              >
                Drop Test Loot
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
          <div className="mb-4">
            <div className="mb-1.5 text-ui text-text-dim">Class Preview</div>
            <div className="flex flex-wrap gap-1">
              {[null, ...CLASS_IDS].map((c) => (
                <button
                  key={c ?? "default"}
                  type="button"
                  className={cn(
                    "btn",
                    classOverride === c
                      ? "border-cyan text-cyan"
                      : "border-[#555] text-text-dim",
                  )}
                  onClick={() => onClassOverride(c)}
                >
                  {c === null ? "Default" : CLASS_DEFS[c].name}
                </button>
              ))}
              <button
                type="button"
                className="btn border-[#555] text-text-dim"
                onClick={onTestClassChoice}
              >
                Class Choice…
              </button>
            </div>
          </div>
        </>
      )}

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
